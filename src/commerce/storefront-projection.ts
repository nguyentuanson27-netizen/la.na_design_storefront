import { sortClothingSizes } from "./clothing-size.ts";
import {
  buildStorefrontVariantOptions,
  defaultStorefrontPricingRule,
  toStorefrontSelectableOptions,
  STANDARD_STANDALONE_CAPACITY,
  type StorefrontPricingRule,
  type StorefrontProductCapacity,
  type StorefrontSelectableOption,
  type StorefrontVariantFacts,
  type StorefrontVariantUnavailableReason,
} from "./storefront-product.ts";
import { deriveStorefrontSelection } from "./storefront-selection.ts";

/**
 * The policy half of `StorefrontProductCapacity`: what an operator sets, without `isComposite`,
 * which is this module's to decide and not a caller's to claim.
 */
export type StorefrontSellingPolicy = Omit<StorefrontProductCapacity, "isComposite">;

export type StorefrontCompositeComponentGroup = Readonly<{
  label: string;
  variants: readonly StorefrontVariantFacts[];
}>;

export type StorefrontProjectionOption = StorefrontSelectableOption & {
  kindKey: string | null;
  kindLabel: string | null;
};

export type StorefrontProductProjection = Readonly<{
  mode: "standalone" | "composite";
  options: StorefrontProjectionOption[];
}>;

/**
 * The kind key a composite parent's own set options carry. Named here because this module mints it;
 * a consumer that needs to tell the set apart from its components must not re-spell the literal.
 */
export const COMPOSITE_PARENT_KIND_KEY = "parent";

type StorefrontProjectionSelection = Readonly<{
  kindKey: string | null;
  color: string | null;
  size: string | null;
}>;

type StorefrontKindChoice = {
  key: string;
  label: string;
  disabled: boolean;
};

type StorefrontValueChoice = {
  value: string;
  disabled: boolean;
};

function normalizeLabel(label: string): string {
  return label.trim();
}

function normalizedLabelKey(label: string): string {
  return normalizeLabel(label).toLocaleLowerCase("vi");
}

function projectOptions(
  variants: readonly StorefrontVariantFacts[],
  kindKey: string | null,
  kindLabel: string | null,
  forcedUnavailableReason: StorefrontVariantUnavailableReason | null = null,
  pricingRule: StorefrontPricingRule = defaultStorefrontPricingRule,
  sellingPolicy: StorefrontSellingPolicy = STANDARD_STANDALONE_CAPACITY,
  isComposite = false,
): StorefrontProjectionOption[] {
  // This module is the only one that can tell a set apart from its parts, so it is the only one
  // that can tell the capacity rule — the caller supplies the policy, never the composite flag.
  const productCapacity: StorefrontProductCapacity = {
    sellingMode: sellingPolicy.sellingMode,
    negativeStockLimit: sellingPolicy.negativeStockLimit,
    isComposite,
  };

  return toStorefrontSelectableOptions(
    buildStorefrontVariantOptions(variants, pricingRule, productCapacity),
  ).map((option) =>
    forcedUnavailableReason === null
      ? { ...option, kindKey, kindLabel }
      : {
          ...option,
          kindKey,
          kindLabel,
          purchasable: false,
          isDiscounted: false,
          unavailableReason: forcedUnavailableReason,
        },
  );
}

export function buildStorefrontProductProjection({
  parentVariants,
  componentGroups,
  hasCompositeGraph,
  pricingRule = defaultStorefrontPricingRule,
  sellingPolicy = STANDARD_STANDALONE_CAPACITY,
}: Readonly<{
  parentVariants: readonly StorefrontVariantFacts[];
  componentGroups: readonly StorefrontCompositeComponentGroup[];
  hasCompositeGraph: boolean;
  pricingRule?: StorefrontPricingRule;
  /**
   * The policy of **this** product — the standalone product, or the composite parent. It is not the
   * components': `ProductSellingPolicy` is keyed by `productId`, a component is a different product,
   * and a component with no row of its own resolves to `STANDARD` like any other. Inheriting the
   * parent's would sell a child below zero on a policy nobody set for it.
   *
   * Defaults to the approved missing-row answer, so every caller that has not been switched keeps
   * today's behaviour. I2 is what starts supplying a real one; the composite restriction below is
   * wired now so that it is already enforced on the day it stops being inert.
   */
  sellingPolicy?: StorefrontSellingPolicy;
}>): StorefrontProductProjection {
  if (!hasCompositeGraph) {
    return {
      mode: "standalone",
      options: projectOptions(parentVariants, null, null, null, pricingRule, sellingPolicy),
    };
  }

  const labelCounts = new Map<string, number>();
  for (const group of componentGroups) {
    const key = normalizedLabelKey(group.label);
    labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
  }

  const options: StorefrontProjectionOption[] = [
    // The parent set is the composite, and the policy passed in is the parent's.
    ...projectOptions(
      parentVariants,
      COMPOSITE_PARENT_KIND_KEY,
      "Set",
      null,
      pricingRule,
      sellingPolicy,
      true,
    ),
  ];

  componentGroups.forEach((group, index) => {
    const label = normalizeLabel(group.label);
    const ambiguousLabel = label.length === 0 || (labelCounts.get(normalizedLabelKey(group.label)) ?? 0) > 1;
    options.push(
      ...projectOptions(
        group.variants,
        `component-${index + 1}`,
        label,
        ambiguousLabel ? "AMBIGUOUS_OPTION" : null,
        pricingRule,
        // Deliberately NOT the parent's policy. A component is its own product with its own
        // `ProductSellingPolicy` row, or none, and none means `STANDARD` — so a component this
        // projection cannot resolve a policy for stays at the default rather than inheriting a
        // `PREORDER`/`OVERSELL` the operator set on the set. Reading each component's own policy is
        // I2's job; until then the default is the correct answer, not a placeholder.
        STANDARD_STANDALONE_CAPACITY,
      ),
    );
  });

  return { mode: "composite", options };
}

/**
 * The options that speak for the product itself.
 *
 * For a standalone product that is every option. For a composite it is the parent set only:
 * a component's stock and price describe a part, and letting one speak for the whole is the
 * confusion the composite projection exists to prevent.
 */
export function selectStorefrontProductLevelOptions(
  projection: StorefrontProductProjection,
): StorefrontProjectionOption[] {
  return projection.mode === "standalone"
    ? [...projection.options]
    : projection.options.filter((option) => option.kindKey === COMPOSITE_PARENT_KIND_KEY);
}

function uniqueValues(
  options: readonly StorefrontProjectionOption[],
  key: "color" | "size",
): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const option of options) {
    const value = option[key];
    if (value && !seen.has(value)) {
      seen.add(value);
      values.push(value);
    }
  }
  return key === "size" ? sortClothingSizes(values) : values;
}

function supportsProjectedSelection(
  option: StorefrontProjectionOption,
  selection: StorefrontProjectionSelection,
): boolean {
  if (!option.purchasable) return false;
  if (selection.kindKey !== null && option.kindKey !== selection.kindKey) return false;
  if (selection.size !== null && option.size !== selection.size) return false;
  if (selection.color !== null && option.color !== selection.color) return false;
  return true;
}

export function deriveStorefrontProjectionSelection(
  options: readonly StorefrontProjectionOption[],
  selection: StorefrontProjectionSelection,
) {
  const hasKindOptions = options.some((option) => option.kindKey !== null);
  if (!hasKindOptions) {
    const standalone = deriveStorefrontSelection(options, {
      color: selection.color,
      size: selection.size,
    });
    return {
      hasKindOptions: false,
      kinds: [] as StorefrontKindChoice[],
      ...standalone,
    };
  }

  const kindsByKey = new Map<string, string>();
  for (const option of options) {
    if (option.kindKey && option.kindLabel !== null && !kindsByKey.has(option.kindKey)) {
      kindsByKey.set(option.kindKey, option.kindLabel);
    }
  }
  const kinds: StorefrontKindChoice[] = [...kindsByKey].map(([key, label]) => ({
    key,
    label,
    disabled: !options.some((option) =>
      supportsProjectedSelection(option, { kindKey: key, color: null, size: null }),
    ),
  }));

  const kindOptions =
    selection.kindKey === null
      ? []
      : options.filter((option) => option.kindKey === selection.kindKey);

  const sizes: StorefrontValueChoice[] = uniqueValues(
    selection.kindKey === null ? options : kindOptions,
    "size",
  ).map((value) => ({
    value,
    disabled:
      selection.kindKey === null ||
      !kindOptions.some((option) =>
        supportsProjectedSelection(option, {
          kindKey: selection.kindKey,
          color: null,
          size: value,
        }),
      ),
  }));

  const hasColorOptions =
    selection.kindKey !== null && kindOptions.some((option) => option.color !== null);
  const colors: StorefrontValueChoice[] = hasColorOptions
    ? uniqueValues(kindOptions, "color").map((value) => ({
        value,
        disabled:
          selection.size === null ||
          !kindOptions.some((option) =>
            supportsProjectedSelection(option, {
              kindKey: selection.kindKey,
              color: value,
              size: selection.size,
            }),
          ),
      }))
    : [];

  const selected =
    selection.kindKey !== null &&
    selection.size !== null &&
    (!hasColorOptions || selection.color !== null)
      ? kindOptions.find(
          (option) =>
            option.size === selection.size &&
            (hasColorOptions ? option.color === selection.color : option.color === null),
        ) ?? null
      : null;

  return {
    hasKindOptions: true,
    kinds,
    hasColorOptions,
    colors,
    sizes,
    selectedVariantId: selected?.id ?? null,
    selectedPrice: selected?.price ?? null,
    selectedBasePriceVnd: selected?.basePriceVnd ?? null,
    selectedIsDiscounted: selected?.isDiscounted ?? false,
    selectedUnavailableReason: selected === null ? null : selected.unavailableReason,
    canAdd: selected !== null && selected.purchasable,
  };
}
