/**
 * The gift / quantity-tier campaigns a product page may name (UX-02: "khuyến mại hỗ trợ quyết
 * định, không lấn CTA mua").
 *
 * The cart and checkout learn about these campaigns from the server quote; until now the product
 * page did not mention them at all, so a shopper only discovered "Mua 2 giảm 10%" after adding. This
 * read names the campaigns that cover this product, and nothing more: no amount, no threshold
 * maths, no claim that the shopper qualifies. The quote in the cart stays the only place a benefit
 * is computed.
 *
 * It fails closed on every axis, because a promotion shown and then refused is the false promise
 * UX-03 forbids:
 *   - the gift/quantity feature gate is off, or the POS shop has no line-level pricing evidence
 *     (the same condition under which checkout would refuse a benefit order) -> nothing;
 *   - the campaign's scope does not resolve this product (exclude wins, unfrozen Fixed matches none);
 *   - a tier campaign whose ladder does not validate, or a gift campaign with no gift to give;
 *   - any read error -> nothing, and the page renders as it did before
 *     (`product-promotion-offers-runtime.ts`, which owns the database read).
 */

import { isGiftQuantityPromotionsEnabled } from "./gift-quantity-gate.ts";
import type { ActiveGiftQuantityCampaign } from "./gift-quantity-candidate-repository.ts";
import { buildScopeResolver, type ScopeProductFacts } from "./gift-quantity-scope.ts";
import { validateTierConfig } from "./gift-quantity-tier.ts";
import { readLineLevelPricingVerifiedShopIds } from "./pancake-line-level-contract.ts";

/** At most this many are named; the page is about the product, not the promotions. */
export const MAX_PRODUCT_PROMOTION_OFFERS = 2;

export type ProductPromotionOffer = Readonly<{
  /** The campaign id; a stable React key. */
  id: string;
  kind: "GIFT" | "TIER";
  /** The campaign's own name, the same words the cart's savings rows use ("Mua 5 giảm 10%"). */
  label: string;
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

/** The active campaigns that cover this product and can be honoured, in stack order. */
export function selectProductPromotionOffers(
  campaigns: readonly ActiveGiftQuantityCampaign[],
  product: ScopeProductFacts,
): readonly ProductPromotionOffer[] {
  const offers: ProductPromotionOffer[] = [];
  for (const { campaign, scope, frozen } of campaigns) {
    if (!buildScopeResolver(scope, frozen)(product)) continue;
    const label = campaign.name.trim();
    if (label === "") continue;
    if (campaign.kind === "GIFT_ITEM") {
      if (campaign.giftOptions.length === 0) continue;
      offers.push({ id: campaign.id, kind: "GIFT", label });
    } else {
      if (campaign.tierUnit === null || campaign.tierDiscountedUnits === null) continue;
      const issues = validateTierConfig({
        basis: campaign.tierBasis ?? "QUANTITY",
        unit: campaign.tierUnit,
        discountedUnits: campaign.tierDiscountedUnits,
        selectionPriority: campaign.tierSelectionPriority,
        tiers: campaign.tiers,
      });
      if (issues.length > 0) continue;
      offers.push({ id: campaign.id, kind: "TIER", label });
    }
    if (offers.length === MAX_PRODUCT_PROMOTION_OFFERS) break;
  }
  return Object.freeze(offers);
}
