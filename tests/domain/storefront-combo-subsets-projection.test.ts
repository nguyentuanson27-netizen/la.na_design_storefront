import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStorefrontProductProjection,
  deriveStorefrontProjectionSelection,
  type StorefrontCompositeSubSetGroup,
  type StorefrontCompositeComponentGroup,
} from "../../src/commerce/storefront-projection.ts";
import { buildStorefrontCartLines, type StorefrontCartProduct } from "../../src/commerce/storefront-cart.ts";
import type { StorefrontVariantFacts } from "../../src/commerce/storefront-product.ts";

function variant(
  id: string,
  size: string,
  retailPrice: number,
  overrides: Partial<StorefrontVariantFacts> = {},
): StorefrontVariantFacts {
  return {
    id,
    pancakeVariationId: `pancake-${id}`,
    color: null,
    size,
    sellableStock: 5,
    retailPrice,
    retailPriceAfterDiscount: retailPrice,
    ...overrides,
  };
}

test("storefront combo projection unifies parent combo, 2 subsets and 3 single pieces into 6 options", () => {
  const parentVariants = [
    variant("combo-m", "M", 749_000),
    variant("combo-l", "L", 749_000),
  ];

  const subSetGroups: StorefrontCompositeSubSetGroup[] = [
    {
      label: "SET VÁY",
      kindKey: "sub-set-vay",
      variants: [variant("set-vay-m", "M", 599_000)],
    },
    {
      label: "SET QUẦN",
      kindKey: "sub-set-quan",
      variants: [variant("set-quan-m", "M", 579_000)],
    },
  ];

  const componentGroups: StorefrontCompositeComponentGroup[] = [
    {
      label: "ÁO LẺ",
      variants: [variant("ao-m", "M", 429_000)],
    },
    {
      label: "CV LẺ",
      variants: [variant("cv-m", "M", 429_000)],
    },
    {
      label: "QUẦN LẺ",
      variants: [variant("quan-m", "M", 299_000)],
    },
  ];

  const projection = buildStorefrontProductProjection({
    parentVariants,
    subSetGroups,
    componentGroups,
    hasCompositeGraph: true,
  });

  assert.equal(projection.mode, "composite");

  // Derive selection with no initial choice
  const initialSelection = deriveStorefrontProjectionSelection(projection.options, {
    kindKey: null,
    color: null,
    size: null,
  });

  assert.equal(initialSelection.hasKindOptions, true);
  assert.deepEqual(
    initialSelection.kinds.map((k) => k.label),
    ["COMBO", "SET VÁY", "SET QUẦN", "ÁO LẺ", "CV LẺ", "QUẦN LẺ"],
  );

  // Select "SET VÁY" and size "M"
  const setVaySelection = deriveStorefrontProjectionSelection(projection.options, {
    kindKey: "sub-set-vay",
    color: null,
    size: "M",
  });

  assert.equal(setVaySelection.selectedVariantId, "set-vay-m");
  assert.equal(setVaySelection.selectedPrice, 599_000);
  assert.equal(setVaySelection.canAdd, true);

  // Select "QUẦN LẺ" and size "M"
  const quanSelection = deriveStorefrontProjectionSelection(projection.options, {
    kindKey: "component-3",
    color: null,
    size: "M",
  });

  assert.equal(quanSelection.selectedVariantId, "quan-m");
  assert.equal(quanSelection.selectedPrice, 299_000);
  assert.equal(quanSelection.canAdd, true);
});

test("storefront cart lines accepts a subset variant from an inactive sibling product when isSubSetAvailable is true", () => {
  const siblingSetProduct: StorefrontCartProduct = {
    slug: "set-vay-sv555",
    pancakeProductId: "pancake-sv555",
    name: "SET VAY SV555",
    isPresent: true,
    isActive: false, // Inactive on /shop to avoid duplicates
    variants: [
      {
        id: "var-sv555-m",
        pancakeVariationId: "pv-sv555-m",
        isPresent: true,
        isActive: true,
        isCompositeComponentAvailable: false,
        isSubSetAvailable: true, // Recognized as eligible subset of active COMBO 555
        color: null,
        size: "M",
        sellableStock: 9,
        retailPrice: 599_000,
        retailPriceAfterDiscount: 599_000,
      },
    ],
  };

  const lines = buildStorefrontCartLines({
    items: [{ variantId: "var-sv555-m", quantity: 1 }],
    products: [siblingSetProduct],
  });

  assert.equal(lines.length, 1);
  const line = lines[0];
  assert.equal(line.available, true);
  assert.equal(line.price, 599_000);
  assert.equal(line.pancakeVariationId, "pv-sv555-m");
  assert.equal(line.productName, "SET VAY SV555");
});
