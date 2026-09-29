import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStorefrontProductProjection,
  selectStorefrontProductLevelOptions,
  type StorefrontCompositeComponentGroup,
  type StorefrontProductProjection,
} from "../../src/commerce/storefront-projection.ts";
import type { StorefrontVariantFacts } from "../../src/commerce/storefront-product.ts";
import { createStorefrontPurchaseService } from "../../src/commerce/storefront-purchase.ts";
import {
  MISSING_COMBINATION_MESSAGE,
  resolveMobilePurchasePresentation,
  resolveSelectionAfterColorChange,
  resolveSelectionAfterKindChange,
  resolveVariantSelectionView,
  type VariantSelectionState,
} from "../../src/components/headless/variant-selection-model.ts";

/**
 * PDP variant normalization: Loại → màu quần → size, by logical kind rather than by the Pancake
 * source product a variant happens to live in.
 */

function variant(
  id: string,
  color: string | null,
  size: string,
  overrides: Partial<StorefrontVariantFacts> = {},
): StorefrontVariantFacts {
  return {
    id,
    pancakeVariationId: `pancake-${id}`,
    color,
    size,
    sellableStock: 3,
    retailPrice: 500_000,
    retailPriceAfterDiscount: 500_000,
    ...overrides,
  };
}

const soldOut = { sellableStock: 0 } as const;

/** Two Pancake source products, both `QUẦN LẺ`: one per pants colour. */
const PANTS_BLACK_SOURCE: StorefrontCompositeComponentGroup = {
  label: "QUẦN LẺ",
  variants: [variant("pants-black-s", "Đen", "S"), variant("pants-black-m", "Đen", "M")],
};
const PANTS_WHITE_SOURCE: StorefrontCompositeComponentGroup = {
  label: "QUẦN LẺ",
  variants: [
    variant("pants-white-m", "Trắng", "M"),
    variant("pants-white-l", "Trắng", "L", soldOut),
  ],
};
const TOP_SOURCE: StorefrontCompositeComponentGroup = {
  label: "ÁO LẺ",
  variants: [variant("top-s", null, "S"), variant("top-m", null, "M")],
};

function build({
  parentVariants = [
    variant("set-black-m", "Đen", "M"),
    variant("set-white-m", "Trắng", "M"),
    variant("set-white-xl", "Trắng", "XL", soldOut),
  ],
  componentGroups = [TOP_SOURCE, PANTS_BLACK_SOURCE, PANTS_WHITE_SOURCE],
  colorDimensionLabel,
}: {
  parentVariants?: StorefrontVariantFacts[];
  componentGroups?: StorefrontCompositeComponentGroup[];
  colorDimensionLabel?: string;
} = {}): StorefrontProductProjection {
  return buildStorefrontProductProjection({
    parentVariants,
    componentGroups,
    hasCompositeGraph: true,
    ...(colorDimensionLabel === undefined ? {} : { colorDimensionLabel }),
  });
}

function view(projection: StorefrontProductProjection, selection: VariantSelectionState) {
  return resolveVariantSelectionView({
    options: projection.options,
    productLevelOptions: selectStorefrontProductLevelOptions(projection),
    selection,
    colorDimensionLabel: projection.colorDimensionLabel,
  });
}

function kindKeyOf(projection: StorefrontProductProjection, label: string): string {
  const key = projection.options.find((option) => option.kindLabel === label)?.kindKey;
  assert.ok(key, `kind ${label} is projected`);
  return key;
}

const NOTHING: VariantSelectionState = { kindKey: null, color: null, size: null };

/* ------------------------------------------------------------ aggregation by kind */

test("several Quần lẻ source products are one kind, aggregating every variant behind it", () => {
  const projection = build();
  const initial = view(projection, NOTHING);

  assert.deepEqual(
    initial.kinds.map((kind) => kind.label),
    ["FULL SET", "ÁO LẺ", "QUẦN LẺ"],
    "one Quần lẻ button, not one per source product",
  );

  const pantsKey = kindKeyOf(projection, "QUẦN LẺ");
  const pantsOptions = projection.options.filter((option) => option.kindKey === pantsKey);
  // Aggregated, not label-deduplicated: all four source variants sit behind the one kind, each
  // with its own real id and stock, and none is failed closed merely for sharing the label.
  assert.deepEqual(
    pantsOptions.map(({ id, color, size, purchasable, unavailableReason }) => ({
      id, color, size, purchasable, unavailableReason,
    })),
    [
      { id: "pants-black-s", color: "Đen", size: "S", purchasable: true, unavailableReason: null },
      { id: "pants-black-m", color: "Đen", size: "M", purchasable: true, unavailableReason: null },
      { id: "pants-white-m", color: "Trắng", size: "M", purchasable: true, unavailableReason: null },
      {
        id: "pants-white-l", color: "Trắng", size: "L",
        purchasable: false, unavailableReason: "OUT_OF_STOCK",
      },
    ],
  );

  // Colour → the right source product's variant.
  assert.equal(
    view(projection, { kindKey: pantsKey, color: "Đen", size: "M" }).selectedVariantId,
    "pants-black-m",
  );
  assert.equal(
    view(projection, { kindKey: pantsKey, color: "Trắng", size: "M" }).selectedVariantId,
    "pants-white-m",
  );
});

test("a colour and size that two source products both claim fails closed instead of picking one", () => {
  const projection = build({
    componentGroups: [
      PANTS_BLACK_SOURCE,
      { label: " quần lẻ ", variants: [variant("pants-other-black-m", "Đen", "M")] },
    ],
  });
  const pantsKey = kindKeyOf(projection, "QUẦN LẺ");

  const collided = projection.options.filter((option) =>
    ["pants-black-m", "pants-other-black-m"].includes(option.id),
  );
  assert.equal(collided.length, 2);
  assert.ok(collided.every((option) => option.unavailableReason === "AMBIGUOUS_OPTION"));
  assert.equal(
    projection.options.find((option) => option.id === "pants-black-s")?.purchasable,
    true,
    "the rest of the kind stays purchasable",
  );

  const selected = view(projection, { kindKey: pantsKey, color: "Đen", size: "M" });
  assert.equal(selected.canAdd, false);
  assert.equal(selected.unavailableMessage, "Lựa chọn này hiện chưa mua được.");
});

/* ------------------------------------------------------------- colour per kind */

test("Áo lẻ never shows a pants colour", () => {
  // Even on a product whose product-level label reads "Màu quần".
  const projection = build({ colorDimensionLabel: "Màu quần" });
  const topKey = kindKeyOf(projection, "ÁO LẺ");

  const top = view(projection, { kindKey: topKey, color: null, size: null });
  assert.equal(top.hasColorOptions, false);
  assert.deepEqual(top.colors, []);
  assert.notEqual(top.colorDimensionLabel, "Màu quần");
  assert.notEqual(top.colorDimensionLabel, "Màu quần đi kèm");
  assert.equal(
    resolveMobilePurchasePresentation(top, { kindKey: topKey, color: null, size: null }).actionLabel,
    "Chọn phân loại / size",
  );
  assert.equal(
    view(projection, { kindKey: topKey, color: null, size: "M" }).selectedVariantId,
    "top-m",
  );

  // An Áo lẻ with several colours of its own still does not call them pants colours.
  const multiColourTop = build({
    colorDimensionLabel: "Màu quần",
    componentGroups: [
      {
        label: "ÁO LẺ",
        variants: [variant("top-red-m", "Đỏ", "M"), variant("top-blue-m", "Xanh", "M")],
      },
    ],
  });
  const multi = view(multiColourTop, {
    kindKey: kindKeyOf(multiColourTop, "ÁO LẺ"),
    color: null,
    size: null,
  });
  assert.equal(multi.hasColorOptions, true);
  assert.equal(multi.colorDimensionLabel, "Màu");
});

test("Full set with more than one colour asks for Màu quần đi kèm", () => {
  const projection = build();
  const set = view(projection, { kindKey: "parent", color: null, size: null });

  assert.equal(set.hasColorOptions, true);
  assert.equal(set.colorDimensionLabel, "Màu quần đi kèm");
  assert.deepEqual(set.colors.map((choice) => choice.value), ["Đen", "Trắng"]);
});

test("Full set with a single colour auto-selects it and hides the selector", () => {
  const projection = build({
    parentVariants: [variant("set-black-m", "Đen", "M"), variant("set-black-l", "Đen", "L")],
  });

  const set = view(projection, { kindKey: "parent", color: null, size: null });
  assert.equal(set.hasColorOptions, false);
  assert.deepEqual(set.colors, []);
  assert.equal(set.resolvedColor, "Đen");

  // Size alone completes the selection, onto the real set variant.
  const chosen = view(projection, { kindKey: "parent", color: null, size: "L" });
  assert.equal(chosen.selectedVariantId, "set-black-l");
  assert.equal(chosen.canAdd, true);
  assert.equal(
    resolveMobilePurchasePresentation(chosen, { kindKey: "parent", color: null, size: "L" }).summary,
    "FULL SET · Đen · L",
  );
});

test("Quần lẻ with more than one colour asks for Màu quần; with one it auto-selects", () => {
  const projection = build();
  const pantsKey = kindKeyOf(projection, "QUẦN LẺ");
  const pants = view(projection, { kindKey: pantsKey, color: null, size: null });
  assert.equal(pants.hasColorOptions, true);
  assert.equal(pants.colorDimensionLabel, "Màu quần");
  assert.deepEqual(pants.colors, [
    { value: "Đen", disabled: false },
    { value: "Trắng", disabled: false },
  ]);

  const oneColour = build({ componentGroups: [PANTS_BLACK_SOURCE] });
  const oneKey = kindKeyOf(oneColour, "QUẦN LẺ");
  const single = view(oneColour, { kindKey: oneKey, color: null, size: "S" });
  assert.equal(single.hasColorOptions, false);
  assert.equal(single.resolvedColor, "Đen");
  assert.equal(single.selectedVariantId, "pants-black-s");
});

/* ------------------------------------------------------------ size from kind + colour */

test("sizes are derived from the chosen kind and colour, never the whole product", () => {
  const projection = build();
  const pantsKey = kindKeyOf(projection, "QUẦN LẺ");
  const topKey = kindKeyOf(projection, "ÁO LẺ");

  assert.deepEqual(view(projection, { kindKey: pantsKey, color: "Đen", size: null }).sizes, [
    { value: "S", disabled: false },
    { value: "M", disabled: false },
  ]);
  assert.deepEqual(view(projection, { kindKey: pantsKey, color: "Trắng", size: null }).sizes, [
    { value: "M", disabled: false },
    { value: "L", disabled: true },
  ]);
  // The set's XL does not leak into the loose top, nor the pants' L.
  assert.deepEqual(
    view(projection, { kindKey: topKey, color: null, size: null }).sizes.map((size) => size.value),
    ["S", "M"],
  );
  assert.deepEqual(view(projection, { kindKey: "parent", color: "Trắng", size: null }).sizes, [
    { value: "M", disabled: false },
    { value: "XL", disabled: true },
  ]);
});

/* ----------------------------------------------------- downstream invalidation */

test("changing kind keeps what still exists, clears what does not, and auto-selects a sole colour", () => {
  const projection = build();
  const options = projection.options;
  const pantsKey = kindKeyOf(projection, "QUẦN LẺ");
  const topKey = kindKeyOf(projection, "ÁO LẺ");

  // Full set Trắng/M → Quần lẻ: Trắng M exists there too, so both carry over.
  assert.deepEqual(
    resolveSelectionAfterKindChange({
      options,
      selection: { kindKey: "parent", color: "Trắng", size: "M" },
      kindKey: pantsKey,
    }),
    { kindKey: pantsKey, color: "Trắng", size: "M" },
  );

  // Full set Trắng/XL → Quần lẻ: no XL pants, so the size is cleared, the colour kept.
  assert.deepEqual(
    resolveSelectionAfterKindChange({
      options,
      selection: { kindKey: "parent", color: "Trắng", size: "XL" },
      kindKey: pantsKey,
    }),
    { kindKey: pantsKey, color: "Trắng", size: null },
  );

  // Quần lẻ Đen/S → Áo lẻ: the top has no colour axis, so the pants colour does not follow.
  assert.deepEqual(
    resolveSelectionAfterKindChange({
      options,
      selection: { kindKey: pantsKey, color: "Đen", size: "S" },
      kindKey: topKey,
    }),
    { kindKey: topKey, color: null, size: "S" },
  );

  // Into a single-colour kind, the colour is chosen for the shopper.
  const oneColour = build({ componentGroups: [TOP_SOURCE, PANTS_BLACK_SOURCE] });
  const oneKey = kindKeyOf(oneColour, "QUẦN LẺ");
  assert.deepEqual(
    resolveSelectionAfterKindChange({
      options: oneColour.options,
      selection: { kindKey: kindKeyOf(oneColour, "ÁO LẺ"), color: null, size: "M" },
      kindKey: oneKey,
    }),
    { kindKey: oneKey, color: "Đen", size: "M" },
  );
});

test("changing colour clears a size that colour does not come in", () => {
  const projection = build();
  const pantsKey = kindKeyOf(projection, "QUẦN LẺ");

  assert.deepEqual(
    resolveSelectionAfterColorChange({
      options: projection.options,
      selection: { kindKey: pantsKey, color: "Trắng", size: "L" },
      color: "Đen",
    }),
    { kindKey: pantsKey, color: "Đen", size: null },
  );
  assert.deepEqual(
    resolveSelectionAfterColorChange({
      options: projection.options,
      selection: { kindKey: pantsKey, color: "Trắng", size: "M" },
      color: "Đen",
    }),
    { kindKey: pantsKey, color: "Đen", size: "M" },
  );
});

/* ------------------------------------------------- missing vs sold out */

test("a combination that does not exist is told apart from a SKU that exists but is sold out", () => {
  const projection = build();
  const pantsKey = kindKeyOf(projection, "QUẦN LẺ");

  const soldOutSku = view(projection, { kindKey: pantsKey, color: "Trắng", size: "L" });
  assert.equal(soldOutSku.selectedVariantId, "pants-white-l");
  assert.equal(soldOutSku.selectedUnavailableReason, "OUT_OF_STOCK");
  assert.equal(soldOutSku.selectedCombinationMissing, false);
  assert.equal(soldOutSku.unavailableMessage, "Lựa chọn này đã hết hàng.");
  assert.equal(soldOutSku.canAdd, false);

  const missing = view(projection, { kindKey: pantsKey, color: "Đen", size: "L" });
  assert.equal(missing.selectedVariantId, null);
  assert.equal(missing.selectedUnavailableReason, null);
  assert.equal(missing.selectedCombinationMissing, true);
  assert.equal(missing.unavailableMessage, MISSING_COMBINATION_MESSAGE);
  assert.equal(missing.canAdd, false);

  // An incomplete selection is neither.
  const incomplete = view(projection, { kindKey: pantsKey, color: null, size: "M" });
  assert.equal(incomplete.selectedCombinationMissing, false);
  assert.equal(incomplete.unavailableMessage, "");
});

/* --------------------------------------------------- the real SKU reaches the cart */

test("the final selection resolves to the real source variant the cart pre-check authorizes", async () => {
  const projection = build();
  const pantsKey = kindKeyOf(projection, "QUẦN LẺ");
  const added: string[] = [];
  const service = createStorefrontPurchaseService({
    catalog: {
      async getProductBySlug() {
        return { variants: [], projection };
      },
    },
    async addUnit({ variantId }: { variantId: string }) {
      added.push(variantId);
      return { ok: true as const };
    },
  });

  const white = view(projection, { kindKey: pantsKey, color: "Trắng", size: "M" });
  assert.equal(white.canAdd, true);
  assert.deepEqual(
    await service.add({ shopId: 1, slug: "set", variantId: white.selectedVariantId! }),
    { ok: true },
  );

  const soldOutSku = view(projection, { kindKey: pantsKey, color: "Trắng", size: "L" });
  assert.deepEqual(
    await service.add({ shopId: 1, slug: "set", variantId: soldOutSku.selectedVariantId! }),
    { ok: false, reason: "VARIANT_UNAVAILABLE" },
  );

  assert.deepEqual(added, ["pants-white-m"], "the source SKU itself, never a synthetic id");
});
