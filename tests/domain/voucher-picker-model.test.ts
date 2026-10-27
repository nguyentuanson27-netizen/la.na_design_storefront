import assert from "node:assert/strict";
import test from "node:test";

import type { VoucherPaidLine } from "../../src/commerce/voucher-allocation.ts";
import type { VoucherCampaign } from "../../src/commerce/voucher-campaign.ts";
import { toVoucherCard } from "../../src/commerce/voucher-candidate-repository.ts";
import { buildVoucherQuote, type VoucherQuote, type VoucherQuoteInput } from "../../src/commerce/voucher-quote.ts";
import { validateVoucherCampaign } from "../../src/commerce/voucher-rule-validation.ts";
import { buildVoucherPickerModel, formatVoucherVnd } from "../../src/routes/voucher-picker-model.ts";

const SHOP = 940_013;
const line = (lineId: string, quantity: number, unitPriceVnd: number): VoucherPaidLine => ({ lineId, product: { productId: lineId, shopId: String(SHOP), categoryKeys: [] }, quantity, unitPriceVnd });

function campaign(id: string, input: Record<string, unknown>): VoucherCampaign {
  const parsed = validateVoucherCampaign({ name: id, kind: "MERCHANDISE", issuance: "AUTO", visibility: "PUBLIC", scope: { mode: "ALL_SHOP", excludeProductIds: [] }, ...input });
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  return { ...(parsed as { value: object }).value, id, pancakeShopId: SHOP, revision: 1, isEnabled: true, enabledAt: new Date("2026-10-01T00:00:00Z"), disabledAt: null, redeemedUses: 0, redeemedVnd: 0, reservedUses: 0, reservedVnd: 0 } as VoucherCampaign;
}
const fixed = (id: string, amountVnd: number, min: number, extra: Record<string, unknown> = {}) => campaign(id, { discount: { type: "FIXED_AMOUNT_VND", amountVnd }, minEligibleSubtotalVnd: min, ...extra });
const percent = (id: string, pct: number, cap: number | null, min: number | null) => campaign(id, { discount: { type: "PERCENTAGE", percent: pct, maxDiscountVnd: cap }, minEligibleSubtotalVnd: min });
const freeship = (id: string, min: number | null, extra: Record<string, unknown> = {}) => campaign(id, { kind: "SHIPPING_FREE", minEligibleSubtotalVnd: min, ...extra });

function model(campaigns: VoucherCampaign[], lines: VoucherPaidLine[], overrides: Partial<VoucherQuoteInput> = {}) {
  const quote = buildVoucherQuote({ lines, campaigns, existingOtherPromotions: false, campaignShippingFeeVnd: () => 30_000, giftOutcome: () => ({ entitledSlots: 0, retainedSelectedSlots: 0 }), ...overrides });
  assert.equal(quote.ok, true);
  const ok = quote as Extract<VoucherQuote, { ok: true }>;
  const cards = new Map(campaigns.map((c) => [c.id, toVoucherCard(c)]));
  return { ok, view: buildVoucherPickerModel({ quote: ok, entries: ok.cards.map((state) => ({ card: cards.get(state.campaignId)!, state })) }) };
}

test("money is formatted the way the storefront does: 30.000đ", () => {
  assert.equal(formatVoucherVnd(30_000), "30.000đ");
  assert.equal(formatVoucherVnd(1_250_500), "1.250.500đ");
});

test("AC-12: two groups, each with a NONE option and a hint, in the spec's wording", () => {
  const { view } = model([fixed("m30", 30_000, 600_000), freeship("s500", 500_000)], [line("a", 1, 620_000)]);
  assert.deepEqual(view.groups.map((g) => [g.kind, g.heading, g.hint, g.noneLabel]), [
    ["MERCHANDISE", "Voucher giảm tiền hàng", "Chọn 1", "Không dùng voucher giảm tiền hàng"],
    ["SHIPPING_FREE", "Voucher vận chuyển", "Chọn 1", "Không dùng voucher vận chuyển"],
  ]);
  assert.equal(view.previewNotHeld, true);
});

test("AC-11: a disabled card is dimmed, selectable=false, with the exact 'Đặt thêm' line from the server subtotal", () => {
  const { view } = model([fixed("far", 53_000, 600_000)], [line("a", 1, 439_500)]);
  const item = view.groups[0].items[0]!;
  assert.equal(item.selectable, false);
  assert.equal(item.disabledReason, "Đặt thêm 160.500đ để được hưởng ưu đãi này");
  assert.equal(item.shortfallVnd, 160_500);
  assert.equal(item.title, "Giảm 53.000đ");
  assert.equal(item.condition, "Đơn từ 600.000đ");
});

test("titles and conditions: fixed, percentage with cap, and free shipping", () => {
  const { view } = model([percent("p10", 10, 100_000, null), freeship("s", 500_000)], [line("a", 1, 620_000)]);
  const pct = view.groups[0].items.find((i) => i.id === "p10")!;
  assert.deepEqual([pct.title, pct.condition], ["Giảm 10%", "Tối đa 100.000đ"]);
  const ship = view.groups[1].items[0]!;
  assert.deepEqual([ship.title, ship.condition], ["Miễn phí vận chuyển", "Đơn từ 500.000đ"]);
});

test("reasons are text, not just dimming (spec 7.4): exhausted, not applicable, shipping already free", () => {
  const exhausted = campaign("full", { discount: { type: "FIXED_AMOUNT_VND", amountVnd: 10_000 }, minEligibleSubtotalVnd: 20_000, maxUses: 1 });
  const { view } = model([{ ...exhausted, redeemedUses: 1 }, freeship("free", null)], [line("a", 1, 700_000)], { campaignShippingFeeVnd: () => 0 });
  assert.equal(view.groups[0].items[0]!.disabledReason, "Hết lượt");
  assert.equal(view.groups[1].items[0]!.disabledReason, "Phí vận chuyển đã được miễn");
});

test("order: usable cards first by saving, then the nearest to qualifying; ids break ties", () => {
  const { view } = model(
    [fixed("b-small", 10_000, 50_000), fixed("a-big", 40_000, 50_000), fixed("far", 90_000, 900_000), fixed("near", 80_000, 700_000)],
    [line("a", 1, 650_000)],
  );
  assert.deepEqual(view.groups[0].items.map((i) => i.id), ["a-big", "b-small", "near", "far"]);
});

test("the selected card and the NONE option follow the server's choice; the footer counts only real savings", () => {
  const { view, ok } = model([fixed("m", 30_000, 100_000), freeship("s", null)], [line("a", 1, 620_000)]);
  assert.equal(ok.voucherCount, 2);
  assert.deepEqual(view.footer, { label: "Áp dụng • 2 ưu đãi", count: 2 });
  assert.equal(view.groups[0].noneSelected, false);
  assert.equal(view.groups[0].items[0]!.selected, true);
  assert.equal(view.groups[0].items[0]!.savingText, "-30.000đ");
  const none = model([], [line("a", 1, 100_000)]);
  assert.deepEqual(none.view.footer, { label: "Bỏ qua ưu đãi và tiếp tục", count: 0 });
  assert.equal(none.view.groups[0].noneSelected, true);
});

test("the summary reconciles and words every line: subtotal, discounts, fee, total", () => {
  const { view } = model([fixed("m", 30_000, 100_000), freeship("s", null)], [line("a", 1, 620_000)]);
  assert.deepEqual(view.summary, {
    paidBeforeText: "620.000đ", merchandiseDiscountText: "-30.000đ", shippingFeeText: "0đ", shippingDiscountText: "-30.000đ", totalText: "590.000đ", totalVnd: 590_000,
  });
});

test("warnings: a lost gift, and the manual choice that raises the total with its fee (EX-06)", () => {
  const gift = model([fixed("m50", 50_000, 100_000)], [line("a", 1, 620_000)], {
    giftOutcome: (lines) => (lines.reduce((s, l) => s + l.quantity * l.unitPriceVnd, 0) >= 600_000 ? { entitledSlots: 1, retainedSelectedSlots: 1 } : { entitledSlots: 0, retainedSelectedSlots: 0 }),
  });
  assert.match(gift.view.warnings.giftLoss!, /làm mất 1 suất quà/);
  // When a choice was made, the consent says what happens to it (AC-35): it is removed from the cart.
  assert.match(gift.view.warnings.giftLoss!, /quà đã chọn sẽ được bỏ khỏi giỏ hàng/);
  assert.equal(gift.view.warnings.totalIncrease, null);

  const ex06 = model([fixed("m10", 10_000, 50_000)], [line("a", 1, 100_000)], {
    campaignShippingFeeVnd: (hasOther) => (hasOther ? 30_000 : 0),
    selection: { merchandise: { mode: "MANUAL", voucherId: "m10" }, shipping: { mode: "AUTO" } },
  });
  assert.equal(ex06.view.warnings.totalIncrease, "Phí vận chuyển tăng 30.000đ; tổng đơn tăng 20.000đ so với không dùng voucher.");
});

test("a stale manual choice becomes a plain notice, never an internal code", () => {
  const { view } = model([fixed("m", 30_000, 100_000)], [line("a", 1, 620_000)], { selection: { merchandise: { mode: "MANUAL", voucherId: "gone" }, shipping: { mode: "AUTO" } } });
  assert.deepEqual(view.warnings.notices, ["Voucher giảm tiền hàng đã chọn không còn dùng được cho giỏ này, nên đã chọn lại ưu đãi tốt nhất."]);
});

test("a private code is never shown in the model; a public code voucher exposes its code", () => {
  const { view } = model(
    [fixed("pub", 10_000, 50_000, { issuance: "CODE", code: "PUBLIC10" }), fixed("priv", 20_000, 50_000, { issuance: "CODE", visibility: "PRIVATE", code: "SECRETKOL" })],
    [line("a", 1, 620_000)],
  );
  const text = JSON.stringify(view);
  assert.match(text, /PUBLIC10/);
  assert.doesNotMatch(text, /SECRETKOL/);
});

test("the model carries no internal fields: ledger, budget, shop id, campaign revision or amounts the browser could trust", () => {
  const { view } = model([fixed("m", 30_000, 100_000, { maxUses: 5, maxBudgetVnd: 1_000_000 })], [line("a", 1, 620_000)]);
  assert.doesNotMatch(JSON.stringify(view), /maxUses|maxBudget|reserved|redeemed|pancakeShopId|revision/i);
});
