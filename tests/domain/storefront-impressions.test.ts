import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStorefrontProductImpression,
  buildStorefrontProductImpressionFromOptions,
  buildStorefrontProductImpressions,
} from "../../src/commerce/storefront-impressions.ts";
import type { StorefrontVariantFacts } from "../../src/commerce/storefront-product.ts";

function variant(overrides: Partial<StorefrontVariantFacts> = {}): StorefrontVariantFacts {
  return {
    id: "variant-mirror-cuid",
    pancakeVariationId: "pancake-variation-1",
    color: "Navy",
    size: "M",
    sellableStock: 5,
    retailPrice: 490_000,
    retailPriceAfterDiscount: 490_000,
    ...overrides,
  };
}

test("T5 one rendered card produces one product impression, not one per variant", () => {
  const impressions = buildStorefrontProductImpressions({
    products: [
      {
        pancakeProductId: "pancake-product-1",
        name: "Linen Shirt",
        variants: [
          variant({ id: "a", pancakeVariationId: "pv-a", size: "S" }),
          variant({ id: "b", pancakeVariationId: "pv-b", size: "M" }),
          variant({ id: "c", pancakeVariationId: "pv-c", size: "L" }),
        ],
      },
    ],
  });

  assert.equal(impressions.length, 1);
  assert.equal(impressions[0]?.productExternalId, "pancake-product-1");
  const serialized = JSON.stringify(impressions);
  for (const variationId of ["pv-a", "pv-b", "pv-c"]) {
    assert.equal(serialized.includes(variationId), false, "an impression never names a variation");
  }
});

test("T5 an impression identifies a product by pancakeProductId, never by a local id or slug", () => {
  const impression = buildStorefrontProductImpression({
    product: {
      pancakeProductId: "pancake-product-1",
      name: "Linen Shirt",
      variants: [variant()],
    },
  });

  assert.equal(impression?.productExternalId, "pancake-product-1");
  const serialized = JSON.stringify(impression);
  assert.equal(serialized.includes("variant-mirror-cuid"), false);
  assert.equal(serialized.includes("pancake-variation-1"), false);
});

test("T5 one common resolved price is reported exactly", () => {
  const impression = buildStorefrontProductImpression({
    product: {
      pancakeProductId: "pancake-product-1",
      name: "Linen Shirt",
      variants: [
        variant({ id: "a", pancakeVariationId: "pv-a", size: "S" }),
        variant({ id: "b", pancakeVariationId: "pv-b", size: "M" }),
      ],
    },
  });

  assert.equal(impression?.exactPriceVnd, 490_000);
  assert.equal(impression?.minimumPriceVnd, undefined);
  assert.equal(impression?.maximumPriceVnd, undefined);
});

test("T5 a price range stays a range and never becomes an exact vendor price", () => {
  const impression = buildStorefrontProductImpression({
    product: {
      pancakeProductId: "pancake-product-1",
      name: "Linen Shirt",
      variants: [
        variant({
          id: "a",
          pancakeVariationId: "pv-a",
          size: "S",
          retailPrice: 390_000,
          retailPriceAfterDiscount: 390_000,
        }),
        variant({ id: "b", pancakeVariationId: "pv-b", size: "M" }),
      ],
    },
  });

  assert.equal(impression?.exactPriceVnd, undefined, "the minimum is not the selected price");
  assert.deepEqual(
    { minimum: impression?.minimumPriceVnd, maximum: impression?.maximumPriceVnd },
    { minimum: 390_000, maximum: 490_000 },
  );
});

test("T5 a product with no resolvable price carries no money at all", () => {
  const impression = buildStorefrontProductImpression({
    product: {
      pancakeProductId: "pancake-product-1",
      name: "Linen Shirt",
      variants: [variant({ retailPrice: null, retailPriceAfterDiscount: null })],
    },
  });

  assert.deepEqual(impression, { productExternalId: "pancake-product-1", itemName: "Linen Shirt" });
});

test("T5 a product with no usable identity or name produces no impression", () => {
  for (const product of [
    { pancakeProductId: "  ", name: "Linen Shirt", variants: [variant()] },
    { pancakeProductId: "pancake-product-1", name: "   ", variants: [variant()] },
  ]) {
    assert.equal(buildStorefrontProductImpression({ product }), null);
  }

  assert.deepEqual(
    buildStorefrontProductImpressions({
      products: [
        { pancakeProductId: "", name: "Dropped", variants: [variant()] },
        { pancakeProductId: "pancake-product-2", name: "Kept", variants: [variant()] },
      ],
    }).map((impression) => impression.productExternalId),
    ["pancake-product-2"],
  );
});

test("T5 list context and position travel with each impression", () => {
  const impressions = buildStorefrontProductImpressions({
    products: [
      { pancakeProductId: "p-1", name: "First", variants: [variant()] },
      { pancakeProductId: "p-2", name: "Second", variants: [variant()] },
    ],
    list: { listId: "shop", listName: "Cửa hàng" },
  });

  assert.deepEqual(
    impressions.map(({ listId, listName, index }) => ({ listId, listName, index })),
    [
      { listId: "shop", listName: "Cửa hàng", index: 0 },
      { listId: "shop", listName: "Cửa hàng", index: 1 },
    ],
  );
});

test("T5 a product page impression uses the projection the page rendered", () => {
  const impression = buildStorefrontProductImpressionFromOptions({
    pancakeProductId: "pancake-product-1",
    name: "Linen Shirt",
    options: [{ price: 450_000 }, { price: 450_000 }, { price: null }],
  });

  assert.equal(impression?.exactPriceVnd, 450_000, "an unpriceable option does not widen a range");
});

test("T5 a Flash card's impression uses the Flash representative, not the ordinary variant set", () => {
  // The U17 mixed case: an ordinary variant at 300k and a Flash variant at 500k discounted 20% to
  // 400k. The card renders the 400k representative; the ordinary option set would say 300k–500k.
  const mixed = {
    pancakeProductId: "pancake-product-1",
    name: "Linen Shirt",
    variants: [
      variant({
        id: "ordinary",
        pancakeVariationId: "pv-ordinary",
        size: "S",
        retailPrice: 300_000,
        retailPriceAfterDiscount: 300_000,
      }),
      variant({
        id: "flash",
        pancakeVariationId: "pv-flash",
        size: "M",
        retailPrice: 500_000,
        retailPriceAfterDiscount: 500_000,
      }),
    ],
  };

  const withoutFlash = buildStorefrontProductImpression({ product: mixed });
  assert.deepEqual(
    { minimum: withoutFlash?.minimumPriceVnd, maximum: withoutFlash?.maximumPriceVnd },
    { minimum: 300_000, maximum: 500_000 },
    "the ordinary listing keeps its ordinary option range",
  );

  // The Flash card reads "Sale từ 400.000": 400k is the cheapest Flash price and something cheaper
  // exists besides, so it is neither an exact price nor a range the server has bounded. Reporting
  // 300k–500k here would publish money the Flash card never showed.
  const flashFrom = buildStorefrontProductImpression({
    product: {
      ...mixed,
      flashSale: { effectivePriceVnd: 400_000, hasCheaperCurrentVariant: true },
    },
  });
  assert.deepEqual(flashFrom, {
    productExternalId: "pancake-product-1",
    itemName: "Linen Shirt",
  });

  // With nothing cheaper the card shows one exact Flash price, and so does the impression.
  const flashExact = buildStorefrontProductImpression({
    product: {
      ...mixed,
      flashSale: { effectivePriceVnd: 400_000, hasCheaperCurrentVariant: false },
    },
  });
  assert.equal(flashExact?.exactPriceVnd, 400_000);
  assert.equal(flashExact?.minimumPriceVnd, undefined);
});

test("T5 an unusable Flash representative price carries no money rather than a bad one", () => {
  for (const effectivePriceVnd of [Number.NaN, -1, 400_000.5, Number.MAX_SAFE_INTEGER + 2]) {
    const impression = buildStorefrontProductImpression({
      product: {
        pancakeProductId: "pancake-product-1",
        name: "Linen Shirt",
        variants: [variant()],
        flashSale: { effectivePriceVnd, hasCheaperCurrentVariant: false },
      },
    });
    assert.deepEqual(impression, {
      productExternalId: "pancake-product-1",
      itemName: "Linen Shirt",
    });
  }
});

test("a grid showing a later page numbers its impressions on from the pages before it", () => {
  const products = ["a", "b"].map((id) => ({
    pancakeProductId: `pancake-product-${id}`,
    name: `Shirt ${id}`,
    variants: [variant({ id, pancakeVariationId: `pv-${id}` })],
  }));

  assert.deepEqual(
    buildStorefrontProductImpressions({ products }).map((impression) => impression.index),
    [0, 1],
    "without a start index the list begins at 0",
  );
  assert.deepEqual(
    buildStorefrontProductImpressions({ products, startIndex: 24 }).map((impression) => impression.index),
    [24, 25],
  );
});
