import { sortClothingSizes } from "./clothing-size.ts";
import {
  selectedAvailabilityDateOf,
  type StorefrontSelectableOption,
} from "./storefront-product.ts";

type StorefrontSelection = {
  color: string | null;
  size: string | null;
};

type StorefrontChoiceState = {
  value: string;
  disabled: boolean;
};

function uniqueMappedValues(
  options: readonly StorefrontSelectableOption[],
  key: "color" | "size",
): string[] {
  const values = new Set<string>();
  for (const option of options) {
    const value = option[key];
    if (value) values.add(value);
  }
  const result = [...values];
  return key === "size" ? sortClothingSizes(result) : result;
}

function supportsSelection(
  option: StorefrontSelectableOption,
  selection: StorefrontSelection,
): boolean {
  if (!option.purchasable) return false;
  if (selection.color !== null && option.color !== selection.color) return false;
  if (selection.size !== null && option.size !== selection.size) return false;
  return true;
}

export function deriveStorefrontSelection(
  options: readonly StorefrontSelectableOption[],
  selection: StorefrontSelection,
) {
  const colors: StorefrontChoiceState[] = uniqueMappedValues(options, "color").map((value) => ({
    value,
    disabled: !options.some((option) =>
      supportsSelection(option, { color: value, size: null }),
    ),
  }));
  const hasColorOptions = colors.length > 0;

  const sizes: StorefrontChoiceState[] = uniqueMappedValues(options, "size").map((value) => ({
    value,
    disabled: !options.some((option) =>
      supportsSelection(option, {
        color: hasColorOptions ? selection.color : null,
        size: value,
      }),
    ),
  }));

  // Selection identity and purchase eligibility are separate. A current sold-out option remains
  // the concrete option the shopper addressed, so its exact price/promotion state stays visible;
  // only add-to-bag is withheld.
  const selected =
    selection.size !== null && (!hasColorOptions || selection.color !== null)
      ? options.find(
          (option) =>
            option.size === selection.size &&
            (hasColorOptions ? option.color === selection.color : option.color === null),
        ) ?? null
      : null;

  return {
    hasColorOptions,
    colors,
    sizes,
    selectedVariantId: selected?.id ?? null,
    selectedPrice: selected?.price ?? null,
    selectedBasePriceVnd: selected?.basePriceVnd ?? null,
    selectedIsDiscounted: selected?.isDiscounted ?? false,
    selectedUnavailableReason: selected === null ? null : selected.unavailableReason,
    /**
     * F8a / master spec §30 — whether the selected option is a `Đặt trước` sale.
     *
     * Passed through from the option the capacity authority already classified. A surface must not
     * re-derive it from stock and selling mode: that is the duplicated threshold §30 and ADR 0014
     * exist to prevent, and it would disagree with the commit boundary the moment a policy changes.
     */
    selectedIsPreorderSale: selected?.isPreorderSale ?? false,
    // I9 — owner rule 10, from the one place that owns it. Standalone products are the common case,
    // so this path is where the product page usually reads the date.
    selectedAvailabilityDate: selectedAvailabilityDateOf(selected),
    canAdd: selected !== null && selected.purchasable,
  };
}
