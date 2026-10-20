import assert from "node:assert/strict";
import test from "node:test";
import { buildBenefitCheckoutQuoteFacts, buildRenderedCheckoutQuoteFacts } from "../../src/commerce/checkout-quote.ts";
import { evaluateShippingCampaigns, shippingFeeFromQuote, type ShippingCampaign, type ShippingQuote } from "../../src/commerce/shipping-campaign.ts";
import { buildShippingPromotionNotice } from "../../src/components/headless/shipping-promotion-model.ts";
import { issueRenderedQuoteProof, verifyRenderedQuoteProof, issueBenefitQuoteProof, verifyBenefitQuoteProof } from "../../src/commerce/checkout-quote-proof.ts";
import type { StorefrontCartLine } from "../../src/commerce/storefront-cart.ts";

const now = new Date("2026-10-20T12:00:00Z");
const policy = { feeVnd: 30_000 };
const campaign: ShippingCampaign = {
  id: "shipping-two", revision: 1, name: "Mua hai Set", isEnabled: true, enabledAt: now, disabledAt: null,
  startsAt: now, endsAt: new Date(now.getTime() + 60000), minimumQuantity: 2, priority: 0, stackingEnabled: true,
  scope: { mode: "DYNAMIC_CATEGORY", categoryKeys: ["aoDai", "setDo", "vayDam"], includeProductIds: [], excludeProductIds: [] },
};
const line = (quantity: number): StorefrontCartLine => ({
  variantId: "v-one", pancakeVariationId: "pv-one", pancakeProductId: "p-one", productSlug: "set-one", productName: "Set One",
  quantity, price: 450000, available: true, unavailableReason: null, color: "Red", size: "M", isPreorderSale: false, media: { primary: null, gallery: [] },
});
const shipping = (quantity: number, campaigns: readonly ShippingCampaign[] = [campaign], at = now) => evaluateShippingCampaigns({
  policy, now: at, campaigns, hasOtherPromotions: true,
  lines: [{ role: "PAID", product: { productId: "p-one", categoryKeys: ["setQuanAo"] }, quantity }],
});

test("campaign configuration, not an ambient minimum of two, controls all quote totals", () => {
  for (const quantity of [1, 2, 3, 4, 5]) {
    const basic = buildRenderedCheckoutQuoteFacts([line(quantity)], { shippingPolicy: policy, shippingQuote: shipping(quantity, []) });
    const promoted = buildRenderedCheckoutQuoteFacts([line(quantity)], { shippingPolicy: policy, shippingQuote: shipping(quantity) });
    assert.equal(basic?.shippingFeeVnd, 30000);
    assert.equal(promoted?.shippingFeeVnd, quantity >= 2 ? 0 : 30000);
    assert.equal(promoted?.totalVnd, quantity * 450000 + (quantity >= 2 ? 0 : 30000));
  }
});
test("benefit quotes preserve paid discounts and zero-price gifts while accepting the same shipping decision", () => {
  const facts = buildBenefitCheckoutQuoteFacts({
    paid: [{ groupKey: "p-one", pancakeVariationId: "pv-one", quantity: 3, unitPriceVnd: 400000, steps: [], fulfillmentState: "READY" }],
    gifts: [{ campaignId: "gift", campaignRevision: 1, pancakeVariationId: "pv-gift", quantity: 1 }],
    entitlements: [{ campaignId: "gift", campaignRevision: 1, entitled: 1, selected: 1, skippedWhileAvailable: 0, contendedForSharedStock: 0, shortForStock: 0 }],
    shippingQuote: shipping(3), shippingPolicy: policy,
  });
  assert.ok(facts);
  assert.equal(facts.shippingFeeVnd, 0);
  assert.equal(facts.totalVnd, 1200000);
  assert.equal(facts.lines.filter((entry) => entry.role === "GIFT")[0]?.lineTotalVnd, 0);
});
test("expiry and an edited threshold invalidate an old rendered quote instead of silently increasing the bill", () => {
  const cartId = "0f8d3c2a-4b1e-4d7a-9c6b-2e5f1a8d4c30";
  const secret = "test-server-secret-at-least-32-characters-long";
  const before = buildRenderedCheckoutQuoteFacts([line(2)], { shippingPolicy: policy, shippingQuote: shipping(2) })!;
  const proof = issueRenderedQuoteProof({ quote: before, cartId, secret });
  assert.ok(proof);
  for (const changed of [shipping(2, [campaign], campaign.endsAt!), shipping(2, [{ ...campaign, revision: 2, minimumQuantity: 3 }])]) {
    const after = buildRenderedCheckoutQuoteFacts([line(2)], { shippingPolicy: policy, shippingQuote: changed })!;
    assert.equal(after.shippingFeeVnd, 30000);
    const verdict = verifyRenderedQuoteProof({ proof, cartId, currentQuote: after, secret });
    assert.equal(verdict.ok, false);
  }
});
test("benefit proof also binds the shipping amount", () => {
  const paid = [{ groupKey: "p-one", pancakeVariationId: "pv-one", quantity: 2, unitPriceVnd: 400000, steps: [], fulfillmentState: "READY" as const }];
  const before = buildBenefitCheckoutQuoteFacts({ paid, gifts: [], entitlements: [], shippingPolicy: policy, shippingQuote: shipping(2) })!;
  const after = buildBenefitCheckoutQuoteFacts({ paid, gifts: [], entitlements: [], shippingPolicy: policy, shippingQuote: shipping(2, []) })!;
  const cartId = "cart-one", secret = "test-server-secret-at-least-32-characters-long";
  const proof = issueBenefitQuoteProof({ quote: before, cartId, secret });
  assert.deepEqual(verifyBenefitQuoteProof({ proof, cartId, currentQuote: after, secret }), { ok: false, reason: "PRICE_CHANGED" });
});
test("public shipping copy follows campaign state and has no internal scope identities", () => {
  assert.equal(buildShippingPromotionNotice([], now), null);
  assert.equal(buildShippingPromotionNotice([{ ...campaign, isEnabled: false }], now), null);
  assert.equal(buildShippingPromotionNotice([campaign], campaign.endsAt!), null);
  assert.equal(buildShippingPromotionNotice([{ ...campaign, startsAt: new Date(now.getTime() + 1) }], now), null);
  const notice = buildShippingPromotionNotice([campaign], now)!;
  assert.match(notice.headline, /2/);
  assert.equal(notice.expiresAtMs, campaign.endsAt!.getTime());
  assert.doesNotMatch(JSON.stringify(notice), /shipping-two|includeProductIds|excludeProductIds/);
  assert.match(buildShippingPromotionNotice([{ ...campaign, minimumQuantity: 3 }], now)!.headline, /3/);
});
test("a malformed shipping projection cannot manufacture a waiver", () => {
  for (const malformed of [{ baseFeeVnd: 30000, feeVnd: 0 }, { baseFeeVnd: 30000, feeVnd: 0, campaign: {} }, { ...shipping(2), baseFeeVnd: 1 }, { ...shipping(2), feeVnd: -1 }]) {
    assert.throws(() => shippingFeeFromQuote(malformed as ShippingQuote, policy), RangeError);
  }
});
