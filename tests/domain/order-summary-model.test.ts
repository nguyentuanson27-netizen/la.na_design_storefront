import assert from "node:assert/strict";
import test from "node:test";

import type { BenefitCheckoutRender } from "../../src/commerce/benefit-checkout-render.ts";
import type { CartGiftState } from "../../src/commerce/cart-gift-selection.ts";
import { buildBenefitCheckoutQuoteFacts, buildRenderedCheckoutQuoteFacts } from "../../src/commerce/checkout-quote.ts";
import { DEFAULT_GUEST_SHIPPING_POLICY } from "../../src/commerce/guest-shipping-policy.ts";
import type { StorefrontCartLine } from "../../src/commerce/storefront-cart.ts";
import { buildCartViewModel } from "../../src/routes/cart-model.ts";
import { buildBenefitCheckoutViewModel, buildCheckoutViewModel } from "../../src/routes/checkout-model.ts";
import { buildOrderSummary } from "../../src/routes/order-summary-model.ts";

/** The bill in reading order -- value, each discount, shipping, total -- and that its lines always add up. */

const vnd = (amount: string): string => `${amount} ₫`;
const row = (id: string, label: string, amountVnd: number) => ({ id, label, amountVnd, amountText: vnd(amountVnd.toLocaleString("vi-VN")) });

const line = (overrides: Partial<StorefrontCartLine> = {}) => ({
  variantId: "paid", pancakeVariationId: "var-1", pancakeProductId: "product", productSlug: "ao", productName: "Set quần", color: "Xanh", size: "M",
  quantity: 5, price: 689_000, available: true, unavailableReason: null, isPreorderSale: false, media: { primary: null, gallery: [] }, ...overrides,
}) as StorefrontCartLine;

/* ---------------------------------------------------------------- the pure bill */

test("value, then each named discount, then shipping, then the total they make", () => {
  const summary = buildOrderSummary({ goodsAfterDiscountsVnd: 3_178_000, discounts: [row("a", "Mua 5 giảm 10%", 267_000)], shippingFeeVnd: 0 })!;
  assert.equal(summary.valueText, vnd("3.445.000"));
  assert.deepEqual(summary.discounts.map((d) => [d.label, d.amountText]), [["Mua 5 giảm 10%", `−${vnd("267.000")}`]]);
  assert.equal(summary.shippingText, "Miễn phí");
  assert.equal(summary.totalText, vnd("3.178.000"));
});

test("each campaign is its own line, and a paid shipping fee is added to the total, not to the value", () => {
  const summary = buildOrderSummary({
    goodsAfterDiscountsVnd: 900_000,
    discounts: [row("a", "Mua 2 giảm 5%", 50_000), row("b", "Đơn từ 1 triệu giảm 50.000 ₫", 50_000)],
    shippingFeeVnd: 30_000,
  })!;
  assert.equal(summary.valueText, vnd("1.000.000"));
  assert.equal(summary.discounts.length, 2);
  assert.equal(summary.shippingText, vnd("30.000"));
  assert.equal(summary.totalText, vnd("930.000"));
});

test("with no discount the bill is just value, shipping and total", () => {
  const summary = buildOrderSummary({ goodsAfterDiscountsVnd: 200_000, discounts: [], shippingFeeVnd: 30_000 })!;
  assert.deepEqual([summary.valueText, summary.discounts, summary.totalText], [vnd("200.000"), [], vnd("230.000")]);
});

test("a bill that does not add up to the authoritative total is never shown", () => {
  assert.ok(buildOrderSummary({ goodsAfterDiscountsVnd: 200_000, discounts: [], shippingFeeVnd: 30_000, expectedTotalVnd: 230_000 }));
  assert.equal(buildOrderSummary({ goodsAfterDiscountsVnd: 200_000, discounts: [], shippingFeeVnd: 30_000, expectedTotalVnd: 231_000 }), null);
  for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(buildOrderSummary({ goodsAfterDiscountsVnd: bad, discounts: [], shippingFeeVnd: 0 }), null, String(bad));
    assert.equal(buildOrderSummary({ goodsAfterDiscountsVnd: 1, discounts: [], shippingFeeVnd: bad }), null, String(bad));
  }
});

/* ---------------------------------------------------------------- the cart and the drawer */

const tierStep = { campaignId: "tier", source: "QUANTITY_TIER" as const, kind: "QUANTITY_TIER", priority: 1, inputPriceVnd: 689_000, outputPriceVnd: 600_000, appliedQuantity: 3 };
function state(overrides: { goods?: number; steps?: unknown[]; groups?: unknown[] } = {}): CartGiftState {
  return {
    quote: { lines: [line()], benefits: {
      enabled: true, ok: true, subtotalVnd: overrides.goods ?? 3_178_000, dropped: [], campaignNames: new Map([["tier", "Mua 3 giảm 13%"]]), orderValueProgress: [],
      groups: overrides.groups ?? [
        { groupKey: "paid|disc", lineKey: "paid", quantity: 3, unitPriceVnd: 600_000, steps: overrides.steps ?? [tierStep] },
        { groupKey: "paid|full", lineKey: "paid", quantity: 2, unitPriceVnd: 689_000, steps: [] },
      ],
    } },
    labels: [], campaigns: [], entitlements: [], selections: [], validation: { ok: true, issues: [], summaries: [] },
  } as unknown as CartGiftState;
}

test("the cart builds the bill when the server supplies the shipping policy, and not otherwise", () => {
  const model = buildCartViewModel({ lines: [line()], commerceTrackingEnabled: false, benefitCheckoutOpen: true, giftState: state(), shippingPolicy: DEFAULT_GUEST_SHIPPING_POLICY });
  assert.deepEqual(
    [model.summary?.valueText, model.summary?.discounts.map((d) => d.label), model.summary?.shippingText, model.summary?.totalText],
    [vnd("3.445.000"), ["Mua 3 giảm 13%"], "Miễn phí", vnd("3.178.000")],
  );
  // The order value is the lines' own prices, which is what the shopper sees on the page.
  assert.equal(model.summary?.valueText, vnd((5 * 689_000).toLocaleString("vi-VN")));

  const noPolicy = buildCartViewModel({ lines: [line()], commerceTrackingEnabled: false, benefitCheckoutOpen: true, giftState: state() });
  assert.equal("summary" in noPolicy, false, "a browser bundle cannot read the shipping policy, so it builds no bill");
  const gateOff = buildCartViewModel({ lines: [line()], commerceTrackingEnabled: false });
  assert.equal("summary" in gateOff, false);
});

test("gate OFF with a policy: the bill is value, shipping, total with no discount lines", () => {
  const model = buildCartViewModel({ lines: [line({ quantity: 1, price: 200_000 })], commerceTrackingEnabled: false, shippingPolicy: DEFAULT_GUEST_SHIPPING_POLICY });
  assert.deepEqual([model.summary?.valueText, model.summary?.discounts, model.summary?.shippingText, model.summary?.totalText], [vnd("200.000"), [], vnd("30.000"), vnd("230.000")]);
});

test("free shipping is judged on the goods AFTER discounts, as checkout does", () => {
  // 2 × 520.000 = 1.040.000 clears the 1.000.000 free-shipping line, but a 5 % discount brings it to 988.000: shipping is charged.
  const step = { campaignId: "order", source: "QUANTITY_TIER" as const, kind: "QUANTITY_TIER", priority: 1, inputPriceVnd: 520_000, outputPriceVnd: 494_000, appliedQuantity: 2 };
  const l = line({ quantity: 2, price: 520_000 });
  const s = state({ goods: 988_000, groups: [{ groupKey: "paid", lineKey: "paid", quantity: 2, unitPriceVnd: 494_000, steps: [step] }] });
  (s.quote.benefits as unknown as { campaignNames: Map<string, string> }).campaignNames = new Map([["order", "Đơn từ 1 triệu giảm 5%"]]);
  const model = buildCartViewModel({ lines: [l], commerceTrackingEnabled: false, benefitCheckoutOpen: true, giftState: s, shippingPolicy: DEFAULT_GUEST_SHIPPING_POLICY });
  assert.deepEqual([model.summary?.valueText, model.summary?.shippingText, model.summary?.totalText], [vnd("1.040.000"), vnd("30.000"), vnd("1.018.000")]);
});

test("no bill while the cart cannot be bought or its benefits cannot be trusted", () => {
  const policy = DEFAULT_GUEST_SHIPPING_POLICY;
  assert.equal("summary" in buildCartViewModel({ lines: [line(), line({ variantId: "x", available: false, unavailableReason: "OUT_OF_STOCK" })], commerceTrackingEnabled: false, shippingPolicy: policy }), false);
  assert.equal("summary" in buildCartViewModel({ lines: [line()], commerceTrackingEnabled: false, benefitsUnavailable: true, shippingPolicy: policy }), false);
  assert.equal("summary" in buildCartViewModel({ lines: [line()], commerceTrackingEnabled: false, giftState: state(), shippingPolicy: policy }), false, "benefits not open for checkout: the discount banner is withheld, so the bill is too");
});

test("a discount ledger that does not close the gap to the lines' prices yields no bill", () => {
  // The discounted group is paid at 600.000 but no tier step explains the 89.000 each: nothing names that saving.
  const s = state({ steps: [] });
  const model = buildCartViewModel({ lines: [line()], commerceTrackingEnabled: false, benefitCheckoutOpen: true, giftState: s, shippingPolicy: DEFAULT_GUEST_SHIPPING_POLICY });
  assert.equal("summary" in model, false);
});

/* ---------------------------------------------------------------- checkout */

test("the ordinary checkout shows value, shipping and total that equal its quote", () => {
  const lines = [line({ quantity: 2, price: 100_000 })];
  const totals = buildRenderedCheckoutQuoteFacts(lines);
  const model = buildCheckoutViewModel({ lines, totals, quoteProof: "proof" });
  assert.deepEqual([model.summary?.valueText, model.summary?.discounts, model.summary?.shippingText, model.summary?.totalText], [vnd("200.000"), [], vnd("30.000"), model.totals?.totalText]);
});

test("a benefit checkout lists each named discount between the value and the shipping", () => {
  const qtyStep = { campaignId: "tier", source: "QUANTITY_TIER" as const, campaignKind: "QUANTITY_TIER", priority: 1, inputPriceVnd: 689_000, outputPriceVnd: 600_000, appliedQuantity: 3 };
  const facts = buildBenefitCheckoutQuoteFacts({
    paid: [
      { groupKey: "a", pancakeVariationId: "var-1", quantity: 3, unitPriceVnd: 600_000, steps: [qtyStep], fulfillmentState: "READY" },
      { groupKey: "b", pancakeVariationId: "var-1", quantity: 2, unitPriceVnd: 689_000, steps: [], fulfillmentState: "READY" },
    ],
    gifts: [], entitlements: [],
  });
  assert.ok(facts);
  const render: Extract<BenefitCheckoutRender, { kind: "BENEFIT" }> = {
    kind: "BENEFIT", facts, proof: "p", digest: "d", needsAcknowledgement: false, giftLabels: new Map(), tierDropped: false, campaignNames: new Map([["tier", "Mua 3 giảm 13%"]]),
  };
  const model = buildBenefitCheckoutViewModel({ lines: [line()], render });
  assert.deepEqual(
    [model.summary?.valueText, model.summary?.discounts.map((d) => d.label), model.summary?.shippingText, model.summary?.totalText],
    [vnd("3.445.000"), ["Mua 3 giảm 13%"], "Miễn phí", model.totals?.totalText],
  );
});
