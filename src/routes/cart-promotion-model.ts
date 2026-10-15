import type { CartGiftState } from "../commerce/cart-gift-selection.ts";
import type { StackStep } from "../commerce/gift-quantity-stack.ts";

/**
 * What the cart drawer, the cart page and checkout say about the promotions a basket has reached.
 *
 * One pure builder per surface, one shape out: the shopper sees the same banner everywhere, and no
 * surface does promotion arithmetic of its own. Every number here is a fact the server quote already
 * decided (a paid group's discount steps, an entitlement, a shortfall) -- this file only words them.
 * It reads nothing, so it loads without a database and is safe on both sides of the client boundary.
 *
 * Two states, in this order on screen:
 *  - `achieved`  a condition the basket already meets (a quantity-tier price, gift slots earned);
 *  - `progress`  how far the basket is from the next gift slot, with a bar.
 */

const currency = new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 });

export type PromotionBannerItem = Readonly<{
  /** Stable React key. */
  id: string;
  state: "achieved" | "progress";
  kind: "TIER" | "GIFT";
  title: string;
  /** Present for `progress` items only: how close the basket is to the next slot. */
  progress: Readonly<{ percent: number; label: string }> | null;
  /** Gift slots still waiting for a choice; the cart page offers the picker for these. */
  needsGiftChoice: boolean;
}>;

export type PromotionBannerView = Readonly<{
  /** What the basket saves through quantity tiers, whole VND; 0 when none applied. */
  savingsVnd: number;
  /** `savingsVnd` as shown, or `null` when nothing was saved. */
  savingsText: string | null;
  items: readonly PromotionBannerItem[];
}>;

type DiscountStepLike = Pick<StackStep, "source" | "inputPriceVnd" | "outputPriceVnd" | "appliedQuantity">;

/**
 * VND a set of paid groups/lines saves through quantity-tier steps only.
 *
 * Legacy (flash sale / clearance) steps are excluded on purpose: that price is already the price the
 * shopper sees on the line, so counting it again as "savings from a tier" would claim a discount the
 * shopper never had to earn. A step that raises the price (malformed input) contributes nothing, and
 * a non-finite total gives up rather than print a number nobody was charged.
 */
export function tierSavingsVnd(groups: readonly Readonly<{ steps?: readonly DiscountStepLike[]; discountSteps?: readonly DiscountStepLike[] }>[]): number {
  let total = 0;
  for (const group of groups) {
    for (const step of group.steps ?? group.discountSteps ?? []) {
      if (step.source !== "QUANTITY_TIER") continue;
      const perUnit = step.inputPriceVnd - step.outputPriceVnd;
      if (!(perUnit > 0)) continue;
      total += perUnit * step.appliedQuantity;
      if (!Number.isSafeInteger(total)) return 0;
    }
  }
  return total;
}

function tierItem(savingsVnd: number): PromotionBannerItem | null {
  if (savingsVnd <= 0) return null;
  return Object.freeze({
    id: "tier",
    state: "achieved",
    kind: "TIER",
    title: "Đã áp dụng ưu đãi mua nhiều",
    progress: null,
    needsGiftChoice: false,
  });
}

function view(items: readonly PromotionBannerItem[], savingsVnd: number): PromotionBannerView | null {
  if (items.length === 0 && savingsVnd <= 0) return null;
  // Reached conditions read first. Of the bars toward what is not yet reached, only the nearest one
  // is shown: several competing "buy more" nudges is noise, and the nearest is the one worth acting on.
  const nearest = items
    .filter((item) => item.state === "progress")
    .reduce<PromotionBannerItem | null>((best, item) => (best === null || (item.progress?.percent ?? 0) > (best.progress?.percent ?? 0) ? item : best), null);
  return Object.freeze({
    savingsVnd,
    savingsText: savingsVnd > 0 ? currency.format(savingsVnd) : null,
    items: Object.freeze([...items.filter((item) => item.state === "achieved"), ...(nearest ? [nearest] : [])]),
  });
}

/** `percent` of the way from the last slot to the next, never 0 on a partial step or 100 before it is earned. */
function progressPercent(shortfall: number, target: number): number {
  if (!(target > 0) || !(shortfall >= 0)) return 0;
  const done = Math.round(((target - shortfall) / target) * 100);
  return Math.min(99, Math.max(0, done));
}

/**
 * The banner for the cart page and drawer, from the same gift state the cart already holds.
 *
 * `null` when the basket has reached nothing and is on the way to nothing -- the surface then renders
 * no banner at all rather than an empty frame.
 */
export function buildCartPromotionView(state: CartGiftState | undefined): PromotionBannerView | null {
  const benefits = state?.quote.benefits;
  if (!state || !benefits?.enabled || !benefits.ok) return null;

  const savingsVnd = tierSavingsVnd(benefits.groups);
  const items: PromotionBannerItem[] = [];
  const tier = tierItem(savingsVnd);
  if (tier) items.push(tier);

  const selectedBy = new Map<string, number>();
  for (const row of state.selections) selectedBy.set(row.campaignId, (selectedBy.get(row.campaignId) ?? 0) + row.quantity);

  state.entitlements.forEach((entry, index) => {
    const campaign = state.campaigns.find((candidate) => candidate.id === entry.campaignId);
    if (entry.entitled > 0) {
      const selected = selectedBy.get(entry.campaignId) ?? 0;
      const unclaimed = Math.max(0, entry.entitled - selected);
      items.push(Object.freeze({
        id: `gift-${entry.campaignId}`,
        state: "achieved",
        kind: "GIFT",
        title: entry.entitled === 1 ? "Bạn nhận được 1 quà tặng" : `Bạn nhận được ${entry.entitled} quà tặng`,
        progress: null,
        needsGiftChoice: unclaimed > 0,
      }));
    }

    const shortfall = entry.shortfallToNext;
    if (!shortfall || !campaign) return;
    const more = entry.entitled > 0 ? "thêm " : "";
    if (campaign.trigger === "QUANTITY" && shortfall.quantity && campaign.minimumQuantity) {
      items.push(Object.freeze({
        id: `gift-next-${entry.campaignId || index}`,
        state: "progress",
        kind: "GIFT",
        title: `Mua thêm ${shortfall.quantity} sản phẩm để nhận ${more}quà`,
        progress: Object.freeze({
          percent: progressPercent(shortfall.quantity, campaign.minimumQuantity),
          label: `Còn thiếu ${shortfall.quantity} sản phẩm`,
        }),
        needsGiftChoice: false,
      }));
    } else if (campaign.trigger !== "QUANTITY" && shortfall.subtotalVnd && campaign.minimumSubtotalVnd !== null) {
      items.push(Object.freeze({
        id: `gift-next-${entry.campaignId || index}`,
        state: "progress",
        kind: "GIFT",
        title: `Mua thêm ${currency.format(shortfall.subtotalVnd)} để nhận ${more}quà`,
        progress: Object.freeze({
          percent: progressPercent(shortfall.subtotalVnd, Number(campaign.minimumSubtotalVnd)),
          label: `Còn thiếu ${currency.format(shortfall.subtotalVnd)}`,
        }),
        needsGiftChoice: false,
      }));
    }
  });

  return view(items, savingsVnd);
}

/** The checkout facts the banner reads: each line's role and discount steps. */
export type CheckoutPromotionFacts = Readonly<{
  lines: readonly Readonly<{ role: "PAID" | "GIFT"; discountSteps: readonly DiscountStepLike[] }>[];
}>;

/**
 * The banner for checkout, from the signed quote's own facts.
 *
 * Only what the order will actually contain is claimed: tier savings from the paid lines' steps and
 * the gift slots the quote includes. There is no "next milestone" here -- checkout is where the
 * basket stops changing, so nudging toward more items would be the wrong place for it.
 */
export function buildCheckoutPromotionView(facts: CheckoutPromotionFacts, giftQuantity: number): PromotionBannerView | null {
  const savingsVnd = tierSavingsVnd(facts.lines.filter((line) => line.role === "PAID"));
  const items: PromotionBannerItem[] = [];
  const tier = tierItem(savingsVnd);
  if (tier) items.push(tier);
  if (giftQuantity > 0) {
    items.push(Object.freeze({
      id: "gift",
      state: "achieved",
      kind: "GIFT",
      title: `Đơn hàng được tặng ${giftQuantity} quà`,
      progress: null,
      needsGiftChoice: false,
    }));
  }
  return view(items, savingsVnd);
}
