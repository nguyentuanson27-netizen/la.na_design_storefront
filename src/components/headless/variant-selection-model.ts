import { formatVietnamCalendarDate } from "../../commerce/availability-cycle.ts";
import { PREORDER_LABEL } from "../../commerce/preorder-fulfillment-presentation.ts";
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

/**
 * The add-to-bag wording for the two states master spec §30 distinguishes.
 *
 * The ready-stock word is unchanged, because it is the approved CTA and F7b's browser contract
 * pins it. The preorder word is §30's own: a button that still said "add to bag" while the item
 * will not ship for fifteen days is precisely the misreading §30 forbids.
 */
export const DEFAULT_ADD_TO_BAG_LABEL = "Thêm vào giỏ";
export const PREORDER_ADD_TO_BAG_LABEL = PREORDER_LABEL;

/**
 * The accessible names for the same two buttons.
 *
 * A button whose visible word changes but whose accessible name does not would tell a screen-reader
 * user "add to bag" for a preorder — §30's misreading, delivered only to the people least able to
 * catch it from surrounding layout.
 */
export const ADD_TO_BAG_NAMES = {
  ready: "Thêm vào giỏ hàng",
  preorder: `${PREORDER_LABEL} sản phẩm này`,
} as const;
const QUICK_ADD_NAMES = {
  ready: "Thêm vào giỏ từ thanh mua nhanh",
  preorder: `${PREORDER_LABEL} từ thanh mua nhanh`,
} as const;

/**
 * Refinement spec "Variant UX" -- the exact approved sentence for a composite whose kind is still
 * unchosen.
 *
 * It is a *presentation* fact, not a commerce one: `deriveStorefrontProjectionSelection` still
 * returns those sizes `disabled`, and nothing here re-derives stock. What the sentence buys is the
 * distinction the spec requires -- "not chosen yet" reads as unresolved rather than as the
 * `Hết hàng` a shopper would otherwise infer from a greyed-out size row.
 */
export const KIND_SELECTION_GUIDANCE = "Nàng chọn phân loại trước để xem size còn hàng";

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
        ? "Lựa chọn này tạm hết"
        : "Lựa chọn này hiện chưa mua được."
      : "";

  /**
   * F8a / master spec §30 — the preorder facts for the option the shopper has actually selected.
   *
   * Both are false/absent until a variant is selected, and both follow the selection: switching to
   * a ready variant clears them, which is what stops one variant's state leaking onto the next.
   * Nothing is derived from stock here — `selectedIsPreorderSale` is the capacity authority's own
   * classification, passed through the projection.
   */
  const isPreorderSelection = selection.selectedIsPreorderSale;

  /**
   * Set only while a kind-bearing product has no kind selected. The panel reads it for both the
   * sentence and the neutral (never sold-out) styling of the size inputs it explains.
   */
  const kindSelectionGuidance =
    selection.hasKindOptions && input.selection.kindKey === null ? KIND_SELECTION_GUIDANCE : null;

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
    kindSelectionGuidance,
    isPreorderSelection,
    /** The exact §30 word for the selected option, or `null` when it is ordinary ready stock. */
    preorderLabel: isPreorderSelection ? PREORDER_LABEL : null,
    /**
     * What the add-to-bag button must say. §30 requires the CTA itself to communicate preorder
     * semantics, so the word changes rather than a badge appearing beside an unchanged button.
     */
    addToBagLabel: isPreorderSelection ? PREORDER_ADD_TO_BAG_LABEL : DEFAULT_ADD_TO_BAG_LABEL,
    addToBagAccessibleName: isPreorderSelection
      ? ADD_TO_BAG_NAMES.preorder
      : ADD_TO_BAG_NAMES.ready,
    quickAddAccessibleName: isPreorderSelection ? QUICK_ADD_NAMES.preorder : QUICK_ADD_NAMES.ready,
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


/**
 * Presentation-only state for the below-lg sticky purchase entry point.
 *
 * Commerce eligibility stays in the selection projection. This helper only names the axes the
 * product actually exposes and formats the currently selected values in authority order.
 */
export function resolveMobilePurchasePresentation(
  view: ReturnType<typeof resolveVariantSelectionView>,
  selection: VariantSelectionState,
): Readonly<{
  actionLabel: string;
  summary: string;
  readyToAdd: boolean;
}> {
  const hasSize = view.sizes.length > 0;
  const dimensionLabels = [
    view.hasKindOptions ? "phân loại" : null,
    view.hasColorOptions ? "màu" : null,
    hasSize ? "size" : null,
  ].filter((value): value is string => value !== null);

  const selectedKind =
    selection.kindKey === null
      ? null
      : view.kinds.find((choice) => choice.key === selection.kindKey)?.label ?? null;

  const selectedValues = [
    view.hasKindOptions ? selectedKind : null,
    view.hasColorOptions ? selection.color : null,
    hasSize ? selection.size : null,
  ].filter((value): value is string => value !== null);

  const readyToAdd = view.canAdd && view.selectedVariantId !== null;

  return Object.freeze({
    actionLabel: readyToAdd
      ? view.addToBagLabel
      : `Chọn ${dimensionLabels.join(" / ")}`,
    summary: selectedValues.join(" · "),
    readyToAdd,
  });
}
