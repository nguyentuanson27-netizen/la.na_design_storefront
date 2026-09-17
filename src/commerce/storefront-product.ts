import {
  DEFAULT_NEGATIVE_STOCK_LIMIT,
  resolveVariantSellability,
  type SellingMode,
} from "./capacity-policy.ts";

export type StorefrontVariantFacts = {
  /** Internal mutation/authorization identity. Never a vendor-facing external id. */
  id: string;
  /** The external variation identity a selected or committed option refers to. */
  pancakeVariationId: string;
  color: string | null;
  size: string | null;
  sellableStock: number;
  retailPrice: number | null;
  retailPriceAfterDiscount: number | null;
};

/**
 * Whether this variant's mirrored inventory says anything a machine may publish.
 *
 * The sum below is the shopper's answer and stays exactly as it was: a malformed row is absorbed
 * into ordinary arithmetic, and the page keeps selling what it has always sold. This is the separate
 * question of whether the catalog can *state* an availability to a vendor, and it is decided per row
 * rather than on the total, because the total hides the defect — `[5, -3]` is an unusable pair of
 * rows that adds up to a perfectly ordinary 2.
 *
 * The rule matches M1's mirrored-stock aggregation (`merchant-offer-repository`), deliberately and
 * by value rather than by import: the Merchant feed and this catalog read are independent consumers
 * of the same mirror, and making one call into the other would couple two downstream publishers
 * that are meant to converge on upstream facts. `docs/audits/merchant-jsonld-parity.md` records the
 * pairing, and `tests/domain/merchant-structured-data-parity.test.ts` proves the two agree.
 */
export function resolveVariantAvailabilityFromWarehouseStocks(
  stocks: readonly { quantity: number }[],
): boolean {
  return stocks.every((stock) => Number.isFinite(stock.quantity) && stock.quantity >= 0);
}

export type StorefrontVariantUnavailableReason =
  | "MAPPING_REQUIRED"
  | "AMBIGUOUS_OPTION"
  | "OUT_OF_STOCK"
  | "PRICE_UNRESOLVED";

export type StorefrontVariantOption = StorefrontVariantFacts & {
  color: string | null;
  size: string | null;
  price: number | null;
  /**
   * The undiscounted base price behind `price`, when a promotion-aware pricing rule supplied one.
   * `null` under the default rule, which has no notion of a promotion.
   */
  basePriceVnd: number | null;
  isDiscounted: boolean;
  purchasable: boolean;
  /**
   * Master spec §30. True only for a `PREORDER` variant that is purchasable but out of ready stock,
   * so a surface can render `Đặt trước` without re-deriving the rule — and never for a variant the
   * shopper cannot buy.
   */
  isPreorderSale: boolean;
  unavailableReason: StorefrontVariantUnavailableReason | null;
};

/**
 * What a pricing rule decides for one variant.
 *
 * `price` is the money the shopper pays and the only value the selection model uses. `basePriceVnd`
 * and `isDiscounted` are presentation facts that let a surface strike through the old price without
 * recomputing anything.
 */
export type StorefrontResolvedPrice = Readonly<{
  price: number | null;
  basePriceVnd: number | null;
  isDiscounted: boolean;
}>;

/**
 * A per-variant pricing rule.
 *
 * Injected rather than branched on so that switching one surface to promotional pricing cannot
 * change any other. The default is the shared equality-gated rule below; U15 passes a
 * promotion-aware rule for the product page only.
 */
export type StorefrontPricingRule = (variant: StorefrontVariantFacts) => StorefrontResolvedPrice;

export type StorefrontSelectableOption = Pick<
  StorefrontVariantOption,
  | "id"
  | "pancakeVariationId"
  | "color"
  | "size"
  | "price"
  | "basePriceVnd"
  | "isDiscounted"
  | "purchasable"
  | "unavailableReason"
>;

type StorefrontPriceFacts = Pick<
  StorefrontVariantFacts,
  "retailPrice" | "retailPriceAfterDiscount"
>;

function normalizeOptionValue(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * How this model compares two option values for identity.
 *
 * Case is not part of what distinguishes one option from another: a catalog row spelled `Đen` and
 * one spelled `đen` name the same colour, and the ambiguity check below already treats them as one.
 * Exported so a consumer asking "do these variants actually differ on this dimension?" — U27's
 * `variesBy` — answers it the same way, instead of growing a second, quietly stricter rule.
 */
export function toOptionIdentityKey(value: string): string {
  return value.toLowerCase();
}

function optionKey(color: string | null, size: string, hasColorDimension: boolean): string {
  return hasColorDimension
    ? `${color === null ? "" : toOptionIdentityKey(color)}\u0000${toOptionIdentityKey(size)}`
    : toOptionIdentityKey(size);
}

function isUsablePrice(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}

/**
 * The current storefront price gate, still equality-gated on the mirrored Pancake fields.
 *
 * `src/commerce/promotion-pricing.ts` is the central effective-price authority this will defer to.
 * The switch is deliberately not made here: removing the
 * `retailPrice === retailPriceAfterDiscount` availability gate requires the approved real-catalog
 * evidence W3 demands, and doing it early would change what buyers are charged on the strength of
 * an assumption. Do not add a third price path in the meantime.
 */
export function resolveStorefrontPrice({
  retailPrice,
  retailPriceAfterDiscount,
}: StorefrontPriceFacts): number | null {
  if (!isUsablePrice(retailPrice) || !isUsablePrice(retailPriceAfterDiscount)) {
    return null;
  }

  return retailPrice === retailPriceAfterDiscount ? retailPrice : null;
}

/**
 * The default pricing rule: the shared equality-gated behaviour, with no promotion concept.
 *
 * Every consumer that has not been switched deliberately — cart, checkout, Pancake submission,
 * Merchant audit, product cards, structured data — still resolves through this.
 */
export const defaultStorefrontPricingRule: StorefrontPricingRule = (variant) =>
  Object.freeze({
    price: resolveStorefrontPrice(variant),
    basePriceVnd: null,
    isDiscounted: false,
  });

export function getStorefrontResolvedPriceRange(
  options: readonly Pick<StorefrontVariantOption, "price">[],
): { minimum: number; maximum: number } | null {
  let minimum: number | null = null;
  let maximum: number | null = null;

  for (const option of options) {
    if (option.price === null) continue;
    minimum = minimum === null ? option.price : Math.min(minimum, option.price);
    maximum = maximum === null ? option.price : Math.max(maximum, option.price);
  }

  return minimum === null || maximum === null ? null : { minimum, maximum };
}

export function toStorefrontSelectableOptions(
  options: readonly StorefrontVariantOption[],
): StorefrontSelectableOption[] {
  return options.map((
    {
      id, pancakeVariationId, color, size, price, basePriceVnd, isDiscounted,
      purchasable, isPreorderSale, unavailableReason,
    },
  ) => ({
    id,
    pancakeVariationId,
    color,
    size,
    price,
    basePriceVnd,
    isDiscounted,
    purchasable,
    isPreorderSale,
    unavailableReason,
  }));
}

/**
 * The product's selling policy, as `resolveSellingPolicy()` returns it.
 *
 * Optional, and its default is the approved missing-row answer — `STANDARD` floored at 0 — so every
 * caller that has not been switched keeps exactly today's behaviour. That is what makes I1's
 * no-backfill safe here too: a product with no policy row sells precisely as it did before.
 */
export type StorefrontSellingPolicy = Readonly<{
  sellingMode: SellingMode;
  negativeStockLimit: number;
}>;

const STANDARD_SELLING_POLICY: StorefrontSellingPolicy = Object.freeze({
  sellingMode: "STANDARD",
  negativeStockLimit: DEFAULT_NEGATIVE_STOCK_LIMIT,
});

export function buildStorefrontVariantOptions(
  variants: readonly StorefrontVariantFacts[],
  pricingRule: StorefrontPricingRule = defaultStorefrontPricingRule,
  sellingPolicy: StorefrontSellingPolicy = STANDARD_SELLING_POLICY,
): StorefrontVariantOption[] {
  const normalized = variants.map((variant) => ({
    ...variant,
    color: normalizeOptionValue(variant.color),
    size: normalizeOptionValue(variant.size),
  }));
  const hasColorDimension = normalized.some((variant) => variant.color !== null);
  const optionCounts = new Map<string, number>();

  for (const variant of normalized) {
    if (!variant.size || (hasColorDimension && !variant.color)) continue;
    const key = optionKey(variant.color, variant.size, hasColorDimension);
    optionCounts.set(key, (optionCounts.get(key) ?? 0) + 1);
  }

  return normalized.map((variant) => {
    const { price, basePriceVnd, isDiscounted } = pricingRule(variant);
    // Advisory: ADR 0014 §2 keeps the authoritative check at the commit boundary, so no reservation
    // quantity is subtracted here. A page cannot bind a decision made later, and trusting it to is
    // the oversell master spec §31 forbids.
    const sellability = resolveVariantSellability({
      mirroredStock: variant.sellableStock,
      activeReservedQuantity: 0,
      sellingMode: sellingPolicy.sellingMode,
      negativeStockLimit: sellingPolicy.negativeStockLimit,
      isComposite: false,
    });
    let unavailableReason: StorefrontVariantUnavailableReason | null = null;

    if (!variant.size || (hasColorDimension && !variant.color)) {
      unavailableReason = "MAPPING_REQUIRED";
    } else if (
      (optionCounts.get(optionKey(variant.color, variant.size, hasColorDimension)) ?? 0) > 1
    ) {
      unavailableReason = "AMBIGUOUS_OPTION";
    } else if (!sellability.sellable) {
      // One authority for "may another unit be sold", shared with the reservation gate rather than
      // re-derived here. Before I4 this read `sellableStock <= 0`, which silently assumed STANDARD
      // for every product and would have hidden an OVERSELL variant the owner had allowed to −20.
      unavailableReason = "OUT_OF_STOCK";
    } else if (price === null) {
      unavailableReason = "PRICE_UNRESOLVED";
    }

    return {
      ...variant,
      price,
      basePriceVnd,
      // A variant the shopper cannot buy is not on sale, whatever the campaign says. Keeping the
      // discounted flag tied to a usable price stops an unavailable option rendering sale styling.
      isDiscounted: isDiscounted && unavailableReason === null,
      purchasable: unavailableReason === null,
      isPreorderSale: unavailableReason === null && sellability.isPreorderSale,
      unavailableReason,
    };
  });
}
