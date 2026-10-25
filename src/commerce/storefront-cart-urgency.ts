/**
 * The Flash Sale countdown and "Còn x" a cart line carries, decided by the product page's own rules.
 *
 * Nothing is priced or counted here that the PDP does not already decide: a line's countdown is its
 * variant's entry in `resolveStorefrontFlashSaleRemainingByVariantId` (a ready-stock option whose
 * winning campaign is a `FLASH_SALE` with a real discount and a complete window), and its "Còn x" is
 * its entry in `resolveLowStockByVariantId` (STANDARD products only, fewer than `LOW_STOCK_LIMIT`
 * ready pieces). A line no rule speaks for is absent, so the cart shows nothing rather than a guess.
 *
 * Kept apart from `StorefrontCartLine` on purpose: checkout, the order snapshot and analytics read
 * that shape, and a countdown is presentation, not money.
 */

import type { ApplicablePromotionCampaign } from "./promotion-pricing.ts";
import { cartProductCapacity, isCommerceEligibleVariant, type StorefrontCartItem, type StorefrontCartProduct } from "./storefront-cart.ts";
import { resolveStorefrontFlashSaleRemainingByVariantId } from "./storefront-listing-flash-sale.ts";
import { resolveLowStockByVariantId } from "./storefront-low-stock.ts";
import { buildStorefrontVariantOptions } from "./storefront-product.ts";
import { buildPromotionalStorefrontPricing } from "./storefront-promotion-projection.ts";

export type CartLineUrgencyFacts = Readonly<{
  /** Server-relative time left on the Flash Sale pricing this line; absent when none does. */
  flashRemainingMs?: number;
  /** Ready pieces left of this variant, when that number is small and true; absent otherwise. */
  lowStock?: number;
}>;

/** Keyed by cart line variant id; a line with nothing to say is absent. */
export type CartLineUrgency = Readonly<Record<string, CartLineUrgencyFacts>>;

export function buildCartLineUrgency(
  input: Readonly<{
    items: readonly Pick<StorefrontCartItem, "variantId">[];
    products: readonly StorefrontCartProduct[];
    campaignsByVariantId: ReadonlyMap<string, readonly ApplicablePromotionCampaign[]>;
    now: Date;
  }>,
): CartLineUrgency {
  const wanted = new Set(input.items.map((item) => item.variantId));
  const pricingRule = buildPromotionalStorefrontPricing({ campaignsByVariantId: input.campaignsByVariantId, now: input.now });
  const urgency: Record<string, CartLineUrgencyFacts> = {};

  for (const product of input.products) {
    if (!product.variants.some((variant) => wanted.has(variant.id))) continue;
    const productCapacity = cartProductCapacity(product);
    // The same eligible variants the cart priced the line from.
    const variants = product.variants.filter((variant) => isCommerceEligibleVariant(product, variant));
    const flash = resolveStorefrontFlashSaleRemainingByVariantId({
      variants,
      productCapacity,
      campaignsByVariantId: input.campaignsByVariantId,
      now: input.now,
    });
    const low = resolveLowStockByVariantId(buildStorefrontVariantOptions(variants, pricingRule, productCapacity), productCapacity);

    for (const variant of variants) {
      if (!wanted.has(variant.id)) continue;
      const flashRemainingMs = flash[variant.id];
      const lowStock = low[variant.id];
      if ((flashRemainingMs === undefined || flashRemainingMs <= 0) && lowStock === undefined) continue;
      urgency[variant.id] = Object.freeze({
        ...(flashRemainingMs !== undefined && flashRemainingMs > 0 ? { flashRemainingMs } : {}),
        ...(lowStock !== undefined ? { lowStock } : {}),
      });
    }
  }
  return Object.freeze(urgency);
}
