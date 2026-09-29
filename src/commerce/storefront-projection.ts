import { sortClothingSizes } from "./clothing-size.ts";
import { projectExternalAvailability } from "./availability-projection.ts";
import {
  buildStorefrontVariantOptions,
  defaultStorefrontPricingRule,
  selectedAvailabilityDateOf,
  toStorefrontSelectableOptions,
  NO_AVAILABILITY_DATES,
  STANDARD_STANDALONE_CAPACITY,
  type StorefrontAvailabilityDates,
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

export type StorefrontCompositeSubSetGroup = Readonly<{
  label: string;
  kindKey: string;
  variants: readonly StorefrontVariantFacts[];
}>;

export type CompositeComponentKindLabel = "ÁO LẺ" | "QUẦN LẺ" | "CV LẺ";

export function classifyCompositeComponentSku(
  sku: string | null,
): CompositeComponentKindLabel | null {
  if (sku === null) return null;

  const normalized = sku.trim().toUpperCase();
  if (normalized.length === 0) return null;

  const matches: CompositeComponentKindLabel[] = [];
  if (normalized.includes("AO") || /(^|[^A-Z0-9])AD([-_0-9]|$)/.test(normalized) || normalized.startsWith("AD")) matches.push("ÁO LẺ");
  if (normalized.includes("QUAN") || /(^|[^A-Z0-9])QD([-_0-9]|$)/.test(normalized) || normalized.startsWith("QD")) matches.push("QUẦN LẺ");
  if (normalized.includes("CV") || normalized.includes("VAY")) matches.push("CV LẺ");

  return matches.length === 1 ? matches[0] : null;
}

export function resolveCompositeComponentGroupLabel(
  skus: readonly (string | null)[],
): CompositeComponentKindLabel | null {
  if (skus.length === 0) return null;

  let resolved: CompositeComponentKindLabel | null = null;
  for (const sku of skus) {
    const role = classifyCompositeComponentSku(sku);
    if (role === null) return null;
    if (resolved === null) {
      resolved = role;
    } else if (resolved !== role) {
      return null;
    }
  }
  return resolved;
}

export type StorefrontProjectionOption = StorefrontSelectableOption & {
  kindKey: string | null;
  kindLabel: string | null;
};

export type StorefrontProductProjection = Readonly<{
  mode: "standalone" | "composite";
  options: StorefrontProjectionOption[];
  colorDimensionLabel?: string;
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
  availabilityDates: StorefrontAvailabilityDates = NO_AVAILABILITY_DATES,
): StorefrontProjectionOption[] {
  // This module is the only one that can tell a set apart from its parts, so it is the only one
  // that can tell the capacity rule — the caller supplies the policy, never the composite flag.
  const productCapacity: StorefrontProductCapacity = {
    sellingMode: sellingPolicy.sellingMode,
    negativeStockLimit: sellingPolicy.negativeStockLimit,
    isComposite,
  };

  return toStorefrontSelectableOptions(
    buildStorefrontVariantOptions(variants, pricingRule, productCapacity, availabilityDates),
  ).map((option) =>
    forcedUnavailableReason === null
      ? { ...option, kindKey, kindLabel }
      : {
          ...option,
          kindKey,
          kindLabel,
          purchasable: false,
          isDiscounted: false,
          isPreorderSale: false,
          unavailableReason: forcedUnavailableReason,
          // I9 — the forced reason overrides what capacity decided, so the external availability
          // has to be re-decided with it. Keeping the un-forced answer would publish an offer for
          // a variant this projection has just declared unusable.
          availability: projectExternalAvailability({
            purchasable: false,
            isPreorderSale: false,
            unavailableReason: forcedUnavailableReason,
            capacityReason: "capacity-available",
            availabilityDate: null,
            today: null,
          }),
        },
  );
}

export function buildStorefrontProductProjection({
  parentVariants,
  subSetGroups = [],
  componentGroups,
  hasCompositeGraph,
  pricingRule = defaultStorefrontPricingRule,
  sellingPolicy = STANDARD_STANDALONE_CAPACITY,
  availabilityDates = NO_AVAILABILITY_DATES,
  colorDimensionLabel = "Màu",
  parentKindLabel,
}: Readonly<{
  parentVariants: readonly StorefrontVariantFacts[];
  subSetGroups?: readonly StorefrontCompositeSubSetGroup[];
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
  /**
   * I9 — the persisted preorder availability dates, supplied only by the two surfaces that publish
   * (the Merchant feed and the product page's JSON-LD). Absent means no date, which fails closed.
   */
  availabilityDates?: StorefrontAvailabilityDates;
  /**
   * Optional custom label for the color dimension (e.g. "Màu quần" for specific Áo Dài sets).
   * Defaults to "Màu".
   */
  colorDimensionLabel?: string;
  /**
   * Optional custom label for the parent set (e.g. "COMBO" when sub-sets exist).
   * Defaults to "COMBO" when subSetGroups are present, otherwise "FULL SET".
   */
  parentKindLabel?: string;
}>): StorefrontProductProjection {
  const resolvedColorDimensionLabel = colorDimensionLabel ?? "Màu";
  if (!hasCompositeGraph) {
    return {
      mode: "standalone",
      colorDimensionLabel: resolvedColorDimensionLabel,
      options: projectOptions(
        parentVariants,
        null,
        null,
        null,
        pricingRule,
        sellingPolicy,
        false,
        availabilityDates,
      ),
    };
  }

  /*
   * One kind per logical role, not per source product. Several Pancake products can each be a
   * `QUẦN LẺ` (one per pants colour, say); they are one choice for the shopper, so their variants
   * are aggregated under one kind and projected together. Every option still carries its own real
   * variant id, so the selection resolves to the source SKU the cart and checkout already trust.
   *
   * Aggregating is also what keeps a genuine collision fail-closed: two source variants with the
   * same colour and size inside one kind are marked `AMBIGUOUS_OPTION` by the shared option rule,
   * rather than one of them being picked.
   */
  const mergedComponentGroups = new Map<
    string,
    { label: string; variants: Map<string, StorefrontVariantFacts> }
  >();
  for (const group of componentGroups) {
    const key = normalizedLabelKey(group.label);
    let merged = mergedComponentGroups.get(key);
    if (!merged) {
      merged = { label: normalizeLabel(group.label), variants: new Map() };
      mergedComponentGroups.set(key, merged);
    }
    for (const variant of group.variants) {
      if (!merged.variants.has(variant.id)) merged.variants.set(variant.id, variant);
    }
  }

  const resolvedParentLabel =
    parentKindLabel ?? (subSetGroups.length > 0 ? "COMBO" : "FULL SET");

  const options: StorefrontProjectionOption[] = [
    // The parent set is the composite, and the policy passed in is the parent's.
    ...projectOptions(
      parentVariants,
      COMPOSITE_PARENT_KIND_KEY,
      resolvedParentLabel,
      null,
      pricingRule,
      sellingPolicy,
      true,
      availabilityDates,
    ),
  ];

  for (const subSet of subSetGroups) {
    options.push(
      ...projectOptions(
        subSet.variants,
        subSet.kindKey,
        subSet.label,
        null,
        pricingRule,
        sellingPolicy,
        true,
        availabilityDates,
      ),
    );
  }

  [...mergedComponentGroups.values()].forEach((group, index) => {
    options.push(
      ...projectOptions(
        [...group.variants.values()],
        `component-${index + 1}`,
        group.label,
        group.label.length === 0 ? "AMBIGUOUS_OPTION" : null,
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

  return { mode: "composite", options, colorDimensionLabel: resolvedColorDimensionLabel };
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

/**
 * The options a kind-bearing selection resolves within, narrowed kind → colour.
 *
 * A kind with exactly one colour resolves to it whatever was chosen; a chosen colour the kind does
 * not have resolves to none. `sizeOptions` are the options the size choice may land on: the chosen
 * colour's, or the whole kind's while its colour is still open.
 */
function resolveKindScope(
  options: readonly StorefrontProjectionOption[],
  selection: StorefrontProjectionSelection,
) {
  const kindOptions =
    selection.kindKey === null
      ? []
      : options.filter((option) => option.kindKey === selection.kindKey);
  const kindColors = uniqueValues(kindOptions, "color");
  const color =
    kindColors.length === 1
      ? kindColors[0]!
      : selection.color !== null && kindColors.includes(selection.color)
        ? selection.color
        : null;
  const sizeOptions =
    color === null ? kindOptions : kindOptions.filter((option) => option.color === color);
  return { kindOptions, kindColors, color, sizeOptions };
}

/**
 * The selection after the shopper changes kind or colour.
 *
 * Every downstream value that no longer exists under the new upstream choice is cleared, a kind's
 * only colour is chosen for the shopper, and whatever still exists is kept. Existence, not stock:
 * a sold-out size that exists stays selected so the shopper is told it is sold out, instead of the
 * choice silently disappearing. A product without kinds is returned unchanged.
 */
export function normalizeStorefrontProjectionSelection(
  options: readonly StorefrontProjectionOption[],
  selection: StorefrontProjectionSelection,
): StorefrontProjectionSelection {
  if (!options.some((option) => option.kindKey !== null)) return selection;
  if (
    selection.kindKey === null ||
    !options.some((option) => option.kindKey === selection.kindKey)
  ) {
    return { kindKey: null, color: null, size: null };
  }

  const { color, sizeOptions } = resolveKindScope(options, selection);
  const size =
    selection.size !== null && sizeOptions.some((option) => option.size === selection.size)
      ? selection.size
      : null;
  return { kindKey: selection.kindKey, color, size };
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
      resolvedColor: selection.color,
      // Kind → colour → size normalization is for kind-bearing products only; a product without
      // kinds keeps its existing selection behaviour unchanged.
      selectedCombinationMissing: false,
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

  const { kindOptions, kindColors, color, sizeOptions } = resolveKindScope(options, selection);

  /*
   * Within a kind, colour comes before size -- the order the panel draws them in (kind, colour,
   * size) and the order a standalone product already resolves in. A colour is offered whenever the
   * kind has a purchasable option in it, whatever size is chosen; the sizes then narrow to the
   * chosen colour. It used to be the other way round -- colour locked until a size was picked --
   * which, once colour sat above size, would have shown a shopper a locked row first.
   *
   * A kind with a single colour offers no choice: that colour is resolved for the shopper and the
   * selector is not drawn.
   */
  const hasColorOptions = kindColors.length > 1;
  const colors: StorefrontValueChoice[] = hasColorOptions
    ? kindColors.map((value) => ({
        value,
        disabled: !kindOptions.some((option) =>
          supportsProjectedSelection(option, {
            kindKey: selection.kindKey,
            color: value,
            size: null,
          }),
        ),
      }))
    : [];

  /*
   * Only sizes that exist for the chosen kind and colour are offered; a size that exists but cannot
   * be bought is offered disabled. So "this combination does not exist" and "this SKU is sold out"
   * never look the same. Before a kind is chosen every size is listed, disabled, as the cue that
   * the kind decides them.
   */
  const sizes: StorefrontValueChoice[] = uniqueValues(
    selection.kindKey === null ? options : sizeOptions,
    "size",
  ).map((value) => ({
    value,
    disabled:
      selection.kindKey === null ||
      !sizeOptions.some((option) => option.purchasable && option.size === value),
  }));

  const isSelectionComplete =
    selection.kindKey !== null && selection.size !== null && (!hasColorOptions || color !== null);
  const selected = isSelectionComplete
    ? sizeOptions.find((option) => option.size === selection.size && option.color === color) ?? null
    : null;

  return {
    hasKindOptions: true,
    kinds,
    hasColorOptions,
    colors,
    sizes,
    /** The colour the selection resolves with: the shopper's, or the kind's only one. */
    resolvedColor: color,
    /** A complete selection that names no real option, as opposed to a real one that is sold out. */
    selectedCombinationMissing: isSelectionComplete && selected === null,
    selectedVariantId: selected?.id ?? null,
    selectedPrice: selected?.price ?? null,
    selectedBasePriceVnd: selected?.basePriceVnd ?? null,
    selectedIsDiscounted: selected?.isDiscounted ?? false,
    selectedUnavailableReason: selected === null ? null : selected.unavailableReason,
    /** F8a / §30 — the selected option's own preorder classification, never re-derived. */
    selectedIsPreorderSale: selected?.isPreorderSale ?? false,
    /** I9 — owner rule 10, decided by the same helper the standalone path uses. */
    selectedAvailabilityDate: selectedAvailabilityDateOf(selected),
    canAdd: selected !== null && selected.purchasable,
  };
}
