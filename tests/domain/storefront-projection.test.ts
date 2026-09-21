import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStorefrontProductProjection,
  classifyCompositeComponentSku,
  deriveStorefrontProjectionSelection,
  resolveCompositeComponentGroupLabel,
} from "../../src/commerce/storefront-projection.ts";
import type { StorefrontVariantFacts } from "../../src/commerce/storefront-product.ts";
import { fixtureAvailability } from "../fixtures/storefront-projection-option.ts";

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
      availability: fixtureAvailability({
        purchasable: true,
        isPreorderSale: false,
        unavailableReason: null,
      }),
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
      { id: "set-m", kindKey: "parent", kindLabel: "FULL SET", size: "M", purchasable: true },
      { id: "set-l", kindKey: "parent", kindLabel: "FULL SET", size: "L", purchasable: true },
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
    { key: "parent", label: "FULL SET", disabled: false },
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
      { label: "ÁO LẺ", variants: [variant("component-a", "M")] },
      { label: " áo lẻ ", variants: [variant("component-b", "M")] },
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
 * Review 5233519975, Required, the observable half, as corrected by comment 5712402734.
 *
 * Compositeness is this module's fact, so the ADR 0014 restriction has to be enforced where the set
 * is told apart from its parts. But the *policy* is per `productId`, and my first version of this
 * test asserted the opposite: it expected the component to sell below zero under the parent's
 * `OVERSELL`, which is a child being sold on a policy nobody set for it. The assertion encoded the
 * bug rather than catching it, which is the failure mode a test like this is most prone to — so
 * both halves are pinned here, and both directions of each.
 */
test("an OVERSELL parent policy restricts the set and is not inherited by its components", () => {
  const projection = buildStorefrontProductProjection({
    parentVariants: [variant("set-m", "M", { sellableStock: -2 })],
    componentGroups: [{ label: "Áo", variants: [variant("shirt-m", "M", { sellableStock: -2 })] }],
    hasCompositeGraph: true,
    sellingPolicy: { sellingMode: "OVERSELL", negativeStockLimit: -20 },
  });

  const parent = projection.options.find((option) => option.kindKey === "parent");
  const component = projection.options.find((option) => option.kindKey === "component-1");

  // The parent: refused because ADR 0014 disables OVERSELL for a composite, not because of stock.
  assert.equal(parent?.purchasable, false, "ADR 0014 refuses OVERSELL for a composite parent");
  assert.equal(parent?.unavailableReason, "OUT_OF_STOCK");

  // The component: a different product, with no policy row of its own, so STANDARD floored at 0.
  // −2 is below that floor. It must not ride the parent's −20 allowance.
  assert.equal(
    component?.purchasable,
    false,
    "a component resolves its own policy, and absence means STANDARD",
  );
  assert.equal(component?.unavailableReason, "OUT_OF_STOCK");
  assert.equal(component?.isPreorderSale, false);

  // Both directions, so neither half can rot into "nothing is ever purchasable": at positive stock
  // under the default policy, parent and component both sell exactly as they did before I4.
  const standard = buildStorefrontProductProjection({
    parentVariants: [variant("set-m", "M")],
    componentGroups: [{ label: "Áo", variants: [variant("shirt-m", "M")] }],
    hasCompositeGraph: true,
  });
  assert.equal(standard.options.find((option) => option.kindKey === "parent")?.purchasable, true);
  assert.equal(
    standard.options.find((option) => option.kindKey === "component-1")?.purchasable,
    true,
  );

  // And the parent's OVERSELL is genuinely in play rather than ignored: the same policy on a
  // standalone product — no composite, no components — does sell at −2. Without this, the two
  // assertions above would pass even if `sellingPolicy` were dropped on the floor entirely.
  const standalone = buildStorefrontProductProjection({
    parentVariants: [variant("solo-m", "M", { sellableStock: -2 })],
    componentGroups: [],
    hasCompositeGraph: false,
    sellingPolicy: { sellingMode: "OVERSELL", negativeStockLimit: -20 },
  });
  assert.equal(standalone.options[0]?.purchasable, true);
});


test("composite child SKU classification is case-insensitive and fail-closed", () => {
  const cases = [
    ["AO-SD441", "ÁO LẺ"],
    ["xxao123", "ÁO LẺ"],
    ["QUAN-QD001", "QUẦN LẺ"],
    ["abc-quan-xl", "QUẦN LẺ"],
    ["CV001", "CV LẺ"],
    ["VAY-001", "CV LẺ"],
    ["cv-vay-001", "CV LẺ"],
    [null, null],
    ["", null],
    ["   ", null],
    ["ABC123", null],
    ["AO-QUAN-01", null],
    ["AO-VAY-01", null],
    ["QUAN-CV-01", null],
  ] as const;

  for (const [sku, expected] of cases) {
    assert.equal(classifyCompositeComponentSku(sku), expected, String(sku));
  }
});


test("composite child group validation fails closed for malformed or mixed-role SKUs", () => {
  assert.equal(resolveCompositeComponentGroupLabel(["AO-S", "AO-M", "AO-L"]), "ÁO LẺ");
  assert.equal(resolveCompositeComponentGroupLabel(["AO-S", "QUAN-M"]), null);
  assert.equal(resolveCompositeComponentGroupLabel(["AO-S", null]), null);
  assert.equal(resolveCompositeComponentGroupLabel(["CV-S", "VAY-M", "cv-vay-l"]), "CV LẺ");
});
