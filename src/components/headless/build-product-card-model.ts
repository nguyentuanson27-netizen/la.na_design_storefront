import type { StorefrontProductMedia, TrustedProductImage } from "../../commerce/product-media.ts";
import { resolveStorefrontDiscountPresentation } from "../../commerce/storefront-discount-presentation.ts";
import {
  buildStorefrontVariantOptions,
  getStorefrontResolvedPriceRange,
  type StorefrontPricingRule,
  type StorefrontVariantFacts,
  type StorefrontVariantOption,
} from "../../commerce/storefront-product.ts";
import type { TrackingEvent } from "../../tracking/commerce-events.ts";

/**
 * Everything a product card needs to render, decided here so a brand redrawing the card never has
 * to reimplement pricing.
 *
 * The money rules this file carries -- when a range says "Từ", when a sale says "Sale từ", which
 * amount is struck through, what a discount badge reads -- used to live inside
 * `StorefrontProductCard`. Every brand that redrew that card would have had to rebuild them, and a
 * mistake there is a wrong price shown to a shopper. None of the arithmetic is new: the resolved
 * prices still come from `@/commerce/storefront-product` and the discount presentation from
 * `@/commerce/storefront-discount-presentation`.
 */

const currency = new Intl.NumberFormat("vi-VN", {
  style: "currency",
  currency: "VND",
  maximumFractionDigits: 0,
});

export type StorefrontFlashSalePresentation = Readonly<{
  representativeVariantId: string;
  basePriceVnd: number;
  effectivePriceVnd: number;
  hasCheaperCurrentVariant: boolean;
  /** Server-relative remaining duration. No browser wall-clock deadline is exposed. */
  remainingMs: number;
}>;

export type ProductCardColorSwatch = Readonly<{
  color: string;
  /**
   * `null` when the caller supplied no variant-to-gallery mapping, or the mapped index is outside
   * the gallery. Listing surfaces carry no mapping today; guessing an image would point the swatch
   * at an unrelated photo, which is worse than showing none.
   */
  image: TrustedProductImage | null;
}>;

export type ProductCardModel = Readonly<{
  href: string;
  name: string;
  primaryImage: TrustedProductImage | null;
  /** The second gallery photo, revealed on hover. `null` when it would repeat the primary. */
  hoverImage: TrustedProductImage | null;
  colorSwatches: readonly ProductCardColorSwatch[];
  price: Readonly<{
    /** Formatted VND, ready to render. */
    displayText: string;
    /** The struck-through amount, or `null` when nothing is struck through. */
    compareAtText: string | null;
    isRange: boolean;
    /** Whole percent for a sale badge, or `null` when no badge is shown. */
    discountPercent: number | null;
  }>;
  flashSale: Readonly<{ remainingMs: number; countdownText: string | null }> | null;
  availability: "in-stock" | "out-of-stock" | "partial";
  selectEvent: TrackingEvent | null;
}>;

export type ProductCardModelInput = Readonly<{
  slug: string;
  name: string;
  variants: readonly StorefrontVariantFacts[];
  media?: StorefrontProductMedia | null;
  pricingRule?: StorefrontPricingRule;
  flashSale?: StorefrontFlashSalePresentation;
  selectEvent?: TrackingEvent | null;
  /**
   * Product-level mapping from variant id into this product's gallery, when the caller has one.
   * The PDP resolves it server-side; listing surfaces do not carry it.
   */
  galleryIndexByVariantId?: Readonly<Record<string, number>>;
}>;

function describePrice(options: readonly StorefrontVariantOption[]): string {
  const range = getStorefrontResolvedPriceRange(options);
  if (!range) return "Giá đang cập nhật";
  return range.minimum === range.maximum
    ? currency.format(range.minimum)
    : `Từ ${currency.format(range.minimum)}`;
}

function describePromotionalPrice({
  effectivePriceVnd,
  hasCheaperCurrentVariant,
}: Readonly<{ effectivePriceVnd: number; hasCheaperCurrentVariant: boolean }>): string {
  return hasCheaperCurrentVariant
    ? `Sale từ ${currency.format(effectivePriceVnd)}`
    : currency.format(effectivePriceVnd);
}

/**
 * Time formatting rather than money, but it lives here for the same reason: the day/hour/minute
 * thresholds are a decision about what is true, and re-deriving them per brand would drift.
 */
function describeFlashCountdown(remainingMs: number): string | null {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return hours > 0 ? `Còn ${days} ngày ${hours} giờ` : `Còn ${days} ngày`;
  }
  if (hours > 0) return `Còn ${hours} giờ ${minutes} phút`;
  return `Còn ${minutes} phút`;
}

function resolveAvailability(
  variants: readonly StorefrontVariantFacts[],
): ProductCardModel["availability"] {
  const inStock = variants.filter((candidate) => candidate.sellableStock > 0).length;
  if (inStock === 0) return "out-of-stock";
  return inStock === variants.length ? "in-stock" : "partial";
}

/** Distinct colours in first-seen order, each with the image its variant maps to, when known. */
function resolveColorSwatches(
  variants: readonly StorefrontVariantFacts[],
  media: StorefrontProductMedia | null | undefined,
  galleryIndexByVariantId: Readonly<Record<string, number>> | undefined,
): readonly ProductCardColorSwatch[] {
  if (!media) return [];

  const swatches: ProductCardColorSwatch[] = [];
  const seen = new Set<string>();

  for (const candidate of variants) {
    const color = candidate.color;
    if (color === null || color.trim().length === 0 || seen.has(color)) continue;
    seen.add(color);

    const index = galleryIndexByVariantId?.[candidate.id];
    const image =
      index !== undefined && Number.isSafeInteger(index) && index >= 0 && index < media.gallery.length
        ? media.gallery[index]!
        : null;

    swatches.push(Object.freeze({ color, image }));
  }

  return Object.freeze(swatches);
}

export function buildProductCardModel(input: ProductCardModelInput): ProductCardModel {
  const { flashSale, media } = input;

  // Flash cards receive the exact representative selected before pagination. Other listings keep
  // their existing option-range path and can still inject a promotion-aware pricing rule.
  const options = flashSale ? null : buildStorefrontVariantOptions(input.variants, input.pricingRule);
  const promotionSale = options ? resolveStorefrontDiscountPresentation(options) : null;

  const primaryImage = media?.primary ?? null;
  const hoverImage =
    media?.gallery && media.gallery.length > 1 && media.gallery[1]?.url !== primaryImage?.url
      ? media.gallery[1]!
      : null;

  const flashSaleDiscountPercent =
    flashSale && flashSale.basePriceVnd > flashSale.effectivePriceVnd
      ? Math.round((1 - flashSale.effectivePriceVnd / flashSale.basePriceVnd) * 100)
      : 0;
  const discountPercent = flashSale ? flashSaleDiscountPercent : promotionSale?.discountPercent ?? 0;

  const priceRange = options ? getStorefrontResolvedPriceRange(options) : null;

  const price = flashSale
    ? {
        displayText: describePromotionalPrice(flashSale),
        compareAtText: currency.format(flashSale.basePriceVnd),
        isRange: false,
        discountPercent: discountPercent > 0 ? discountPercent : null,
      }
    : promotionSale
      ? {
          displayText: describePromotionalPrice(promotionSale),
          compareAtText: currency.format(promotionSale.basePriceVnd),
          isRange: promotionSale.hasCheaperCurrentVariant,
          discountPercent: discountPercent > 0 ? discountPercent : null,
        }
      : {
          displayText: describePrice(options ?? []),
          compareAtText: null,
          isRange: priceRange !== null && priceRange.minimum !== priceRange.maximum,
          discountPercent: null,
        };

  return Object.freeze({
    href: `/shop/${encodeURIComponent(input.slug)}`,
    name: input.name,
    primaryImage,
    hoverImage,
    colorSwatches: resolveColorSwatches(input.variants, media, input.galleryIndexByVariantId),
    price: Object.freeze(price),
    flashSale: flashSale
      ? Object.freeze({
          remainingMs: flashSale.remainingMs,
          countdownText: describeFlashCountdown(flashSale.remainingMs),
        })
      : null,
    availability: resolveAvailability(input.variants),
    selectEvent: input.selectEvent ?? null,
  });
}
