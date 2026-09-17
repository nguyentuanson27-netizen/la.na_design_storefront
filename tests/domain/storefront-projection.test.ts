import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStorefrontProductProjection,
  deriveStorefrontProjectionSelection,
} from "../../src/commerce/storefront-projection.ts";
import type { StorefrontVariantFacts } from "../../src/commerce/storefront-product.ts";

function variant(
  id: string,
  size: string,
  overrides: Partial<StorefrontVariantFacts> = {},
): StorefrontVariantFacts {
  return {
    id,
    pancakeVariationId: `pancake-${id}`,
    color: null,
    size,
    sellableStock: 2,
    retailPrice: 590_000,
    retailPriceAfterDiscount: 590_000,
    ...overrides,
  };
}

test("storefront projection keeps standalone products on the existing size/color model", () => {
  const projection = buildStorefrontProductProjection({
    parentVariants: [variant("standalone-m", "M")],
    componentGroups: [],
    hasCompositeGraph: false,
  });

  assert.equal(projection.mode, "standalone");
  assert.deepEqual(projection.options, [
    {
      id: "standalone-m",
      pancakeVariationId: "pancake-standalone-m",
      color: null,
      size: "M",
      price: 590_000,
      basePriceVnd: null,
      isDiscounted: false,
      purchasable: true,
      isPreorderSale: false,
      unavailableReason: null,
      kindKey: null,
      kindLabel: null,
    },
  ]);

  const selection = deriveStorefrontProjectionSelection(projection.options, {
    kindKey: null,
    color: null,
    size: "M",
  });
  assert.equal(selection.hasKindOptions, false);
  assert.equal(selection.selectedVariantId, "standalone-m");
  assert.equal(selection.canAdd, true);
});

test("composite projection exposes real parent and component variants as separate Loai choices", () => {
  const projection = buildStorefrontProductProjection({
    parentVariants: [variant("set-m", "M"), variant("set-l", "L")],
    componentGroups: [
      {
        label: "Ao A",
        variants: [variant("shirt-m", "M"), variant("shirt-l", "L")],
      },
      {
        label: "Quan A",
        variants: [variant("pants-m", "M"), variant("pants-l", "L")],
      },
    ],
    hasCompositeGraph: true,
  });

  assert.equal(projection.mode, "composite");
  assert.deepEqual(
    projection.options.map(({ id, kindKey, kindLabel, size, purchasable }) => ({
      id,
      kindKey,
      kindLabel,
      size,
      purchasable,
    })),
    [
      { id: "set-m", kindKey: "parent", kindLabel: "Set", size: "M", purchasable: true },
      { id: "set-l", kindKey: "parent", kindLabel: "Set", size: "L", purchasable: true },
      {
        id: "shirt-m",
        kindKey: "component-1",
        kindLabel: "Ao A",
        size: "M",
        purchasable: true,
      },
      {
        id: "shirt-l",
        kindKey: "component-1",
        kindLabel: "Ao A",
        size: "L",
        purchasable: true,
      },
      {
        id: "pants-m",
        kindKey: "component-2",
        kindLabel: "Quan A",
        size: "M",
        purchasable: true,
      },
      {
        id: "pants-l",
        kindKey: "component-2",
        kindLabel: "Quan A",
        size: "L",
        purchasable: true,
      },
    ],
  );

  const initial = deriveStorefrontProjectionSelection(projection.options, {
    kindKey: null,
    color: null,
    size: null,
  });
  assert.equal(initial.hasKindOptions, true);
  assert.deepEqual(initial.kinds, [
    { key: "parent", label: "Set", disabled: false },
    { key: "component-1", label: "Ao A", disabled: false },
    { key: "component-2", label: "Quan A", disabled: false },
  ]);
  assert.equal(initial.canAdd, false);

  const shirt = deriveStorefrontProjectionSelection(projection.options, {
    kindKey: "component-1",
    color: null,
    size: "L",
  });
  assert.equal(shirt.selectedVariantId, "shirt-l");
  assert.equal(shirt.canAdd, true);
});

test("composite projection does not infer or synthesize component identity", () => {
  const projection = buildStorefrontProductProjection({
    parentVariants: [variant("set-m", "M")],
    componentGroups: [
      {
        label: "Ao A",
        variants: [variant("real-component", "M")],
      },
    ],
    hasCompositeGraph: true,
  });

  const ids = projection.options.map((option) => option.id);
  assert.deepEqual(ids, ["set-m", "real-component"]);
  assert.equal(ids.some((id) => id.includes("synthetic")), false);
});

test("duplicate component labels fail closed instead of presenting indistinguishable purchasable kinds", () => {
  const projection = buildStorefrontProductProjection({
    parentVariants: [variant("set-m", "M")],
    componentGroups: [
      { label: "Ao A", variants: [variant("component-a", "M")] },
      { label: " ao a ", variants: [variant("component-b", "M")] },
    ],
    hasCompositeGraph: true,
  });

  const components = projection.options.filter((option) => option.kindKey !== "parent");
  assert.equal(components.length, 2);
  assert.equal(components.every((option) => option.purchasable === false), true);
  assert.equal(
    components.every((option) => option.unavailableReason === "AMBIGUOUS_OPTION"),
    true,
  );
});

/**
 * Review 5233519975, Required, the observable half. Compositeness is this module's fact, so the
 * restriction has to be enforced where the set is told apart from its parts. Without the flag
 * flowing, an `OVERSELL` parent would have been offered below zero on the page and refused at the
 * commit boundary by the same rule — display and gate disagreeing, which is what I4 removes.
 */
test("an OVERSELL policy sells a component below zero but never the composite parent", () => {
  const projection = buildStorefrontProductProjection({
    parentVariants: [variant("set-m", "M", { sellableStock: -2 })],
    componentGroups: [{ label: "Áo", variants: [variant("shirt-m", "M", { sellableStock: -2 })] }],
    hasCompositeGraph: true,
    sellingPolicy: { sellingMode: "OVERSELL", negativeStockLimit: -20 },
  });

  const parent = projection.options.find((option) => option.kindKey === "parent");
  const component = projection.options.find((option) => option.kindKey === "component-1");

  // Same stock, same limit, same policy. The only difference is which side of the set it is on.
  assert.equal(parent?.purchasable, false, "ADR 0014 refuses OVERSELL for a composite parent");
  assert.equal(parent?.unavailableReason, "OUT_OF_STOCK");
  assert.equal(component?.purchasable, true, "a component is an ordinary product and is not restricted");

  // Both directions, so this cannot rot into "the parent is never purchasable": under the default
  // STANDARD policy at positive stock the parent sells exactly as it did before I4.
  const standard = buildStorefrontProductProjection({
    parentVariants: [variant("set-m", "M")],
    componentGroups: [{ label: "Áo", variants: [variant("shirt-m", "M")] }],
    hasCompositeGraph: true,
  });
  assert.equal(
    standard.options.find((option) => option.kindKey === "parent")?.purchasable,
    true,
  );
});
