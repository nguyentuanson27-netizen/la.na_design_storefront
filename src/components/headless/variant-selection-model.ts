import { formatVietnamCalendarDate } from "../../commerce/availability-cycle.ts";
import { resolveStorefrontDiscountPresentation } from "../../commerce/storefront-discount-presentation.ts";
import {
  deriveStorefrontProjectionSelection,
  type StorefrontProjectionOption,
} from "../../commerce/storefront-projection.ts";
import { getStorefrontResolvedPriceRange } from "../../commerce/storefront-product.ts";

/**
 * Every money and purchasability decision the purchase panel makes, as pure functions.
 *
 * These are separated from `use-variant-selection.ts` rather than living beside the hook because
 * the hook reaches `@/commerce/storefront-actions`, which imports `next/headers` and cannot be
 * loaded outside a Next request. Keeping the decisions here is what makes them testable at all --
 * and these are the decisions a brand redrawing the panel must never have to make again.
 */

const currency = new Intl.NumberFormat("vi-VN", {
  style: "currency",
  currency: "VND",
  maximumFractionDigits: 0,
});

export type VariantSelectionState = Readonly<{
  kindKey: string | null;
  color: string | null;
  size: string | null;
}>;

export type VariantSelectionViewInput = Readonly<{
  options: readonly StorefrontProjectionOption[];
  /** Product-level options only: composite components must not speak for the parent before selection. */
  productLevelOptions: readonly StorefrontProjectionOption[];
  selection: VariantSelectionState;
}>;

function defaultPriceLabel(options: readonly StorefrontProjectionOption[]): string {
  const range = getStorefrontResolvedPriceRange(options);
  if (!range) return "Giá đang cập nhật";
  return range.minimum === range.maximum
    ? currency.format(range.minimum)
    : `Từ ${currency.format(range.minimum)}`;
}

export function resolveVariantSelectionView(input: VariantSelectionViewInput) {
  const selection = deriveStorefrontProjectionSelection(input.options, input.selection);

  const priceLabel =
    selection.selectedPrice === null
      ? defaultPriceLabel(input.productLevelOptions)
      : currency.format(selection.selectedPrice);

  // Base must be strictly greater than price, not merely flagged: a campaign that left the base
  // equal would otherwise strike through the amount the shopper is already paying.
  const showsDiscount =
    selection.selectedIsDiscounted
    && selection.selectedPrice !== null
    && selection.selectedBasePriceVnd !== null
    && selection.selectedBasePriceVnd > selection.selectedPrice;

  const unavailableMessage =
    selection.selectedVariantId !== null && !selection.canAdd
      ? selection.selectedUnavailableReason === "OUT_OF_STOCK"
        ? "Lựa chọn này đã hết hàng."
        : "Lựa chọn này hiện chưa mua được."
      : "";

  const initialDiscount = resolveStorefrontDiscountPresentation(input.productLevelOptions);

  /**
   * One shape for all three price presentations the panel has: a discounted selection, an
   * undiscounted view of a product that has a sale somewhere, and a plain price. Collapsing them
   * here means a redrawn panel renders one thing instead of rediscovering which branch applies --
   * which is where a brand would get the struck-through amount wrong.
   */
  const priceDisplay =
    showsDiscount && selection.selectedBasePriceVnd !== null && selection.selectedPrice !== null
      ? {
          displayText: priceLabel,
          compareAtText: currency.format(selection.selectedBasePriceVnd),
          discountPercent: Math.round(
            (1 - selection.selectedPrice / selection.selectedBasePriceVnd) * 100,
          ),
        }
      : selection.selectedPrice === null && initialDiscount
        ? {
            displayText: `${initialDiscount.hasCheaperCurrentVariant ? "Sale từ " : ""}${currency.format(initialDiscount.effectivePriceVnd)}`,
            compareAtText: currency.format(initialDiscount.basePriceVnd),
            discountPercent: initialDiscount.discountPercent,
          }
        : { displayText: priceLabel, compareAtText: null, discountPercent: null };

  return Object.freeze({
    ...selection,
    priceLabel,
    showsDiscount,
    priceDisplay: Object.freeze(priceDisplay),
    compareAtText:
      showsDiscount && selection.selectedBasePriceVnd !== null
        ? currency.format(selection.selectedBasePriceVnd)
        : null,
    unavailableMessage,
    hasPurchasableVariant: input.options.some((option) => option.purchasable),
    initialDiscount,
    /** Lowest resolvable price, for the ViewContent pixel. `null` rather than 0 when unresolved. */
    entryPrice: getStorefrontResolvedPriceRange(input.options)?.minimum ?? null,
    /**
     * I9 — the selected variant's `Dự kiến có hàng` date as the shopper reads it, or `null`.
     *
     * Formatted here for the same reason the price is: the panel is markup a brand rewrites, and
     * the decisions it must never have to make again live in this module. The projection keeps the
     * ISO value the feed and the JSON-LD publish; only this label is Vietnamese.
     */
    availabilityDateLabel:
      selection.selectedAvailabilityDate === null
        ? null
        : formatVietnamCalendarDate(selection.selectedAvailabilityDate),
  });
}

/**
 * The selection after the shopper picks a size.
 *
 * The rule is narrower than it sounds, and is characterized rather than designed: the colour is
 * cleared only when the projection reports it as `disabled`. A colour that simply does not come in
 * the new size is left selected, and the selection then resolves to no variant. That is today's
 * behaviour, preserved deliberately -- changing it is a UX decision, not a refactor.
 */
export function resolveSelectionAfterSizeChange(input: {
  options: readonly StorefrontProjectionOption[];
  selection: VariantSelectionState;
  size: string;
}): VariantSelectionState {
  const next = deriveStorefrontProjectionSelection(input.options, {
    kindKey: input.selection.kindKey,
    color: input.selection.color,
    size: input.size,
  });

  const currentColor =
    input.selection.color === null
      ? null
      : next.colors.find((choice) => choice.value === input.selection.color);

  return Object.freeze({
    kindKey: input.selection.kindKey,
    color: currentColor?.disabled ? null : input.selection.color,
    size: input.size,
  });
}
