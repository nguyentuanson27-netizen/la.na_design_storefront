/**
 * The Flash Sale facts a card on an ordinary listing (collection, category, `/shop`) needs, so it
 * carries the same FLASH SALE tag, countdown and price as the card on `/sale/flash-sale`.
 *
 * Nothing is priced here: the listing's own promotional rule resolves every variant, and this only
 * reads back which campaign won. The membership test mirrors the Flash listing's SQL
 * (`flashSaleEligibility` over purchasable `sale_variant` rows): a purchasable, ready-stock option
 * whose single resolved campaign is a `FLASH_SALE` with a complete, ordered window and a real
 * discount. The representative is the cheapest such option, ties broken by id, exactly as there.
 */

import type { ApplicablePromotionCampaign, PromotionPricingResult } from "./promotion-pricing.ts";
import { buildPromotionalStorefrontPricing } from "./storefront-promotion-projection.ts";
import {
  buildStorefrontVariantOptions,
  type StorefrontProductCapacity,
  type StorefrontVariantFacts,
} from "./storefront-product.ts";

export type StorefrontListingFlashSale = Readonly<{
  representativeVariantId: string;
  basePriceVnd: number;
  effectivePriceVnd: number;
  hasCheaperCurrentVariant: boolean;
  /** Server-relative remaining duration. No browser wall-clock deadline is exposed. */
  remainingMs: number;
}>;

export function resolveStorefrontListingFlashSale({
  variants,
  productCapacity,
  campaignsByVariantId,
  now,
}: Readonly<{
  variants: readonly StorefrontVariantFacts[];
  productCapacity?: StorefrontProductCapacity;
  campaignsByVariantId: ReadonlyMap<string, readonly ApplicablePromotionCampaign[]>;
  now: Date;
}>): StorefrontListingFlashSale | undefined {
  const pricingByVariantId = new Map<string, PromotionPricingResult>();
  const pricingRule = buildPromotionalStorefrontPricing({
    campaignsByVariantId,
    now,
    onResolved: (variantId, pricing) => pricingByVariantId.set(variantId, pricing),
  });
  const options = buildStorefrontVariantOptions(variants, pricingRule, productCapacity);
  // Ready stock only, as the Flash listing's `isPurchasable` requires (`sellableStock > 0`): an
  // `OVERSELL` variant at zero or below is still purchasable, but that listing would not admit it,
  // so it can neither badge the card nor represent its price.
  const forSale = options.filter(
    (option) => option.purchasable && !option.isPreorderSale && option.sellableStock > 0,
  );

  let representative: Readonly<{ id: string; base: number; effective: number; endsAt: Date }> | null =
    null;
  for (const option of forSale) {
    const pricing = pricingByVariantId.get(option.id);
    const promotion = pricing?.promotion;
    if (
      !pricing?.isDiscounted
      || promotion?.kind !== "FLASH_SALE"
      || promotion.startsAt === null
      || promotion.endsAt === null
      || promotion.endsAt.getTime() <= promotion.startsAt.getTime()
      || pricing.basePriceVnd === null
      || pricing.effectivePriceVnd === null
      || pricing.effectivePriceVnd >= pricing.basePriceVnd
    ) {
      continue;
    }
    const candidate = {
      id: option.id,
      base: pricing.basePriceVnd,
      effective: pricing.effectivePriceVnd,
      endsAt: promotion.endsAt,
    };
    if (
      representative === null
      || candidate.effective < representative.effective
      || (candidate.effective === representative.effective && candidate.id < representative.id)
    ) {
      representative = candidate;
    }
  }
  if (representative === null) return undefined;

  const cheapest = representative.effective;
  return Object.freeze({
    representativeVariantId: representative.id,
    basePriceVnd: representative.base,
    effectivePriceVnd: cheapest,
    hasCheaperCurrentVariant: forSale.some(
      (option) => option.price !== null && option.price < cheapest,
    ),
    remainingMs: Math.max(0, representative.endsAt.getTime() - now.getTime()),
  });
}

/** Attaches each product's Flash presentation, read against the campaigns its listing already holds. */
export function withListingFlashSale<
  P extends Readonly<{
    variants: readonly StorefrontVariantFacts[];
    productCapacity?: StorefrontProductCapacity;
  }>,
>(
  products: readonly P[],
  campaignsByVariantId: ReadonlyMap<string, readonly ApplicablePromotionCampaign[]>,
  now: Date,
): (P & { flashSale: StorefrontListingFlashSale | undefined })[] {
  return products.map((product) => ({
    ...product,
    flashSale: resolveStorefrontListingFlashSale({
      variants: product.variants,
      productCapacity: product.productCapacity,
      campaignsByVariantId,
      now,
    }),
  }));
}
