import assert from "node:assert/strict";
import test from "node:test";
import { issueRenderedQuoteProof, verifyRenderedQuoteProof } from "../../src/commerce/checkout-quote-proof.ts";

test("UP-00: existing stateless COD proof accepts A→B→A; it cannot establish paid-write freshness", () => {
  const quote = { items: [{ variantExternalId: "paid", quantity: 1, unitPriceVnd: 100000, fulfillmentState: "READY" as const }], merchandiseSubtotalVnd: 100000, shippingFeeVnd: 30000, totalVnd: 130000, totalQuantity: 1 };
  const context = { cartId: "server-cookie-cart", secret: "upsell-test-secret-longer-than-thirty-two-bytes" };
  const proof = issueRenderedQuoteProof({ ...context, quote });
  assert.ok(proof);
  assert.equal(verifyRenderedQuoteProof({ ...context, proof, currentQuote: { ...quote, totalVnd: 230000 } }).ok, false);
  assert.equal(verifyRenderedQuoteProof({ ...context, proof, currentQuote: structuredClone(quote) }).ok, true);
});
