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

test("a shipping voucher shows the waived part and a total built from the net fee", () => {
  const state = tierState();
  const base = buildCartViewModel({ lines: state.quote.lines as StorefrontCartLine[], giftState: state, benefitCheckoutOpen: true, commerceTrackingEnabled: false, shippingPolicy: { feeVnd: 30_000 } });
  assert.ok(base.summary);
  // The quote's net fee is 0 and the voucher waived 30.000 dong.
  const facts = { ...base.summary.facts, shippingFeeVnd: 0, shippingWaivedVnd: 30_000 };
  const withVoucher = { ...base, summary: { ...base.summary, shippingText: "Miễn phí", shippingVoucher: { label: "Freeship", amountText: "−30.000 ₫" }, facts } };
  const summary = usdCart(withVoucher as typeof base).summary!;
  assert.equal(summary.shippingText, "Miễn phí");
  assert.equal(summary.shippingVoucher!.amountText, `−${usd(30_000)}`);
  assert.equal(summary.totalText, usdCart(withVoucher as typeof base).subtotalText);
});
