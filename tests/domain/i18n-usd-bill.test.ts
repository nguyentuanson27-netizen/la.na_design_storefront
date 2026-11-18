import assert from "node:assert/strict";
import test from "node:test";

import type { StorefrontCartLine } from "../../src/commerce/storefront-cart.ts";
import { formatCents, priceCentsFromVnd } from "../../src/i18n/money.ts";
import { shareAmount, usdCart, usdCheckout } from "../../src/i18n/usd-bill.ts";
import { buildCartViewModel } from "../../src/routes/cart-model.ts";
import { buildCheckoutViewModel } from "../../src/routes/checkout-model.ts";

/** What a shopper checks on a bill: quantity x unit price = line total, the lines add up, and so does the bill. */

const usd = (vnd: number) => formatCents(priceCentsFromVnd(vnd));
const cents = (text: string) => Math.round(Number(text.replace(/[$,]/g, "")) * 100);

function line(quantity: number, price: number, overrides: Partial<StorefrontCartLine> = {}): StorefrontCartLine {
  return {
    variantId: `v-${price}`, pancakeVariationId: `p-${price}`, pancakeProductId: "product", productSlug: "ao",
    productName: "Áo", color: "Xanh", size: "M", quantity, price, available: true,
    unavailableReason: null, isPreorderSale: false, media: { primary: null, gallery: [] },
    ...overrides,
  } as StorefrontCartLine;
}

const cart = (lines: StorefrontCartLine[]) =>
  usdCart(buildCartViewModel({ lines, commerceTrackingEnabled: false, shippingPolicy: { feeVnd: 30_000 } }));

test("205.000 dong: the line total is the quantity times the unit price shown, at every quantity", () => {
  // $10.25 exactly, shown as $10.49.
  assert.equal(usd(205_000), "$10.49");
  for (const quantity of [1, 2, 3, 4, 10]) {
    const model = cart([line(quantity, 205_000)]);
    const item = model.lines[0]!;
    assert.equal(item.priceText, "$10.49");
    assert.equal(cents(item.lineTotalText!), quantity * 1049, `${quantity} items`);
    assert.equal(model.subtotalText, item.lineTotalText, "one line: the subtotal is its total");
    const summary = model.summary!;
    assert.equal(summary.valueText, item.lineTotalText);
    // 30.000 dong shipping is $1.50, shown as $1.49.
    assert.equal(summary.shippingText, "$1.49");
    assert.equal(cents(summary.totalText), quantity * 1049 + 149);
  }
  // The case from review: 4 items used to read "4 x $10.49" with a total of $40.99.
  assert.equal(cart([line(4, 205_000)]).lines[0]!.lineTotalText, "$41.96");
  assert.equal(cart([line(10, 205_000)]).lines[0]!.lineTotalText, "$104.90");
});

test("several lines: the subtotal is the sum of the lines shown, and the bill adds up", () => {
  const model = cart([line(2, 205_000), line(3, 689_000), line(1, 99_000)]);
  const totals = model.lines.map((item) => cents(item.lineTotalText!));
  const subtotal = totals.reduce((sum, cents) => sum + cents, 0);
  assert.equal(cents(model.subtotalText), subtotal);
  const summary = model.summary!;
  assert.equal(cents(summary.valueText), subtotal);
  assert.equal(cents(summary.totalText), subtotal + (summary.shippingText === "Miễn phí" ? 0 : cents(summary.shippingText)));
  for (const item of model.lines) assert.equal(cents(item.lineTotalText!), item.quantity * cents(item.priceText));
});

test("a struck-through catalog price is shown at its own ending, and the discount does not change the arithmetic", () => {
  const model = cart([line(3, 600_000, { basePrice: 800_000 } as Partial<StorefrontCartLine>)]);
  const item = model.lines[0]!;
  assert.equal(item.originalPriceText, usd(800_000));
  assert.equal(item.priceText, usd(600_000));
  assert.equal(cents(item.lineTotalText!), 3 * cents(item.priceText));
});

test("a line that cannot be bought keeps no dollar total, and the subtotal counts only what is bought", () => {
  const gone = line(2, 300_000, { available: false } as Partial<StorefrontCartLine>);
  const model = cart([line(1, 205_000), gone]);
  assert.equal(model.lines[1]!.lineTotalText, undefined);
  assert.equal(model.subtotalText, usd(205_000));
});

test("Vietnamese is left alone: the transform is only applied for English", () => {
  const raw = buildCartViewModel({ lines: [line(4, 205_000)], commerceTrackingEnabled: false });
  assert.match(raw.lines[0]!.lineTotalText!, /^820\.000\s₫$/u);
  assert.match(raw.subtotalText, /^820\.000\s₫$/u);
});

test("shareAmount shares a total over its rows exactly, the last row taking the remainder", () => {
  assert.deepEqual(shareAmount(1_000, []), []);
  assert.deepEqual(shareAmount(1_000, [40_000]), [1_000]);
  // 100.000 dong is $5.00 each; the last row takes the odd cent.
  assert.deepEqual(shareAmount(1_000, [100_000, 100_000]), [500, 500]);
  assert.deepEqual(shareAmount(1_001, [100_000, 100_000]), [500, 501]);
  // Earlier rows that already exceed the total are cut back from the end, never below zero.
  const clipped = shareAmount(600, [20_000, 20_000]);
  assert.equal(clipped.reduce((sum, cents) => sum + cents, 0), 600);
  assert.ok(clipped.every((cents) => cents >= 0));
});

test("checkout: the lines, subtotal, shipping and total add up from the prices shown", () => {
  const lines = [line(4, 205_000), line(2, 689_000)];
  const merchandise = 4 * 205_000 + 2 * 689_000;
  const model = usdCheckout(buildCheckoutViewModel({
    lines,
    totals: { items: [], merchandiseSubtotalVnd: merchandise, shippingFeeVnd: 30_000, totalVnd: merchandise + 30_000, totalQuantity: 6 } as never,
    quoteProof: "proof",
  }));
  const totals = model.totals!;
  const lineCents = model.lines.map((item) => cents(item.lineTotalText!));
  for (const item of model.lines) assert.equal(cents(item.lineTotalText), item.quantity * cents(item.unitPriceText!));
  assert.equal(cents(totals.subtotalText), lineCents.reduce((sum, value) => sum + value, 0));
  assert.equal(totals.shippingText, "$1.49");
  assert.equal(cents(totals.totalText), cents(totals.subtotalText) + 149);
  // The dong figures the order is charged are untouched.
  assert.equal(totals.totalVnd, merchandise + 30_000);
  assert.equal(cents(model.summary!.totalText), cents(totals.totalText));
});

test("checkout: free shipping stays free and a quote that is not ready is left as it is", () => {
  const merchandise = 3 * 689_000;
  const free = usdCheckout(buildCheckoutViewModel({
    lines: [line(3, 689_000)],
    totals: { items: [], merchandiseSubtotalVnd: merchandise, shippingFeeVnd: 0, totalVnd: merchandise, totalQuantity: 3 } as never,
    quoteProof: "proof",
  }));
  assert.equal(free.totals!.shippingText, "Miễn phí");
  assert.equal(free.totals!.totalText, free.totals!.subtotalText);
  const empty = buildCheckoutViewModel({ lines: [], totals: null, quoteProof: null });
  assert.equal(usdCheckout(empty), empty);
});

/* ----------------------------------------------------------------------------- quantity tiers, discounts, vouchers */

import type { CartGiftState } from "../../src/commerce/cart-gift-selection.ts";

function tierState(): CartGiftState {
  const paid = line(5, 689_000, { variantId: "paid", pancakeVariationId: "var-1" } as Partial<StorefrontCartLine>);
  const step = { campaignId: "tier", source: "QUANTITY_TIER", kind: "QUANTITY_TIER", priority: 1, inputPriceVnd: 689_000, outputPriceVnd: 600_000, appliedQuantity: 3 };
  return {
    quote: {
      lines: [paid],
      benefits: {
        enabled: true, ok: true, subtotalVnd: 3 * 600_000 + 2 * 689_000, dropped: [], campaignNames: new Map([["tier", "Mua 3 giảm 13%"]]),
        groups: [
          { groupKey: "paid|disc", lineKey: "paid", quantity: 3, unitPriceVnd: 600_000, steps: [step] },
          { groupKey: "paid|full", lineKey: "paid", quantity: 2, unitPriceVnd: 689_000, steps: [] },
        ],
      },
    },
    labels: [], campaigns: [], entitlements: [], selections: [], validation: { ok: true, issues: [], summaries: [] },
  } as unknown as CartGiftState;
}

test("a quantity tier: the line total is the sum of its segments, the discount row closes the gap, the bill adds up", () => {
  const state = tierState();
  const model = usdCart(buildCartViewModel({
    lines: state.quote.lines as StorefrontCartLine[], giftState: state, benefitCheckoutOpen: true, commerceTrackingEnabled: false, shippingPolicy: { feeVnd: 30_000 },
  }));
  const item = model.lines[0]!;
  // 3 x $29.99 + 2 x $34.49
  assert.equal(item.lineTotalText, formatCents(3 * priceCentsFromVnd(600_000) + 2 * priceCentsFromVnd(689_000)));
  assert.deepEqual(item.paidSegments, [`3 × ${usd(600_000)}`, `2 × ${usd(689_000)}`]);
  assert.equal(model.subtotalText, item.lineTotalText);
  const summary = model.summary;
  assert.ok(summary, "the bill is shown");
  const discounts = summary.discounts.reduce((sum, row) => sum + cents(row.amountText.replace("−", "")), 0);
  assert.ok(summary.discounts.length > 0 && discounts > 0, "the tier is a named discount");
  const shipping = summary.shippingText === "Miễn phí" ? 0 : cents(summary.shippingText);
  assert.equal(cents(summary.valueText) - discounts, cents(model.subtotalText), "value - discounts = what the lines come to");
  assert.equal(cents(summary.totalText), cents(model.subtotalText) + shipping);
  // And the value row is what the lines come to at the plain unit price.
  assert.equal(cents(summary.valueText), 5 * priceCentsFromVnd(689_000));
});

test("a shipping voucher: the fee is printed whole and the waived part under it, so the rows add up as printed", () => {
  const state = tierState();
  const base = buildCartViewModel({ lines: state.quote.lines as StorefrontCartLine[], giftState: state, benefitCheckoutOpen: true, commerceTrackingEnabled: false, shippingPolicy: { feeVnd: 30_000 } });
  assert.ok(base.summary);
  // The quote's net fee is 0 and the voucher waived 30.000 dong.
  const facts = { ...base.summary.facts, shippingFeeVnd: 0, shippingWaivedVnd: 30_000 };
  const withVoucher = { ...base, summary: { ...base.summary, shippingText: "Miễn phí", shippingVoucher: { label: "Freeship", amountText: "−30.000 ₫" }, facts } };
  const shown = usdCart(withVoucher as typeof base);
  const summary = shown.summary!;
  assert.equal(summary.shippingText, usd(30_000), "the whole fee, $1.49");
  assert.equal(summary.shippingVoucher!.amountText, `−${usd(30_000)}`);
  const discounts = summary.discounts.reduce((sum, row) => sum + cents(row.amountText.replace("−", "")), 0);
  assert.equal(cents(summary.valueText) - discounts + cents(summary.shippingText) - cents(summary.shippingVoucher!.amountText.replace("−", "")), cents(summary.totalText), "printed rows add up");
  assert.equal(summary.totalText, shown.subtotalText, "nothing left to pay for shipping");
});

import { buildOrderSummary } from "../../src/routes/order-summary-model.ts";
import { usdVoucherPicker } from "../../src/i18n/usd-bill.ts";
import type { VoucherPickerModel } from "../../src/routes/voucher-picker-model.ts";

/** 4 x 205.000 dong with a 50.000 dong voucher the quote has shared over the units: 192.500 each. */
function heldVoucherCheckout() {
  const plain = buildCheckoutViewModel({
    lines: [line(4, 205_000)],
    totals: { items: [], merchandiseSubtotalVnd: 770_000, shippingFeeVnd: 30_000, totalVnd: 800_000, totalQuantity: 4 } as never,
    quoteProof: "proof",
  });
  const summary = buildOrderSummary({
    goodsAfterDiscountsVnd: 770_000,
    discounts: [{ id: "voucher:m", label: "Giảm 50K", amountVnd: 50_000, amountText: "50.000 ₫" }],
    shippingFeeVnd: 30_000,
    expectedTotalVnd: 800_000,
    expectedValueVnd: 820_000,
  })!;
  return {
    ...plain,
    lines: plain.lines.map((item) => ({ ...item, unitPriceVnd: 192_500, preVoucherUnitVnd: 205_000, listedUnitVnd: 205_000, unitPriceText: "192.500 ₫", lineTotalText: "770.000 ₫" })),
    summary,
    vouchers: { state: "HELD" as const, heldUntilMs: null, savingText: "50.000đ", lines: [{ id: "m", title: "Giảm 50K", amountText: "−50.000đ", kind: "MERCHANDISE" as const }] },
  };
}

test("checkout with a held merchandise voucher: lines before the voucher, one voucher row, the amount the picker shows", () => {
  const model = usdCheckout(heldVoucherCheckout());
  // 4 x $10.49 = $41.96, then the voucher: the dollar price of 50.000 dong, $2.49 (not $4.00).
  assert.equal(model.lines[0]!.unitPriceText, "$10.49");
  assert.equal(model.lines[0]!.lineTotalText, "$41.96");
  const summary = model.summary!;
  assert.deepEqual(summary.discounts.map((row) => row.amountText), ["−$2.49"]);
  assert.equal(summary.valueText, "$41.96");
  assert.equal(model.totals!.subtotalText, "$39.47");
  assert.equal(summary.shippingText, "$1.49");
  assert.equal(summary.totalText, "$40.96");
  assert.equal(model.totals!.totalText, "$40.96");
  // The checkout's own voucher panel says the same amount.
  const held = model.vouchers!;
  assert.equal(held.state, "HELD");
  if (held.state === "HELD") {
    assert.equal(held.lines[0]!.amountText, "−$2.49");
    assert.equal(held.savingText, "$2.49");
  }
  // And the dong the order is charged is untouched.
  assert.equal(model.totals!.totalVnd, 800_000);
});

function pickerOf(overrides: Partial<VoucherPickerModel["summary"]> = {}): VoucherPickerModel {
  return {
    previewNotHeld: true,
    groups: [],
    summary: {
      paidBeforeText: "820.000đ", merchandiseDiscountText: "-50.000đ", merchandiseLines: [], shippingFeeText: "30.000đ", shippingDiscountText: null,
      totalText: "800.000đ", totalVnd: 800_000, facts: { paidBeforeVnd: 820_000, merchandiseDiscountVnd: 50_000, shippingFeeVnd: 30_000, shippingDiscountVnd: 0 },
      discountLines: [{ id: "m", label: "Giảm 50K", amountText: "-50.000đ", amountVnd: 50_000, tone: "clay" }], savingText: "50.000đ", savingVnd: 50_000,
      ...overrides,
    },
    footer: { label: "Áp dụng · Giảm 50.000đ", count: 1 },
    quoteDigest: null, selectionVersion: null,
    warnings: { giftLoss: null, totalIncrease: null, notices: [] },
  } as unknown as VoucherPickerModel;
}

test("the voucher picker is measured from the bill's subtotal, and answers to every choice keep it there", () => {
  const basis = 4 * 1049;
  const picked = usdVoucherPicker(pickerOf(), basis);
  assert.equal(picked.summary.paidBeforeText, "$41.96");
  assert.equal(picked.summary.merchandiseDiscountText, "-$2.49");
  assert.equal(picked.summary.totalText, "$40.96");
  assert.equal(picked.footer.label, "Áp dụng · Giảm $2.49");
  // Another answer of the server (no voucher, then a shipping voucher): the goods total never moves.
  const none = usdVoucherPicker(pickerOf({ merchandiseDiscountText: null, totalText: "850.000đ", facts: { paidBeforeVnd: 820_000, merchandiseDiscountVnd: 0, shippingFeeVnd: 30_000, shippingDiscountVnd: 0 }, discountLines: [], savingVnd: 0, savingText: null }), basis);
  assert.equal(none.summary.paidBeforeText, "$41.96");
  assert.equal(none.summary.merchandiseDiscountText, null);
  const freeship = usdVoucherPicker(pickerOf({ shippingFeeText: "0đ", shippingDiscountText: "-30.000đ", facts: { paidBeforeVnd: 820_000, merchandiseDiscountVnd: 50_000, shippingFeeVnd: 0, shippingDiscountVnd: 30_000 } }), basis);
  assert.equal(freeship.summary.paidBeforeText, "$41.96");
  assert.equal(freeship.summary.shippingFeeText, "$1.49", "the whole fee, then the waived part");
  assert.equal(freeship.summary.shippingDiscountText, "-$1.49");
  assert.equal(freeship.summary.totalText, "$39.47");
  // Applying it twice changes nothing.
  assert.deepEqual(usdVoucherPicker(picked, basis).summary, picked.summary);
});

/* -------------------------------------------------------------- two merchandise vouchers, and the list-price badge */

import type { BenefitCheckoutRender } from "../../src/commerce/benefit-checkout-render.ts";
import { benefitQuoteDigest, issueBenefitQuoteProof } from "../../src/commerce/checkout-quote-proof.ts";
import { buildBenefitCheckoutQuoteFacts } from "../../src/commerce/checkout-quote.ts";
import { buildBenefitCheckoutViewModel, buildCheckoutVoucherView } from "../../src/routes/checkout-model.ts";

const secret = "test-server-secret-at-least-32-characters-long";
const cartId = "0f8d3c2a-4b1e-4d7a-9c6b-2e5f1a8d4c30";
const VOUCHER_A = "voucher-a";
const VOUCHER_B = "voucher-b";

function step(campaignId: string, input: number, output: number, quantity: number) {
  return { campaignId, source: "VOUCHER" as const, campaignKind: "VOUCHER_MERCHANDISE", priority: null, inputPriceVnd: input, outputPriceVnd: output, appliedQuantity: quantity };
}

/** 4 x 205.000, voucher A takes 50.000 (205.000 -> 192.500 each), voucher B takes 20.000 more (-> 187.500). */
function stackedRender(): Extract<BenefitCheckoutRender, { kind: "BENEFIT" }> {
  const quote = buildBenefitCheckoutQuoteFacts({
    paid: [{ groupKey: "g|v0", pancakeVariationId: "p-205000", quantity: 4, unitPriceVnd: 187_500, steps: [step(VOUCHER_A, 205_000, 192_500, 4), step(VOUCHER_B, 192_500, 187_500, 4)], fulfillmentState: "READY" }],
    gifts: [],
    entitlements: [],
  })!;
  return {
    kind: "BENEFIT",
    facts: quote,
    proof: issueBenefitQuoteProof({ quote, cartId, secret })!,
    digest: benefitQuoteDigest(quote),
    needsAcknowledgement: false,
    giftLabels: new Map(),
    tierDropped: false,
    voucher: {
      shippingWaivedVnd: 0, names: new Map([[VOUCHER_A, "Voucher A"], [VOUCHER_B, "Voucher B"]]),
      merchandise: [{ campaignId: VOUCHER_A, amountVnd: 50_000 }, { campaignId: VOUCHER_B, amountVnd: 20_000 }],
      shippingCampaignId: null, merchandiseDiscountVnd: 70_000,
    },
  };
}

function stackedCheckout() {
  const render = stackedRender();
  const model = buildBenefitCheckoutViewModel({ lines: [line(4, 205_000)], render });
  const vouchers = buildCheckoutVoucherView({ render, picker: null, heldUntilMs: null });
  return { render, model: { ...model, ...(vouchers === null ? {} : { vouchers }) } };
}

test("two merchandise vouchers on one line: the price before both, both amounts shared out of what they took off in all", () => {
  const { model } = stackedCheckout();
  // In dong the bill is shown, with both vouchers as rows, and the line is priced after both.
  assert.ok(model.summary, "the dong bill closes with every voucher step counted");
  assert.deepEqual(model.summary.discounts.map((row) => row.amountVnd), [50_000, 20_000]);
  assert.equal(model.lines[0]!.preVoucherUnitVnd, 205_000);
  assert.equal(model.lines[0]!.unitPriceVnd, 187_500);

  const shown = usdCheckout(model);
  assert.equal(shown.lines[0]!.unitPriceText, "$10.49");
  assert.equal(shown.lines[0]!.lineTotalText, "$41.96");
  // $41.96 - $3.49 (the dollar price of 70.000 dong) + $1.49 = $39.96, as the picker says.
  assert.equal(shown.totals!.subtotalText, "$38.47");
  assert.equal(shown.totals!.totalText, "$39.96");
  const held = shown.vouchers!;
  assert.equal(held.state, "HELD");
  if (held.state === "HELD") {
    assert.deepEqual(held.lines.map((entry) => entry.amountText), ["−$2.50", "−$0.99"]);
    assert.equal(shown.summary!.discounts.reduce((sum, row) => sum + cents(row.amountText.replace("−", "")), 0), 349, "the rows add up to $3.49");
    assert.deepEqual(shown.summary!.discounts.map((row) => row.amountText), held.lines.map((entry) => entry.amountText), "the bill and the panel agree row by row");
  }
  assert.equal(cents(shown.summary!.valueText) - 349 + cents(shown.summary!.shippingText), cents(shown.summary!.totalText));
});

test("the list-price badge is measured on the prices displayed, not on the quote's post-voucher price", () => {
  process.env.LIST_PRICE_DISPLAY = "true";
  try {
    const render = stackedRender();
    // One voucher of 50.000 over the four units, so the quote's price is 192.500 and the pre-voucher price 205.000.
    const quote = buildBenefitCheckoutQuoteFacts({
      paid: [{ groupKey: "g|v0", pancakeVariationId: "p-205000", quantity: 4, unitPriceVnd: 192_500, steps: [step(VOUCHER_A, 205_000, 192_500, 4)], fulfillmentState: "READY" }],
      gifts: [],
      entitlements: [],
    })!;
    const single = { ...render, facts: quote, proof: issueBenefitQuoteProof({ quote, cartId, secret })!, digest: benefitQuoteDigest(quote), voucher: { ...render.voucher!, merchandise: [{ campaignId: VOUCHER_A, amountVnd: 50_000 }], merchandiseDiscountVnd: 50_000 } };
    const model = buildBenefitCheckoutViewModel({ lines: [line(4, 205_000)], render: single });
    // In dong: the list price 249.000 against the quote's 192.500 is -23%.
    assert.equal(model.lines[0]!.originalPriceVnd, 249_000);
    assert.equal(model.lines[0]!.discountPercent, 23);
    // In dollars the buyer sees $12.49 beside $10.49, which is -16%.
    const shown = usdCheckout(model).lines[0]!;
    assert.equal(shown.originalPriceText, "$12.49");
    assert.equal(shown.unitPriceText, "$10.49");
    assert.equal(shown.discountPercent, 16);
  } finally {
    delete process.env.LIST_PRICE_DISPLAY;
  }
});

test("the cart's badge follows the displayed pair too, and goes when the pair shows no reduction", () => {
  const sale = cart([line(1, 600_000, { basePrice: 800_000 } as Partial<StorefrontCartLine>)]).lines[0]!;
  // $39.99 -> $29.99 is -25%, as 800.000 -> 600.000 is.
  assert.equal(sale.discountPercent, 25);
  // 1.000.000 -> 999.999 dong is under 1%: the strike-through stays with no badge, as in dong.
  const tiny = cart([line(1, 999_999, { basePrice: 1_000_000 } as Partial<StorefrontCartLine>)]).lines[0]!;
  assert.equal(tiny.discountPercent, undefined);
});

test("an offer not yet held shows the same voucher amounts as the picker, and as the held panel after it", () => {
  const { model } = stackedCheckout();
  const picker = {
    ...pickerOf({
      paidBeforeText: "820.000đ", merchandiseDiscountText: "-70.000đ", shippingFeeText: "30.000đ", shippingDiscountText: null, totalText: "780.000đ", totalVnd: 780_000,
      facts: { paidBeforeVnd: 820_000, merchandiseDiscountVnd: 70_000, shippingFeeVnd: 30_000, shippingDiscountVnd: 0 },
      discountLines: [
        { id: VOUCHER_A, label: "Voucher A", amountText: "-50.000đ", amountVnd: 50_000, tone: "clay" },
        { id: VOUCHER_B, label: "Voucher B", amountText: "-20.000đ", amountVnd: 20_000, tone: "teal" },
      ],
      savingText: "70.000đ", savingVnd: 70_000,
    }),
  };
  const offered = {
    ...model,
    voucherPicker: picker,
    vouchers: {
      state: "OFFERED" as const, digest: "d".repeat(64), totalText: "780.000đ", giftLossText: null, totalIncreaseText: null, afterStale: false,
      lines: [
        { id: VOUCHER_A, title: "Voucher A", amountText: "-50.000đ", kind: "MERCHANDISE" as const },
        { id: VOUCHER_B, title: "Voucher B", amountText: "-20.000đ", kind: "MERCHANDISE" as const },
      ],
    },
  };
  const shown = usdCheckout(offered);
  const lines = shown.vouchers!.state === "OFFERED" ? shown.vouchers!.lines.map((entry) => entry.amountText) : [];
  // Independently converted these would be -$2.49 and -$0.99 ($3.48), against the $3.49 the total takes off.
  assert.deepEqual(lines, ["-$2.50", "-$0.99"]);
  assert.deepEqual(lines, shown.voucherPicker!.summary.discountLines.map((entry) => entry.amountText), "as the picker");
  const held = usdCheckout(model).vouchers!;
  assert.equal(held.state, "HELD");
  if (held.state === "HELD") assert.deepEqual(held.lines.map((entry) => entry.amountText.replace("−", "-")), lines, "and as the held panel");
  assert.equal(shown.vouchers!.state === "OFFERED" ? shown.vouchers!.totalText : "", "$39.96");
});
