/**
 * The gift / quantity-tier campaigns a product page may name (UX-02: "khuyến mại hỗ trợ quyết
 * định, không lấn CTA mua").
 *
 * The cart and checkout learn about these campaigns from the server quote; until now the product
 * page did not mention them at all, so a shopper only discovered "Mua 2 giảm 10%" after adding. This
 * read names the campaigns that cover this product, and nothing more: no amount, no threshold
 * maths, no claim that the shopper qualifies. The quote in the cart stays the only place a benefit
 * is computed, and each line says how its benefit actually arrives -- a tier discount is computed in
 * the cart once the basket qualifies, a gift is *chosen* there by the shopper -- so the copy never
 * promises a gift that lands in the order on its own.
 *
 * It fails closed on every axis, because a promotion shown and then refused is the false promise
 * UX-03 forbids:
 *   - the gift/quantity feature gate is off, or the POS shop has no line-level pricing evidence
 *     (the same condition under which checkout would refuse a benefit order) -> nothing;
 *   - the campaign's scope does not resolve this product (exclude wins, unfrozen Fixed matches none);
 *   - a tier campaign with no unit or no rung (a ladder is validated where it is published; this
 *     page deliberately never imports the tier engine, which only the cart may price with);
 *   - a gift campaign none of whose gifts can be granted today: the cart's entitlement only offers
 *     standalone gift variants with READY stock (`gift-quantity-entitlement.ts`), and so does this
 *     page (`isReadyGiftOption`), or it would advertise a gift the cart then reports as gone;
 *   - any read error -> nothing, and the page renders as it did before
 *     (`product-promotion-offers-runtime.ts`, which owns the database read).
 */

import { isGiftQuantityPromotionsEnabled } from "./gift-quantity-gate.ts";
import type { ActiveGiftQuantityCampaign } from "./gift-quantity-candidate-repository.ts";
import { buildScopeResolver, type ScopeProductFacts } from "./gift-quantity-scope.ts";
import { readLineLevelPricingVerifiedShopIds } from "./pancake-line-level-contract.ts";

/** At most this many are named; the page is about the product, not the promotions. */
export const MAX_PRODUCT_PROMOTION_OFFERS = 2;

/**
 * How each kind of benefit reaches the order, said beside its name. A gift is never "applied": the
 * qualifying basket opens a choice in the cart, which the shopper still has to make.
 */
export const PRODUCT_PROMOTION_OFFER_NOTES = {
  TIER: "giảm giá tự tính trong giỏ hàng khi đủ điều kiện",
  GIFT: "đủ điều kiện sẽ được chọn quà trong giỏ hàng, tùy quà còn hàng",
} as const;

export type ProductPromotionOffer = Readonly<{
  /** The campaign id; a stable React key. */
  id: string;
  kind: "GIFT" | "TIER";
  /** The campaign's own name, the same words the cart's savings rows use ("Mua 5 giảm 10%"). */
  label: string;
  /** How this kind of benefit reaches the order (`PRODUCT_PROMOTION_OFFER_NOTES`). */
  note: string;
}>;

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Whether the page may name a benefit at all: the feature is on, and the POS shop has the
 * line-level pricing evidence without which checkout refuses a benefit order.
 */
export function areProductPromotionOffersOpen(env: Env = process.env): boolean {
  if (!isGiftQuantityPromotionsEnabled(env)) return false;
  const raw = env.PANCAKE_SHOP_ID?.trim();
  if (!raw || !/^[1-9][0-9]{0,14}$/.test(raw)) return false;
  return readLineLevelPricingVerifiedShopIds(env).includes(Number(raw));
}

/**
 * Whether one gift variant could be granted today, by the cart's own rule: a live, standalone
 * variant (a set cannot be a gift) with at least one READY unit once advisory holds are taken off.
 * Preorder or oversell capacity never authorizes a gift.
 */
export function isReadyGiftOption(
  option: Readonly<{ active: boolean; composite: boolean; stock: number; held: number }>,
): boolean {
  if (!option.active || option.composite) return false;
  const ready = option.stock - option.held;
  return Number.isSafeInteger(ready) && ready >= 1;
}

/**
 * The campaigns whose scope resolves this product. The runtime narrows to these before it reads
 * any gift stock, so a product no gift campaign covers costs no stock or hold query at all.
 */
export function campaignsCoveringProduct(
  campaigns: readonly ActiveGiftQuantityCampaign[],
  product: ScopeProductFacts,
): readonly ActiveGiftQuantityCampaign[] {
  return campaigns.filter(({ scope, frozen }) => buildScopeResolver(scope, frozen)(product));
}

/** The gift variants a campaign set names, so the runtime reads stock only for those. */
export function giftOptionVariantIds(campaigns: readonly ActiveGiftQuantityCampaign[]): readonly string[] {
  return [
    ...new Set(
      campaigns
        .filter(({ campaign }) => campaign.kind === "GIFT_ITEM")
        .flatMap(({ campaign }) => campaign.giftOptions.map((option) => option.variantId)),
    ),
  ];
}

/** The active campaigns that cover this product and can be honoured, in stack order. */
export function selectProductPromotionOffers(
  campaigns: readonly ActiveGiftQuantityCampaign[],
  product: ScopeProductFacts,
  /** Gift variants that pass `isReadyGiftOption`; a gift campaign needs at least one of them. */
  readyGiftVariantIds: ReadonlySet<string>,
): readonly ProductPromotionOffer[] {
  const offers: ProductPromotionOffer[] = [];
  for (const { campaign, scope, frozen } of campaigns) {
    if (!buildScopeResolver(scope, frozen)(product)) continue;
    const label = campaign.name.trim();
    if (label === "") continue;
    if (campaign.kind === "GIFT_ITEM") {
      if (!campaign.giftOptions.some((option) => readyGiftVariantIds.has(option.variantId))) continue;
      offers.push({ id: campaign.id, kind: "GIFT", label, note: PRODUCT_PROMOTION_OFFER_NOTES.GIFT });
    } else {
      if (campaign.tierUnit === null || campaign.tierDiscountedUnits === null) continue;
      if (campaign.tiers.length === 0) continue;
      offers.push({ id: campaign.id, kind: "TIER", label, note: PRODUCT_PROMOTION_OFFER_NOTES.TIER });
    }
    if (offers.length === MAX_PRODUCT_PROMOTION_OFFERS) break;
  }
  return Object.freeze(offers);
}
