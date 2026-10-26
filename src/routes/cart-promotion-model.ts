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
 *  - `progress`  how far the basket is from the next gift or discount milestone, with a bar.
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

/** One saving the basket has earned, named by the campaign that gave it ("Mua 5 giảm 10%"). */
export type PromotionSavingRow = Readonly<{
  /** The campaign id; stable React key. */
  id: string;
  label: string;
  amountVnd: number;
  /** `amountVnd` as shown. */
  amountText: string;
}>;

export type PromotionBannerView = Readonly<{
  /** Everything the basket saves through cart-level campaigns, whole VND; 0 when none applied. */
  savingsVnd: number;
  /** One row per campaign that saved something, largest first; empty when nothing was saved. */
  savings: readonly PromotionSavingRow[];
  items: readonly PromotionBannerItem[];
}>;

/** What a saving line says when the campaign's own name is unknown (a render built without names). */
const FALLBACK_TIER_LABEL = "Ưu đãi mua nhiều";

/**
 * A paid group (cart) or quote line (checkout). `quantity` is the group's OWN unit count: every unit of a
 * group is identical, so a step's saving is its per-unit drop times that count. A step's own
 * `appliedQuantity` is not used for money because a group split by a later step keeps the earlier steps
 * it inherited with the quantity of the group it was split from.
 */
type StepGroup = Readonly<{
  quantity: number;
  /** What one unit of the group finally costs; read only to reconcile against a baseline. */
  unitPriceVnd?: number;
  steps?: readonly StepLike[];
  discountSteps?: readonly StepLike[];
}>;
type StepLike = Pick<StackStep, "campaignId" | "inputPriceVnd" | "outputPriceVnd"> & Readonly<{ source: StackStep["source"] | "VOUCHER" }>;

/**
 * The per-unit price a group is measured against: the price its line is listed at once only per-product
 * promotions are applied (what the line shows), or `undefined` when the caller has none for the group.
 */
export type SavingBaseline<G extends StepGroup = StepGroup> = (group: G) => number | undefined;

/** `total` split over `weights` in proportion, whole VND, the remainders going to the largest fractions. */
function splitProportionally(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((acc, weight) => acc + weight, 0);
  if (sum === total) return [...weights];
  const bigTotal = BigInt(total);
  const bigSum = BigInt(sum);
  const shares = weights.map((weight) => {
    const exact = bigTotal * BigInt(weight);
    return { floor: exact / bigSum, rest: exact % bigSum };
  });
  let left = total - shares.reduce((acc, share) => acc + Number(share.floor), 0);
  const order = shares.map((_, index) => index).sort((a, b) => (shares[b]!.rest > shares[a]!.rest ? 1 : shares[b]!.rest < shares[a]!.rest ? -1 : a - b));
  const out = shares.map((share) => Number(share.floor));
  for (const index of order) {
    if (left <= 0) break;
    out[index] = out[index]! + 1;
    left -= 1;
  }
  return out;
}

/**
 * VND each quantity-tier campaign saves across a set of paid groups/lines, one row per campaign.
 *
 * Legacy (flash sale / clearance) steps are excluded on purpose: that price is already the price the
 * shopper sees on the line, so counting it again as a cart-level saving would claim a discount the
 * shopper never had to earn. A step that raises the price (malformed input) contributes nothing, and
 * a non-finite total drops that campaign's row rather than print a number nobody was charged.
 *
 * With a `baseline`, the saving is measured against the price the line is LISTED at, not against the
 * step's own input. The two differ when a tier is ordered before a Flash Sale: the tier then takes its
 * amount off the catalog price and the sale takes a percentage of what is left, so the ledger's tier
 * step (100.000 ₫) overstates what the shopper gained over the listed price (90.000 ₫). The group's real
 * gain over its baseline is split across its tier steps in proportion to their ledger amounts, so the
 * rows always add up to listed price minus price paid.
 */
export function tierSavingRows<G extends StepGroup>(
  groups: readonly G[],
  names?: ReadonlyMap<string, string>,
  baseline?: SavingBaseline<G>,
): PromotionSavingRow[] {
  const byCampaign = new Map<string, number>();
  const add = (campaignId: string, amountVnd: number) => byCampaign.set(campaignId, (byCampaign.get(campaignId) ?? 0) + amountVnd);
  for (const group of groups) {
    const raw = new Map<string, number>();
    for (const step of group.steps ?? group.discountSteps ?? []) {
      if (step.source !== "QUANTITY_TIER") continue;
      const perUnit = step.inputPriceVnd - step.outputPriceVnd;
      if (!(perUnit > 0)) continue;
      raw.set(step.campaignId, (raw.get(step.campaignId) ?? 0) + perUnit * group.quantity);
    }
    if (raw.size === 0) continue;

    const listed = baseline?.(group);
    const paid = group.unitPriceVnd;
    if (listed === undefined || paid === undefined) {
      for (const [campaignId, amountVnd] of raw) add(campaignId, amountVnd);
      continue;
    }
    const gain = (listed - paid) * group.quantity;
    if (!Number.isSafeInteger(gain) || gain <= 0) continue;
    const ids = [...raw.keys()].sort();
    const weights = ids.map((id) => raw.get(id)!);
    if (!weights.every((weight) => Number.isSafeInteger(weight))) continue;
    const parts = splitProportionally(gain, weights);
    ids.forEach((id, index) => add(id, parts[index]!));
  }
  const rows: PromotionSavingRow[] = [];
  for (const [campaignId, amountVnd] of byCampaign) {
    if (!Number.isSafeInteger(amountVnd) || amountVnd <= 0) continue;
    const name = names?.get(campaignId)?.trim();
    rows.push(Object.freeze({ id: campaignId, label: name ? name : FALLBACK_TIER_LABEL, amountVnd, amountText: currency.format(amountVnd) }));
  }
  return rows.sort((a, b) => b.amountVnd - a.amountVnd || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

/** The total of {@link tierSavingRows}. */
export function tierSavingsVnd(groups: readonly StepGroup[]): number {
  return tierSavingRows(groups).reduce((sum, row) => sum + row.amountVnd, 0);
}

function tierItem(savings: readonly PromotionSavingRow[]): PromotionBannerItem | null {
  if (savings.length === 0) return null;
  return Object.freeze({
    id: "tier",
    state: "achieved",
    kind: "TIER",
    title: "Đã áp dụng ưu đãi",
    progress: null,
    needsGiftChoice: false,
  });
}

function view(items: readonly PromotionBannerItem[], savings: readonly PromotionSavingRow[]): PromotionBannerView | null {
  if (items.length === 0 && savings.length === 0) return null;
  // Reached conditions read first. Of the bars toward what is not yet reached, only the nearest one
  // is shown: several competing "buy more" nudges is noise, and the nearest is the one worth acting on.
  const nearest = items
    .filter((item) => item.state === "progress")
    .reduce<PromotionBannerItem | null>((best, item) => (best === null || (item.progress?.percent ?? 0) > (best.progress?.percent ?? 0) ? item : best), null);
  return Object.freeze({
    savingsVnd: savings.reduce((sum, row) => sum + row.amountVnd, 0),
    savings: Object.freeze([...savings]),
    items: Object.freeze([...items.filter((item) => item.state === "achieved"), ...(nearest ? [nearest] : [])]),
  });
}

type GiftCampaign = CartGiftState["campaigns"][number];
type GiftSelection = CartGiftState["selections"][number];

/**
 * Gift names in the shopper's words. Two different questions, kept apart because they read differently:
 *  - what is on OFFER for a slot still to be chosen ("A hoặc B"): only gifts that could really be handed
 *    over -- in stock, and, where the campaign refuses a second gift of the same product, not a product
 *    the shopper already picked. Nothing is advertised when no such gift exists;
 *  - what the shopper CHOSE ("A và B"): the picked gifts, as many of them as they asked for.
 * Each product is named once however many colours or sizes it comes in. An empty result means "say the
 * plain word 'quà'" rather than name something that cannot be given.
 */
const GIFT_NAMES_SHOWN = 2;

function nameByVariant(labels: CartGiftState["labels"]): ReadonlyMap<string, string | undefined> {
  return new Map(labels.map((label) => [label.variantId, label.productName?.trim() || undefined]));
}

/** Product names a slot not yet chosen could still take. */
function offeredGiftNames(campaign: GiftCampaign, labels: CartGiftState["labels"], chosen: readonly GiftSelection[]): string[] {
  const names = nameByVariant(labels);
  const chosenProducts = new Set(chosen.flatMap((row) => {
    const productId = campaign.options.find((option) => option.variantId === row.variantId)?.productId;
    return productId === undefined ? [] : [productId];
  }));
  const taken = campaign.allowDuplicateGifts === false ? chosenProducts : new Set<string>();
  const out = new Set<string>();
  for (const option of campaign.options) {
    if (!(option.readyAvailable > 0) || taken.has(option.productId)) continue;
    const name = names.get(option.variantId);
    if (name) out.add(name);
  }
  return [...out];
}

/** "A", "A hoặc B", or "A, B hoặc N quà khác": a choice between gifts. */
function offeredText(list: readonly string[]): string {
  if (list.length <= 1) return list[0] ?? "";
  if (list.length <= GIFT_NAMES_SHOWN) return list.join(" hoặc ");
  return `${list.slice(0, GIFT_NAMES_SHOWN).join(", ")} hoặc ${list.length - GIFT_NAMES_SHOWN} quà khác`;
}

/** "A và B" (with "×2" for a gift taken twice): everything the shopper picked. */
function chosenText(labels: CartGiftState["labels"], chosen: readonly GiftSelection[]): string {
  const names = nameByVariant(labels);
  const byName = new Map<string, number>();
  for (const row of chosen) {
    const name = names.get(row.variantId);
    if (name) byName.set(name, (byName.get(name) ?? 0) + row.quantity);
  }
  const parts = [...byName].map(([name, quantity]) => (quantity > 1 ? `${name} ×${quantity}` : name));
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} và ${parts[parts.length - 1]}`;
}

/** A campaign whose every gift is out of stock can hand nothing over, so it is neither named nor nudged toward. */
function giftsAllOut(campaign: GiftCampaign): boolean {
  return campaign.options.length > 0 && campaign.options.every((option) => !(option.readyAvailable > 0));
}

/**
 * The title of a reached gift slot. A fully chosen set is named ("A và B"); a partly chosen one says how many
 * slots are still open; before any choice the gifts on offer are named, and only when they are real.
 */
function earnedGiftTitle(entitled: number, selected: number, campaign: GiftCampaign | undefined, state: CartGiftState, chosen: readonly GiftSelection[]): string {
  const head = `Nàng nhận được ${entitled} quà tặng`;
  if (!campaign) return head;
  if (selected > 0) {
    const picked = chosenText(state.labels, chosen);
    if (!picked) return head;
    return selected >= entitled ? `${head}: ${picked}` : `${head}: đã chọn ${picked}, còn ${entitled - selected} suất chưa chọn`;
  }
  const offered = offeredGiftNames(campaign, state.labels, chosen);
  if (offered.length === 0) return head;
  // One gift to take is just named; a real choice says so.
  return offered.length === 1 ? `${head}: ${offered[0]}` : `${head}: chọn từ ${offeredText(offered)}`;
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
export function buildCartPromotionView(
  state: CartGiftState | undefined,
  /** The unit price each cart line is listed at (per-product promotions only), by `lineKey`. */
  listedUnitPriceVnd?: ReadonlyMap<string, number>,
): PromotionBannerView | null {
  const benefits = state?.quote.benefits;
  if (!state || !benefits?.enabled || !benefits.ok) return null;

  const savings = tierSavingRows(
    benefits.groups,
    benefits.campaignNames,
    listedUnitPriceVnd ? (group) => listedUnitPriceVnd.get(group.lineKey) : undefined,
  );
  const items: PromotionBannerItem[] = [];
  const tier = tierItem(savings);
  if (tier) items.push(tier);

  const selectedBy = new Map<string, number>();
  for (const row of state.selections) selectedBy.set(row.campaignId, (selectedBy.get(row.campaignId) ?? 0) + row.quantity);

  state.entitlements.forEach((entry, index) => {
    const campaign = state.campaigns.find((candidate) => candidate.id === entry.campaignId);
    if (entry.entitled > 0) {
      const selected = selectedBy.get(entry.campaignId) ?? 0;
      const unclaimed = Math.max(0, entry.entitled - selected);
      const chosen = state.selections.filter((row) => row.campaignId === entry.campaignId);
      items.push(Object.freeze({
        id: `gift-${entry.campaignId}`,
        state: "achieved",
        kind: "GIFT",
        title: earnedGiftTitle(entry.entitled, selected, campaign, state, chosen),
        progress: null,
        needsGiftChoice: unclaimed > 0,
      }));
    }

    const shortfall = entry.shortfallToNext;
    if (!shortfall || !campaign) return;
    // Nothing could be handed over (every gift is out of stock), so a nudge to buy more would promise it.
    if (giftsAllOut(campaign)) return;
    // "để nhận quà tặng Váy lụa": naming the gift is what makes the extra purchase worth it, but only a gift
    // the shopper could really take for the NEW slot (not one the campaign refuses as a duplicate).
    const giftNames = offeredText(offeredGiftNames(campaign, state.labels, state.selections.filter((row) => row.campaignId === entry.campaignId)));
    const reward = `${entry.entitled > 0 ? "thêm " : ""}${giftNames ? `quà tặng ${giftNames}` : "quà"}`;
    if (campaign.trigger === "QUANTITY" && shortfall.quantity && campaign.minimumQuantity) {
      items.push(Object.freeze({
        id: `gift-next-${entry.campaignId || index}`,
        state: "progress",
        kind: "GIFT",
        title: `Mua thêm ${shortfall.quantity} sản phẩm để nhận ${reward}`,
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
        title: `Mua thêm ${currency.format(shortfall.subtotalVnd)} để nhận ${reward}`,
        progress: Object.freeze({
          percent: progressPercent(shortfall.subtotalVnd, Number(campaign.minimumSubtotalVnd)),
          label: `Còn thiếu ${currency.format(shortfall.subtotalVnd)}`,
        }),
        needsGiftChoice: false,
      }));
    }
  });

  for (const progress of benefits.quantityProgress ?? []) {
    const { next } = progress;
    const partial = progress.discountedUnits === "FROM_REACHED_THRESHOLD";
    const off = next.unit === "PERCENTAGE"
      ? `${next.value}%${partial ? " cho sản phẩm được ưu đãi" : ""}`
      : `${currency.format(next.value)}/sản phẩm${partial ? " được ưu đãi" : ""}`;
    items.push(Object.freeze({
      id: `quantity-next-${progress.campaignId}`,
      state: "progress",
      kind: "TIER",
      title: `Mua thêm ${next.shortfallQuantity} sản phẩm áp dụng để được giảm ${off}`,
      progress: Object.freeze({
        percent: progressPercent(next.shortfallQuantity, next.thresholdQuantity - (progress.reachedThresholdQuantity ?? 0)),
        label: `Còn thiếu ${next.shortfallQuantity} sản phẩm áp dụng`,
      }),
      needsGiftChoice: false,
    }));
  }

  // How far the basket is from the next rung of an order-value ladder. The quote only reports a ladder that
  // would genuinely apply, so what is shown here is a promise the checkout will keep.
  for (const progress of benefits.orderValueProgress ?? []) {
    const { next } = progress;
    const base = progress.reachedThresholdVnd ?? 0;
    const off = next.unit === "PERCENTAGE" ? `${next.value}%` : currency.format(next.value);
    items.push(Object.freeze({
      id: `order-next-${progress.campaignId}`,
      state: "progress",
      kind: "TIER",
      title: `Mua thêm ${currency.format(next.shortfallVnd)} để được giảm ${off}`,
      progress: Object.freeze({
        percent: progressPercent(next.shortfallVnd, next.thresholdVnd - base),
        label: `Còn thiếu ${currency.format(next.shortfallVnd)}`,
      }),
      needsGiftChoice: false,
    }));
  }

  return view(items, savings);
}

/** The checkout facts the banner reads: each line's role and discount steps. */
export type CheckoutPromotionFacts = Readonly<{
  lines: readonly Readonly<{
    role: "PAID" | "GIFT";
    quantity: number;
    pancakeVariationId?: string;
    unitPriceVnd?: number;
    discountSteps: readonly StepLike[];
  }>[];
}>;

/**
 * The banner for checkout, from the signed quote's own facts.
 *
 * Only what the order will actually contain is claimed: tier savings from the paid lines' steps and
 * the gift slots the quote includes. There is no "next milestone" here -- checkout is where the
 * basket stops changing, so nudging toward more items would be the wrong place for it.
 */
export function buildCheckoutPromotionView(
  facts: CheckoutPromotionFacts,
  giftQuantity: number,
  names?: ReadonlyMap<string, string>,
  /** The unit price each variation is listed at (per-product promotions only), by Pancake variation id. */
  listedUnitPriceVnd?: ReadonlyMap<string, number>,
): PromotionBannerView | null {
  const savings = tierSavingRows(
    facts.lines.filter((line) => line.role === "PAID"),
    names,
    listedUnitPriceVnd ? (line) => (line.pancakeVariationId === undefined ? undefined : listedUnitPriceVnd.get(line.pancakeVariationId)) : undefined,
  );
  const items: PromotionBannerItem[] = [];
  const tier = tierItem(savings);
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
  return view(items, savings);
}
