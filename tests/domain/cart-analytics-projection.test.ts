import assert from "node:assert/strict";
import test from "node:test";

import { buildCanonicalCartAnalyticsProjection } from "../../src/commerce/cart-analytics-projection.ts";
import { buildCartAnalyticsItemFacts } from "../../src/commerce/cart-analytics-facts.ts";
import type { StorefrontCartLine } from "../../src/commerce/storefront-cart.ts";

function line(overrides: Partial<StorefrontCartLine> = {}): StorefrontCartLine {
  return {
    variantId: "variant-mirror-cuid",
    pancakeVariationId: "pancake-variation-1",
    pancakeProductId: "pancake-product-1",
    productSlug: "linen-shirt",
    productName: "Linen Shirt",
    color: "Navy",
    size: "M",
    quantity: 2,
    price: 490_000,
    available: true,
    isPreorderSale: false,
    unavailableReason: null,
    media: { primary: null, gallery: [] },
    ...overrides,
  };
}

test("T6 a fully safe cart projects every line with external identity and server money", () => {
  const projection = buildCanonicalCartAnalyticsProjection([
    line(),
    line({
      variantId: "variant-mirror-cuid-2",
      pancakeVariationId: "pancake-variation-2",
      productName: "Wool Coat",
      quantity: 1,
      price: 1_200_000,
      size: "L",
    }),
  ]);

  assert.deepEqual(projection?.items, [
    {
      variantExternalId: "pancake-variation-1",
      productExternalId: "pancake-product-1",
      itemName: "Linen Shirt",
      unitPriceVnd: 490_000,
      quantity: 2,
      color: "Navy",
      size: "M",
    },
    {
      variantExternalId: "pancake-variation-2",
      productExternalId: "pancake-product-1",
      itemName: "Wool Coat",
      unitPriceVnd: 1_200_000,
      quantity: 1,
      color: "Navy",
      size: "L",
    },
  ]);
  assert.equal(projection?.currency, "VND");
  assert.equal(
    projection?.merchandiseValueVnd,
    490_000 * 2 + 1_200_000,
    "the value is the exact sum over the complete emitted item set",
  );
});

test("T6 a composite component line carries the component's own external variation identity", () => {
  // A component sold through another public parent: its owning product is private, so the line has
  // no public product identity, but the variation the buyer committed to is real.
  const projection = buildCanonicalCartAnalyticsProjection([
    line({ pancakeProductId: null, productSlug: null, pancakeVariationId: "pancake-component-7" }),
  ]);

  assert.equal(projection?.items[0]?.variantExternalId, "pancake-component-7");
  assert.equal(projection?.items[0]?.productExternalId, undefined);
});

test("T6 one unsafe line suppresses the entire projection, with no partial items or totals", () => {
  const safe = line();
  const unsafeCases: Array<[string, StorefrontCartLine]> = [
    ["no external variation identity", line({ pancakeVariationId: null, quantity: 1 })],
    ["unresolved price", line({ price: null, quantity: 1, available: false })],
    ["negative price", line({ price: -1, quantity: 1 })],
    ["fractional price", line({ price: 490_000.5, quantity: 1 })],
    ["missing name", line({ productName: null, quantity: 1 })],
    ["blank name", line({ productName: "   ", quantity: 1 })],
    ["zero quantity", line({ quantity: 0 })],
    ["fractional quantity", line({ quantity: 1.5 })],
  ];

  for (const [label, unsafe] of unsafeCases) {
    assert.equal(
      buildCanonicalCartAnalyticsProjection([safe, unsafe, safe]),
      null,
      `${label} must suppress the whole projection, not just its own line`,
    );
  }
});

test("T6 an empty cart has no projection rather than an empty event", () => {
  assert.equal(buildCanonicalCartAnalyticsProjection([]), null);
});

test("T6 the internal VariantMirror id is never substituted for a vendor item id", () => {
  const projection = buildCanonicalCartAnalyticsProjection([line()]);
  assert.equal(JSON.stringify(projection).includes("variant-mirror-cuid"), false);

  // And a line whose only identity is the local one produces nothing at all.
  assert.equal(
    buildCartAnalyticsItemFacts({
      line: {
        pancakeVariationId: null,
        pancakeProductId: null,
        productName: "Linen Shirt",
        color: null,
        size: null,
        price: 490_000,
      },
      quantity: 1,
    }),
    null,
  );
});

test("T6 the projection carries no slug, media, availability or other page facts", () => {
  const projection = buildCanonicalCartAnalyticsProjection([line()]);
  const serialized = JSON.stringify(projection);

  for (const forbidden of ["linen-shirt", "media", "available", "unavailableReason", "variantId"]) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} must not reach a vendor`);
  }
});

test("T6 a merchandise total leaving the safe integer domain fails closed", () => {
  assert.equal(
    buildCanonicalCartAnalyticsProjection([
      line({ price: Number.MAX_SAFE_INTEGER, quantity: 2 }),
    ]),
    null,
  );
});

test("T6 a mutation event fact reports the delta, not the line's committed quantity", () => {
  const facts = buildCartAnalyticsItemFacts({
    line: {
      pancakeVariationId: "pancake-variation-1",
      pancakeProductId: "pancake-product-1",
      productName: "Linen Shirt",
      color: "Navy",
      size: "M",
      price: 490_000,
    },
    quantity: 1,
  });

  assert.equal(facts?.quantity, 1);
});
