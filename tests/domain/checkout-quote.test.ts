import assert from "node:assert/strict";
import test from "node:test";

import { ANONYMOUS_CART_MAX_DISTINCT_ITEMS } from "../../src/commerce/anonymous-cart.ts";
import { buildRenderedCheckoutQuoteFacts } from "../../src/commerce/checkout-quote.ts";
import type { StorefrontCartLine } from "../../src/commerce/storefront-cart.ts";

function line({
  variantId,
  variationId,
  price,
  quantity,
  available = true,
}: {
  variantId: string;
  variationId: string | null;
  price: number | null;
  quantity: number;
  available?: boolean;
}): StorefrontCartLine {
  return {
    variantId,
    pancakeVariationId: variationId,
    pancakeProductId: `product-${variantId}`,
    productSlug: `slug-${variantId}`,
    productName: `Product ${variantId}`,
    color: "Black",
    size: "M",
    quantity,
    price,
    available,
    isPreorderSale: false,
    unavailableReason: available ? null : "PRICE_UNRESOLVED",
    media: { primary: null, gallery: [] },
  };
}

test("P8 rendered checkout quote is deterministic, bounded and contains only external item/money facts", () => {
  const quote = buildRenderedCheckoutQuoteFacts([
    line({ variantId: "local-b", variationId: "variation-b", price: 300_000, quantity: 1 }),
    line({ variantId: "local-a", variationId: "variation-a", price: 500_000, quantity: 1 }),
  ]);

  assert.deepEqual(quote, {
    items: [
      { variantExternalId: "variation-a", quantity: 1, unitPriceVnd: 500_000 },
      { variantExternalId: "variation-b", quantity: 1, unitPriceVnd: 300_000 },
    ],
    merchandiseSubtotalVnd: 800_000,
    shippingFeeVnd: 30_000,
    totalVnd: 830_000,
    totalQuantity: 2,
  });
  assert.equal(JSON.stringify(quote).includes("local-a"), false, "internal variant ids stay out");
  assert.equal(JSON.stringify(quote).includes("Product"), false, "names/PII-like text stay out");
});

test("P8 rendered checkout quote accepts the cart ceiling and rejects max+1 before projection", () => {
  const atLimit = Array.from({ length: ANONYMOUS_CART_MAX_DISTINCT_ITEMS }, (_, index) =>
    line({
      variantId: `local-${index}`,
      variationId: `variation-${index}`,
      price: 1,
      quantity: 1,
    }),
  );

  const quote = buildRenderedCheckoutQuoteFacts(atLimit);
  assert.notEqual(quote, null);
  assert.equal(quote?.items.length, ANONYMOUS_CART_MAX_DISTINCT_ITEMS);

  assert.equal(
    buildRenderedCheckoutQuoteFacts([
      ...atLimit,
      line({
        variantId: "local-over-limit",
        variationId: "variation-over-limit",
        price: 1,
        quantity: 1,
      }),
    ]),
    null,
  );
});

test("P8 rendered checkout quote fails closed for partial, duplicated or unsafe cart facts", () => {
  assert.equal(
    buildRenderedCheckoutQuoteFacts([
      line({ variantId: "safe", variationId: "variation-safe", price: 500_000, quantity: 1 }),
      line({ variantId: "unsafe", variationId: null, price: 300_000, quantity: 1 }),
    ]),
    null,
  );

  assert.equal(
    buildRenderedCheckoutQuoteFacts([
      line({ variantId: "a", variationId: "same", price: 500_000, quantity: 1 }),
      line({ variantId: "b", variationId: "same", price: 300_000, quantity: 1 }),
    ]),
    null,
  );

  assert.equal(
    buildRenderedCheckoutQuoteFacts([
      line({ variantId: "unsafe-money", variationId: "variation-money", price: Number.NaN, quantity: 1 }),
    ]),
    null,
  );
});
