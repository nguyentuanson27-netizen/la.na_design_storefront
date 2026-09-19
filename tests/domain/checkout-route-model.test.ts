import assert from "node:assert/strict";
import test from "node:test";

import type { RenderedCheckoutQuoteFacts } from "../../src/commerce/checkout-quote.ts";
import type { StorefrontCartLine } from "../../src/commerce/storefront-cart.ts";
import {
  buildCheckoutViewModel,
  checkoutPixelContentIds,
} from "../../src/routes/checkout-model.ts";
import {
  buildCheckoutSuccessViewModel,
  parseOrderCode,
} from "../../src/routes/checkout-success-model.ts";

/** The checkout routes' own decisions, held to the behaviour the pages had before they migrated. */

/** The VND formatter emits U+00A0 before ₫, not a plain space. Spelling it out keeps these honest. */
const vnd = (amount: string): string => `${amount} ₫`;

function line(overrides: Partial<StorefrontCartLine> = {}): StorefrontCartLine {
  return {
    variantId: "variant-1",
    pancakeVariationId: "pancake-1",
    pancakeProductId: "product-1",
    productSlug: "ao-so-mi",
    productName: "Áo sơ mi",
    color: "Đen",
    size: "M",
    quantity: 2,
    price: 100_000,
    available: true,
    unavailableReason: null,
    media: { primary: null, gallery: [] },
    ...overrides,
  } as StorefrontCartLine;
}

function quote(overrides: Partial<RenderedCheckoutQuoteFacts> = {}): RenderedCheckoutQuoteFacts {
  return {
    items: [{ variantExternalId: "pancake-1", quantity: 2, unitPriceVnd: 100_000, fulfillmentState: "READY" as const }],
    merchandiseSubtotalVnd: 200_000,
    shippingFeeVnd: 30_000,
    totalVnd: 230_000,
    totalQuantity: 2,
    ...overrides,
  };
}

const ready = (overrides: Parameters<typeof buildCheckoutViewModel>[0] | null = null) =>
  buildCheckoutViewModel(
    overrides ?? { lines: [line()], totals: quote(), quoteProof: "proof-token" },
  );

/* -------------------------------------------------------------------------- state */

test("an empty cart is the empty state, whatever else is passed", () => {
  const model = buildCheckoutViewModel({ lines: [], totals: quote(), quoteProof: "proof-token" });

  assert.equal(model.state, "empty");
  assert.deepEqual(model.lines, []);
  assert.equal(model.totals, null);
  assert.equal(model.quoteProof, null);
});

test("lines that could not be priced are unquotable", () => {
  const model = buildCheckoutViewModel({ lines: [line()], totals: null, quoteProof: "proof-token" });

  assert.equal(model.state, "unquotable");
  assert.equal(model.quoteProof, null);
});

test("a priced cart with no proof is unquotable too", () => {
  // Submission rejects a proofless quote, so offering the form would be a reconfirm loop with no
  // exit. The shopper is sent back to the cart in both cases, which is why it is one state.
  const model = buildCheckoutViewModel({ lines: [line()], totals: quote(), quoteProof: null });

  assert.equal(model.state, "unquotable");
  assert.deepEqual(model.lines, []);
  assert.equal(model.totals, null);
});

test("a priced and proved cart is ready and carries the token the form submits with", () => {
  const model = ready();

  assert.equal(model.state, "ready");
  assert.equal(model.quoteProof, "proof-token");
  assert.equal(model.lines.length, 1);
});

/* -------------------------------------------------------------------------- lines */

test("a line reads as colour / size with its quantity's total, not its unit price", () => {
  const [row] = ready({
    lines: [line({ price: 100_000, quantity: 3 })],
    totals: quote(),
    quoteProof: "proof-token",
  }).lines;

  assert.equal(row?.optionLabel, "Đen / M");
  assert.equal(row?.lineTotalText, vnd("300.000"));
  assert.equal(row?.quantity, 3);
});

test("a line with neither colour nor size falls back rather than rendering an empty label", () => {
  const [row] = ready({
    lines: [line({ color: null, size: null })],
    totals: quote(),
    quoteProof: "proof-token",
  }).lines;

  assert.equal(row?.optionLabel, "Biến thể");
});

test("a line whose product mirror has gone still names something", () => {
  const [row] = ready({
    lines: [line({ productName: null })],
    totals: quote(),
    quoteProof: "proof-token",
  }).lines;

  assert.equal(row?.productName, "Sản phẩm không còn trong catalog");
});

/* ------------------------------------------------------------------------- totals */

test("free shipping says so instead of formatting zero dong", () => {
  const model = ready({
    lines: [line()],
    totals: quote({ shippingFeeVnd: 0 }),
    quoteProof: "proof-token",
  });

  assert.equal(model.totals?.shippingText, "Miễn phí");
});

test("totals come from the quote, never recomputed from the lines", () => {
  // The quote is what the proof is issued over and what submission re-checks. A page that added the
  // lines up itself could show a total the server would refuse.
  const model = ready({
    lines: [line({ price: 100_000, quantity: 2 })],
    totals: quote({ merchandiseSubtotalVnd: 180_000, shippingFeeVnd: 20_000, totalVnd: 200_000 }),
    quoteProof: "proof-token",
  });

  assert.equal(model.totals?.subtotalText, vnd("180.000"));
  assert.equal(model.totals?.shippingText, vnd("20.000"));
  assert.equal(model.totals?.totalText, vnd("200.000"));
});

/* -------------------------------------------------------------------- pixel content */

test("every line contributes an id, so the item list cannot contradict the totals", () => {
  const ids = checkoutPixelContentIds([
    line({ productSlug: "ao-so-mi" }),
    line({ variantId: "variant-2", productSlug: null }),
  ]);

  assert.deepEqual(ids, ["ao-so-mi", "variant-2"]);
});

/* ------------------------------------------------------------------- order code */

test("an order code survives only as a single clean string", () => {
  assert.equal(parseOrderCode("LA-1234"), "LA-1234");
  assert.equal(parseOrderCode(undefined), null);
  assert.equal(parseOrderCode(["LA-1234", "LA-5678"]), null);
  assert.equal(parseOrderCode(""), null);
  assert.equal(parseOrderCode(" LA-1234"), null);
  assert.equal(parseOrderCode("LA-1234 "), null);
  assert.equal(parseOrderCode("x".repeat(129)), null);
  assert.equal(parseOrderCode("x".repeat(128)), "x".repeat(128));
});

/* ------------------------------------------------------------- confirmation state */

test("a confirmed order shows its code", () => {
  const model = buildCheckoutSuccessViewModel({ orderCode: "LA-1234", confirmed: true });

  assert.equal(model.confirmed, true);
  assert.equal(model.orderCode, "LA-1234");
});

test("an unconfirmed order never echoes the code back", () => {
  // The code arrives in the query string, so anyone can type one. Echoing it on the failure branch
  // would confirm to a guesser which codes exist.
  const model = buildCheckoutSuccessViewModel({ orderCode: "LA-1234", confirmed: false });

  assert.equal(model.confirmed, false);
  assert.equal(model.orderCode, null);
});

test("a confirmed state with no code is not confirmed", () => {
  const model = buildCheckoutSuccessViewModel({ orderCode: null, confirmed: true });

  assert.equal(model.confirmed, false);
  assert.equal(model.orderCode, null);
});
