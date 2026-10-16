import type { CartGiftState } from "../../src/commerce/cart-gift-selection.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { compareUpsellCandidates, isNearMoney, isPromotionUpsellEnabled, preservesUpsellBenefits } from "../../src/commerce/promotion-upsell-policy.ts";
import { isUpsellProofCurrent, issueUpsellQuoteProof, parseUpsellIntent, upsellProofContext, verifiesUpsellQuote, type UpsellQuote } from "../../src/commerce/promotion-upsell-proof.ts";

const secret = "upsell-policy-test-secret-more-than-thirty-two-bytes";
const quote: UpsellQuote = { kind: "LEGACY", facts: { items: [{ variantExternalId: "paid", quantity: 1, unitPriceVnd: 100000, fulfillmentState: "READY" }], merchandiseSubtotalVnd: 100000, shippingFeeVnd: 30000, totalVnd: 130000, totalQuantity: 1 } };
test("TG-01/03: literal flags + POS allowlist, exact BigInt 80% boundary", () => {
  const env = { LA_PROMOTION_UPSELL_ENABLED: "true", LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true", LA_PANCAKE_LINE_LEVEL_PRICING_VERIFIED_SHOP_IDS: "123" };
  assert.equal(isPromotionUpsellEnabled(123, env), true);
  for (const v of [undefined, "TRUE", "1", " true", "false"]) assert.equal(isPromotionUpsellEnabled(123, { ...env, LA_PROMOTION_UPSELL_ENABLED: v }), false);
  assert.equal(isPromotionUpsellEnabled(124, env), false);
  for (const [current, result] of [[799999, false], [800000, true], [999999, true], [1000000, false], [-1, false], [0.8, false]] as const) assert.equal(isNearMoney(current, 1000000), result);
  assert.equal(isNearMoney(8000000000000000, 9000000000000000), true);
});
test("TG-05: payable delta first, then campaign→product→variant; priority is irrelevant", () => {
  const a = { campaignId: "b", productId: "a", variantId: "a", deltaVnd: 0 };
  const b = { ...a, campaignId: "a" };
  assert.ok(compareUpsellCandidates(a, b) > 0);
  assert.ok(compareUpsellCandidates({ ...a, deltaVnd: -1 }, b) < 0);
  assert.ok(compareUpsellCandidates({ ...b, productId: "b" }, b) > 0);
  assert.ok(compareUpsellCandidates({ ...b, variantId: "b" }, b) > 0);
});
test("TG-09: reused HMAC binds revision, selected intent and after quote; expiry is independently checked", () => {
  const now = new Date();
  const intent = { campaignId: "campaign", variantId: "variant", issuedAt: now.getTime() };
  const context = upsellProofContext("server-cart", BigInt(1), 1, intent, quote);
  const proof = issueUpsellQuoteProof(quote, context, secret)!;
  assert.equal(verifiesUpsellQuote(quote, proof, context, secret), true);
  for (const other of [upsellProofContext("other-cart", BigInt(1), 1, intent, quote), upsellProofContext("server-cart", BigInt(3), 1, intent, quote), upsellProofContext("server-cart", BigInt(1), 2, intent, quote), upsellProofContext("server-cart", BigInt(1), 1, { ...intent, variantId: "another" }, quote)]) assert.equal(verifiesUpsellQuote(quote, proof, other, secret), false);
  assert.equal(isUpsellProofCurrent(now.getTime() - 299999, now), true);
  assert.equal(isUpsellProofCurrent(now.getTime() - 300000, now), false);
  assert.equal(isUpsellProofCurrent(now.getTime() + 1, now), false);
  assert.equal(parseUpsellIntent({ ...intent, proof })?.variantId, "variant");
  assert.equal(parseUpsellIntent({ ...intent, proof, cartId: "injection" }), null);
  assert.equal(parseUpsellIntent({ ...intent, proof, priceVnd: 1 }), null);
  assert.equal(proof.includes("server-cart"), false);
});

test("TG-04: inherited split ledgers use each segment quantity when preserving a campaign's savings", () => {
  const legacy = { campaignId: "flash", source: "LEGACY", inputPriceVnd: 100, outputPriceVnd: 90, appliedQuantity: 2 };
  const before = { items: [{ variantId: "paid", quantity: 2 }], entitlements: [], selections: [], validation: { ok: true }, quote: { lines: [{ available: true }], benefits: { enabled: true, ok: true, dropped: [], groups: [{ lineKey: "paid", quantity: 2, steps: [legacy] }] } } } as unknown as CartGiftState;
  // A later tier splits the original group. The inherited legacy audit keeps appliedQuantity=2
  // on both resulting segments; it is not the number of units in each resulting segment.
  const after = { ...before, quote: { ...before.quote, benefits: { enabled: true, ok: true, dropped: [], groups: [
    { lineKey: "paid", quantity: 1, steps: [{ ...legacy, outputPriceVnd: 95 }] },
    { lineKey: "paid", quantity: 1, steps: [{ ...legacy, outputPriceVnd: 95 }] },
  ] } } } as unknown as CartGiftState;
  assert.equal(preservesUpsellBenefits(before, after), false);
});
