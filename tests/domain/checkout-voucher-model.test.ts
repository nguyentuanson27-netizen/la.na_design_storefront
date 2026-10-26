import assert from "node:assert/strict";
import test from "node:test";

import type { BenefitCheckoutRender } from "../../src/commerce/benefit-checkout-render.ts";
import { benefitQuoteDigest, issueBenefitQuoteProof } from "../../src/commerce/checkout-quote-proof.ts";
import { buildBenefitCheckoutQuoteFacts } from "../../src/commerce/checkout-quote.ts";
import type { StorefrontCartLine } from "../../src/commerce/storefront-cart.ts";
import { buildCheckoutVoucherView, buildBenefitCheckoutViewModel } from "../../src/routes/checkout-model.ts";
import { buildOrderSummary } from "../../src/routes/order-summary-model.ts";
import type { VoucherPickerModel } from "../../src/routes/voucher-picker-model.ts";

/** V18 -- what the checkout says about vouchers: the bill adds up, the saving is named once, an offer blocks nothing it should not. */

const secret = "test-server-secret-at-least-32-characters-long";
const cartId = "0f8d3c2a-4b1e-4d7a-9c6b-2e5f1a8d4c30";
const vnd = (amount: string): string => `${amount} ₫`;
const MERCH = "voucher-m";
const SHIP = "voucher-s";

const cartLine = {
  variantId: "paid", pancakeVariationId: "var-1", pancakeProductId: "product", productSlug: "ao",
  productName: "Áo sơ mi", color: "Trắng", size: "M", quantity: 2, price: 450_000, available: true,
  unavailableReason: null, isPreorderSale: false, media: { primary: null, gallery: [] },
} as StorefrontCartLine;

const voucherStep = { campaignId: MERCH, source: "VOUCHER" as const, campaignKind: "VOUCHER_MERCHANDISE", priority: null, inputPriceVnd: 450_000, outputPriceVnd: 425_000, appliedQuantity: 2 };

/** 2 x 450.000 with a 50.000 voucher = 2 x 425.000, and the 30.000 fee waived by a shipping voucher. */
function voucherFacts() {
  return buildBenefitCheckoutQuoteFacts({
    paid: [{ groupKey: "g|v0", pancakeVariationId: "var-1", quantity: 2, unitPriceVnd: 425_000, steps: [voucherStep], fulfillmentState: "READY" }],
    gifts: [],
    entitlements: [],
    shippingWaivedVnd: 30_000,
  })!;
}

function render(overrides: Partial<Extract<BenefitCheckoutRender, { kind: "BENEFIT" }>> = {}): Extract<BenefitCheckoutRender, { kind: "BENEFIT" }> {
  const quote = voucherFacts();
  return {
    kind: "BENEFIT",
    facts: quote,
    proof: issueBenefitQuoteProof({ quote, cartId, secret })!,
    digest: benefitQuoteDigest(quote),
    needsAcknowledgement: false,
    giftLabels: new Map(),
    tierDropped: false,
    voucher: { shippingWaivedVnd: 30_000, names: new Map([[MERCH, "Giảm 50.000đ"], [SHIP, "Miễn phí vận chuyển"]]), merchandiseCampaignId: MERCH, shippingCampaignId: SHIP, merchandiseDiscountVnd: 50_000 },
    ...overrides,
  };
}

test("the bill adds up with the vouchers named once: value, one voucher row, shipping and its waiver, total", () => {
  const model = buildBenefitCheckoutViewModel({ lines: [cartLine], render: render() });
  assert.equal(model.state, "ready");
  assert.deepEqual(model.lines.map((line) => [line.quantity, line.unitPriceText, line.lineTotalText]), [[2, vnd("425.000"), vnd("850.000")]]);
  const summary = model.summary!;
  assert.ok(summary, "a bill that adds up is shown");
  assert.equal(summary.valueText, vnd("900.000"));
  assert.deepEqual(summary.discounts.map((row) => [row.label, row.amountText]), [["Giảm 50.000đ", `−${vnd("50.000")}`]]);
  assert.equal(summary.shippingText, "Miễn phí");
  assert.deepEqual(summary.shippingVoucher, { label: "Miễn phí vận chuyển", amountText: `−${vnd("30.000")}` });
  assert.equal(summary.totalText, vnd("850.000"));
  assert.equal(model.totals!.totalText, vnd("850.000"));
  // The voucher is not booked under a tier or promotion name.
  assert.equal(model.promotions?.savings.length ?? 0, 0);
});

test("a saving that is not what the quote's lines carry gives no bill at all, never one that does not add up", () => {
  const lying = render({ voucher: { ...render().voucher!, merchandiseDiscountVnd: 40_000 } });
  assert.equal(buildBenefitCheckoutViewModel({ lines: [cartLine], render: lying }).summary, undefined);
});

test("a checkout without vouchers is unchanged: no voucher row, no waiver", () => {
  const plain = buildBenefitCheckoutQuoteFacts({
    paid: [{ groupKey: "g|p", pancakeVariationId: "var-1", quantity: 2, unitPriceVnd: 450_000, steps: [], fulfillmentState: "READY" }],
    gifts: [],
    entitlements: [],
  })!;
  const model = buildBenefitCheckoutViewModel({ lines: [cartLine], render: { ...render(), facts: plain, proof: issueBenefitQuoteProof({ quote: plain, cartId, secret })!, digest: benefitQuoteDigest(plain), voucher: undefined } });
  assert.deepEqual(model.summary!.discounts, []);
  assert.equal(model.summary!.shippingVoucher, null);
  assert.equal(model.summary!.totalText, vnd("930.000"));
});

test("order summary: a waiver needs a positive amount and never changes the value", () => {
  const base = { goodsAfterDiscountsVnd: 850_000, discounts: [], shippingFeeVnd: 0 };
  assert.equal(buildOrderSummary({ ...base, shippingVoucher: { label: "x", waivedVnd: 0 } }), null);
  assert.equal(buildOrderSummary({ ...base, shippingVoucher: { label: "x", waivedVnd: 30_000 } })!.valueText, vnd("850.000"));
});

const picker = (overrides: Partial<VoucherPickerModel> = {}): VoucherPickerModel => ({
  previewNotHeld: true,
  groups: [
    { kind: "MERCHANDISE", heading: "", hint: "", noneLabel: "", noneSelected: false, mode: "AUTO", items: [{ id: MERCH, title: "Giảm 50.000đ", condition: "", selected: true, selectable: true, disabledReason: null, shortfallVnd: null, savingText: "Dự kiến giảm 50.000đ", publicCode: null, endsAtIso: null }] },
    { kind: "SHIPPING_FREE", heading: "", hint: "", noneLabel: "", noneSelected: true, mode: "AUTO", items: [] },
  ],
  summary: { paidBeforeText: "900.000đ", merchandiseDiscountText: "-50.000đ", shippingFeeText: "30.000đ", shippingDiscountText: null, totalText: "880.000đ", totalVnd: 880_000 },
  footer: { label: "Áp dụng • 1 ưu đãi", count: 1 },
  quoteDigest: "a".repeat(64),
  warnings: { giftLoss: null, totalIncrease: null, notices: [] },
  ...overrides,
});

test("held vouchers are listed from the same render as the quote, with the earliest expiry", () => {
  const view = buildCheckoutVoucherView({ render: render(), picker: picker(), heldUntilMs: 1_700_000_000_000 });
  assert.deepEqual(view, {
    state: "HELD",
    lines: [{ id: MERCH, title: "Giảm 50.000đ", amountText: `−${vnd("50.000")}` }, { id: SHIP, title: "Miễn phí vận chuyển", amountText: `−${vnd("30.000")}` }],
    heldUntilMs: 1_700_000_000_000,
  });
});

test("an unheld selection is an offer carrying the digest the hold POST must send back and the consent it needs", () => {
  const plain = { kind: "LEGACY" as const };
  const offered = buildCheckoutVoucherView({ render: plain, picker: picker({ warnings: { giftLoss: "Mất 1 suất quà.", totalIncrease: "Tổng tăng 10.000đ", notices: [] } }), heldUntilMs: null });
  assert.deepEqual(offered, {
    state: "OFFERED", digest: "a".repeat(64), lines: [{ id: MERCH, title: "Giảm 50.000đ", amountText: "Dự kiến giảm 50.000đ" }], totalText: "880.000đ",
    giftLossText: "Mất 1 suất quà.", totalIncreaseText: "Tổng tăng 10.000đ", afterStale: false,
  });
  // Holds that stopped describing the cart do not hide the offer; they only say it has to be confirmed again.
  assert.equal(buildCheckoutVoucherView({ render: { ...plain, voucherStale: true }, picker: picker(), heldUntilMs: null })!.state, "OFFERED");
  assert.equal((buildCheckoutVoucherView({ render: { ...plain, voucherStale: true }, picker: picker(), heldUntilMs: null }) as { afterStale: boolean }).afterStale, true);
});

test("nothing to offer: stale holds are only reported, and otherwise the checkout says nothing about vouchers", () => {
  const none = picker({ footer: { label: "Bỏ qua ưu đãi và tiếp tục", count: 0 } });
  assert.deepEqual(buildCheckoutVoucherView({ render: { kind: "LEGACY", voucherStale: true }, picker: none, heldUntilMs: null }), { state: "STALE" });
  assert.equal(buildCheckoutVoucherView({ render: { kind: "LEGACY" }, picker: none, heldUntilMs: null }), null);
  assert.equal(buildCheckoutVoucherView({ render: { kind: "LEGACY" }, picker: null, heldUntilMs: null }), null);
  // No digest means no hold can be asked for, so no offer either.
  assert.equal(buildCheckoutVoucherView({ render: { kind: "LEGACY" }, picker: picker({ quoteDigest: null }), heldUntilMs: null }), null);
});
