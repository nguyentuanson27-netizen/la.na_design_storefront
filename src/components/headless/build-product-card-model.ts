import {
  OUT_OF_STOCK_LABEL,
  PREORDER_LABEL,
} from "../../commerce/preorder-fulfillment-presentation.ts";
import type { StorefrontProductMedia, TrustedProductImage } from "../../commerce/product-media.ts";
import { resolveStorefrontDiscountPresentation } from "../../commerce/storefront-discount-presentation.ts";
import {
  buildStorefrontVariantOptions,
  getStorefrontResolvedPriceRange,
  STANDARD_STANDALONE_CAPACITY,
  type StorefrontPricingRule,
  type StorefrontProductCapacity,
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
  /**
   * Whether to show "Lẻ size - Chỉ còn ít". The copy states two stock facts, so both are proved from
   * the variants' `sellableStock` rather than assumed from the campaign: see `provesLastSizesLeft`.
   * It also needs a real discount from a "Xả hàng lẻ size" (CLEARANCE) campaign, which only a sale
   * listing knows about; every other surface leaves this false.
   */
  lastSizesLeft: boolean;
  marketingBadge: Readonly<{ type: "sale" | "new" | "bestseller"; label: string }> | null;
  availability: "in-stock" | "out-of-stock" | "partial";
  /**
   * F8a / master spec §30 — whether this product can currently be bought **only** as `Đặt trước`.
   *
   * A card addresses a product, not a variant, so it cannot repeat §30's per-variant rule verbatim.
   * The honest card-level reading is "everything you can buy here is a preorder sale": if any
   * variant still has ready stock the shopper can buy it today, and §30 says a product with ready
   * stock must not show preorder state at all.
   *
   * It is a separate field from `marketingBadge` on purpose. §30 forbids the Sale/New/Bestseller
   * priority hiding availability, so the two cannot share one slot — a card renders both.
   */
  isPreorderOnly: boolean;
  /**
   * The exact availability word to render, or `null` when the product has ready stock and there is
   * nothing to say.
   *
   * Decided here rather than in markup so a brand redrawing the card cannot mistype one of the two
   * strings master spec §29/§30 fixes, and cannot invent a third.
   */
  availabilityLabel: string | null;
  selectEvent: TrackingEvent | null;
}>;

export type ProductCardModelInput = Readonly<{
  slug: string;
  name: string;
  variants: readonly StorefrontVariantFacts[];
  media?: StorefrontProductMedia | null;
  pricingRule?: StorefrontPricingRule;
  /**
   * I4/I5 — this product's real selling policy and composite flag, when the caller read one.
   *
   * Defaults to the approved missing-row answer (`STANDARD` floored at 0, not a composite), which
   * is exactly what every caller behaved as before F8a. A listing that supplies the real policy
   * gets availability and `isPreorderOnly` resolved by the same authority the PDP and the cart use;
   * one that does not keeps today's answer rather than guessing.
   */
  productCapacity?: StorefrontProductCapacity;
  flashSale?: StorefrontFlashSalePresentation;
  /** The sale read chose this card for a CLEARANCE discount. Necessary, not sufficient, for the tag. */
  isClearance?: boolean;
  selectEvent?: TrackingEvent | null;
  isNewArrival?: boolean;
  isBestseller?: boolean;
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

/**
 * Availability from the canonical answer, not from raw stock.
 *
 * This used to count a positive raw stock, which is `STANDARD`'s floor written out a second time. It
 * called an `OVERSELL` variant sitting at −5 sold out while the PDP and the cart both offered it,
 * and it called a depleted `PREORDER` variant sold out while it was still purchasable as
 * `Đặt trước`. `purchasable` is what `resolveVariantSellability()` decided under this product's own
 * policy, so the card now agrees with every other surface by construction.
 */
function resolveAvailability(
  options: readonly StorefrontVariantOption[],
): ProductCardModel["availability"] {
  const purchasable = options.filter((option) => option.purchasable).length;
  if (purchasable === 0) return "out-of-stock";
  return purchasable === options.length ? "in-stock" : "partial";
}

/** §30's card-level reading: preorder only when nothing here can be bought from ready stock. */
function resolveIsPreorderOnly(options: readonly StorefrontVariantOption[]): boolean {
  const purchasable = options.filter((option) => option.purchasable);
  return purchasable.length > 0 && purchasable.every((option) => option.isPreorderSale);
}

/**
 * The exact word to render, or nothing.
 *
 * `purchasable === false` is broader than "sold out": `buildStorefrontVariantOptions()` also
 * refuses an option for `PRICE_UNRESOLVED`, `MAPPING_REQUIRED` and `AMBIGUOUS_OPTION`. Saying
 * `Hết hàng` for those is a false factual claim about stock — and on a product whose price has not
 * resolved it would render beside `Giá đang cập nhật`, which contradicts it.
 *
 * So the out-of-stock word is reserved for the one reason that means it: every option blocked, and
 * blocked by capacity. Anything else says nothing, and the price line already tells the shopper
 * what is actually wrong.
 */
function resolveAvailabilityLabel(options: readonly StorefrontVariantOption[]): string | null {
  if (options.some((option) => option.purchasable)) {
    return resolveIsPreorderOnly(options) ? PREORDER_LABEL : null;
  }
  const blockedByCapacity =
    options.length > 0 && options.every((option) => option.unavailableReason === "OUT_OF_STOCK");
  return blockedByCapacity ? OUT_OF_STOCK_LABEL : null;
}

/**
 * The total remaining stock below which "Chỉ còn ít" is true. Owner decision on #79: fewer than 10
 * pieces left across every size still in stock.
 */
export const LAST_SIZES_TOTAL_STOCK_LIMIT = 10;

/**
 * "Lẻ size - Chỉ còn ít", proved rather than asserted: at least one size is sold out (so what is
 * left really is scattered sizes), something is still for sale from ready stock, and the ready
 * pieces left total fewer than `LAST_SIZES_TOTAL_STOCK_LIMIT`.
 *
 * Both states come from the canonical per-variant answer, never from a stock threshold written here:
 * "sold out" is the same capacity refusal the `Hết hàng` label reads, and a `Đặt trước` size has no
 * ready pieces to count, so a product selling any size on preorder never makes the claim. Stock is
 * read only as a quantity, floored at zero, to count what is physically left.
 */
function provesLastSizesLeft(options: readonly StorefrontVariantOption[]): boolean {
  const soldOut = options.some(
    (option) => !option.purchasable && option.unavailableReason === "OUT_OF_STOCK",
  );
  const forSale = options.filter((option) => option.purchasable);
  if (!soldOut || forSale.length === 0 || forSale.some((option) => option.isPreorderSale)) {
    return false;
  }
  const piecesLeft = forSale.reduce((total, option) => total + Math.max(0, option.sellableStock), 0);
  return piecesLeft > 0 && piecesLeft < LAST_SIZES_TOTAL_STOCK_LIMIT;
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
  const productCapacity = input.productCapacity ?? STANDARD_STANDALONE_CAPACITY;

  // Resolved once, under this product's real capacity, and used for two different jobs: the price
  // presentation below (which a flash card resolves from its representative instead) and the
  // availability facts, which every card needs whichever price path it took.
  const capacityOptions = buildStorefrontVariantOptions(
    input.variants,
    input.pricingRule,
    productCapacity,
  );

  // Flash cards receive the exact representative selected before pagination. Other listings keep
  // their existing option-range path and can still inject a promotion-aware pricing rule.
  const options = flashSale ? null : capacityOptions;
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

  const availability = resolveAvailability(capacityOptions);
  const isPreorderOnly = resolveIsPreorderOnly(capacityOptions);

  const marketingBadge =
    discountPercent > 0
      ? Object.freeze({ type: "sale" as const, label: `-${discountPercent}%` })
      : input.isNewArrival
        ? Object.freeze({ type: "new" as const, label: "Hàng mới" })
        : input.isBestseller
          ? Object.freeze({ type: "bestseller" as const, label: "Bán chạy" })
          : null;

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
    // Campaign membership alone is not enough: the copy is a stock claim, so stock must prove it,
    // and a clearance tag on a full-price card would promise a sale the price does not show.
    lastSizesLeft:
      input.isClearance === true && discountPercent > 0 && provesLastSizesLeft(capacityOptions),
    marketingBadge,
    availability,
    isPreorderOnly,
    availabilityLabel: resolveAvailabilityLabel(capacityOptions),
    selectEvent: input.selectEvent ?? null,
  });
}
