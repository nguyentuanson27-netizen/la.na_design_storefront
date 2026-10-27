import assert from "node:assert/strict";
import test from "node:test";

import type { VoucherPaidLine } from "../../src/commerce/voucher-allocation.ts";
import type { VoucherCampaign } from "../../src/commerce/voucher-campaign.ts";
import type { GiftOutcome } from "../../src/commerce/voucher-optimizer.ts";
import { applyAllocationToLines, buildVoucherQuote, type VoucherQuote, type VoucherQuoteInput } from "../../src/commerce/voucher-quote.ts";
import { validateVoucherCampaign } from "../../src/commerce/voucher-rule-validation.ts";

const SHOP = 940_010;
const line = (lineId: string, quantity: number, unitPriceVnd: number, productId = `p-${lineId}`, categoryKeys: string[] = []): VoucherPaidLine => ({
  lineId,
  product: { productId, shopId: String(SHOP), categoryKeys },
  quantity,
  unitPriceVnd,
});

let seq = 0;
function campaign(input: Record<string, unknown>, ledger: Partial<Pick<VoucherCampaign, "redeemedUses" | "reservedUses" | "redeemedVnd" | "reservedVnd">> = {}): VoucherCampaign {
  const parsed = validateVoucherCampaign({
    name: "v",
    kind: "MERCHANDISE",
    issuance: "AUTO",
    visibility: "PUBLIC",
    scope: { mode: "ALL_SHOP", excludeProductIds: [] },
    ...input,
  });
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  const value = (parsed as { value: object }).value;
  seq += 1;
  return {
    ...value,
    id: String(input.id ?? `c${seq}`),
    pancakeShopId: SHOP,
    revision: 1,
    isEnabled: true,
    enabledAt: new Date("2026-10-01T00:00:00Z"),
    disabledAt: null,
    redeemedUses: 0,
    redeemedVnd: 0,
    reservedUses: 0,
    reservedVnd: 0,
    ...ledger,
  } as VoucherCampaign;
}
const fixed = (id: string, amountVnd: number, minEligibleSubtotalVnd: number, extra: Record<string, unknown> = {}) =>
  campaign({ id, discount: { type: "FIXED_AMOUNT_VND", amountVnd }, minEligibleSubtotalVnd, ...extra });
const freeship = (id: string, minEligibleSubtotalVnd: number | null, extra: Record<string, unknown> = {}) =>
  campaign({ id, kind: "SHIPPING_FREE", minEligibleSubtotalVnd, ...extra });

const noGifts = (): GiftOutcome => ({ entitledSlots: 0, retainedSelectedSlots: 0 });
function quote(overrides: Partial<VoucherQuoteInput> & Pick<VoucherQuoteInput, "lines" | "campaigns">): Extract<VoucherQuote, { ok: true }> {
  const result = buildVoucherQuote({
    existingOtherPromotions: false,
    campaignShippingFeeVnd: () => 30_000,
    giftOutcome: noGifts,
    ...overrides,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result as Extract<VoucherQuote, { ok: true }>;
}
const card = (result: Extract<VoucherQuote, { ok: true }>, id: string) => result.cards.find((entry) => entry.campaignId === id)!;

test("EX-01: P=620K; 40K voucher drops freeship (610K) but 20K + freeship pays 600K, so the quote picks 20K + freeship", () => {
  const result = quote({
    lines: [line("a", 1, 620_000)],
    campaigns: [fixed("m40", 40_000, 100_000), fixed("m20", 20_000, 100_000), freeship("s600", 600_000)],
  });
  assert.deepEqual(result.selection, { merchandiseId: "m20", shippingId: "s600" });
  assert.equal(result.totalPayableVnd, 600_000);
  assert.equal(result.baselineTotalVnd, 650_000);
  assert.equal(result.paidBeforeVnd, 620_000);
  assert.equal(result.paidAfterVnd, 600_000);
  assert.equal(result.shippingFeeVnd, 0);
  assert.equal(result.voucherCount, 2);
  assert.equal(result.held, false, "a preview never claims a hold");
  assert.equal(card(result, "m20").state, "SELECTED");
  assert.equal(card(result, "s600").state, "SELECTED");
  assert.deepEqual([card(result, "m40").state, card(result, "m40").savingVnd], ["AVAILABLE", 40_000]);
});

test("AC-11 / spec 7.3: a card under its minimum is disabled with the exact shortfall from the in-scope subtotal", () => {
  const result = quote({ lines: [line("a", 1, 440_000)], campaigns: [fixed("m50", 50_000, 600_000)] });
  assert.deepEqual(card(result, "m50"), { campaignId: "m50", kind: "MERCHANDISE", state: "UNAVAILABLE", reason: "BELOW_MINIMUM", shortfallVnd: 160_000, savingVnd: null });
  assert.deepEqual(result.selection, { merchandiseId: null, shippingId: null });
});

test("EX-03 / AC-06: a Dress-only voucher counts only Dress toward its threshold and discounts only Dress", () => {
  const lines = [line("dress", 1, 550_000, "dress", ["vayDam"]), line("bag", 1, 300_000, "bag", ["phuKien"])];
  const dressOnly = campaign({ id: "dress50", discount: { type: "FIXED_AMOUNT_VND", amountVnd: 50_000 }, minEligibleSubtotalVnd: 500_000, scope: { mode: "TARGETED", categoryKeys: ["vayDam"] } });
  const eligible = quote({ lines, campaigns: [dressOnly] });
  assert.deepEqual(eligible.allocation!.lines.map((entry) => [entry.lineId, entry.deductionVnd]), [["dress", 50_000]]);
  assert.equal(eligible.paidAfterVnd, 800_000);
  const short = quote({ lines: [line("dress", 1, 400_000, "dress", ["vayDam"]), line("bag", 1, 300_000, "bag", ["phuKien"])], campaigns: [dressOnly] });
  assert.equal(card(short, "dress50").reason, "BELOW_MINIMUM");
  assert.equal(card(short, "dress50").shortfallVnd, 100_000);
});

test("AC-09: after the merchandise voucher the freeship threshold is missed, and the card says by how much", () => {
  const result = quote({
    lines: [line("a", 1, 620_000)],
    campaigns: [fixed("m50", 50_000, 100_000), freeship("s600", 600_000)],
    selection: { merchandise: { mode: "MANUAL", voucherId: "m50" }, shipping: { mode: "AUTO" } },
  });
  assert.deepEqual(result.selection, { merchandiseId: "m50", shippingId: null });
  assert.equal(card(result, "s600").reason, "BELOW_MINIMUM");
  assert.equal(card(result, "s600").shortfallVnd, 30_000);
});

test("AC-10 / EX-04: shipping already free means the freeship card is unavailable and never selected", () => {
  const result = quote({ lines: [line("a", 1, 700_000)], campaigns: [freeship("s", null)], campaignShippingFeeVnd: () => 0 });
  assert.deepEqual(result.selection, { merchandiseId: null, shippingId: null });
  assert.equal(card(result, "s").reason, "FEE_ALREADY_ZERO");
});

test("EX-06 / AC-29: a non-stacking free-ship campaign falls under a merchandise voucher; auto keeps NONE, manual asks to confirm", () => {
  const input = {
    lines: [line("a", 1, 100_000)],
    campaigns: [fixed("m10", 10_000, 50_000)],
    campaignShippingFeeVnd: (hasOtherPromotions: boolean) => (hasOtherPromotions ? 30_000 : 0),
  };
  const auto = quote(input);
  assert.deepEqual(auto.selection, { merchandiseId: null, shippingId: null });
  assert.equal(auto.totalPayableVnd, 100_000);
  const manual = quote({ ...input, selection: { merchandise: { mode: "MANUAL", voucherId: "m10" }, shipping: { mode: "AUTO" } } });
  assert.equal(manual.totalPayableVnd, 120_000);
  assert.deepEqual(manual.confirmation, { totalIncreaseVnd: 20_000, shippingFeeIncreaseVnd: 30_000 });
  assert.equal(manual.shippingFeeBeforeVoucherVnd, 30_000);
});

test("EX-10 / AC-46: the voucher works on the post-tier lines it is given, 620K - 80K = 540K, and never re-tiers", () => {
  const result = quote({ lines: [line("a", 1, 620_000)], campaigns: [fixed("m80", 80_000, 600_000)] });
  assert.equal(result.paidBeforeVnd, 620_000);
  assert.equal(result.paidAfterVnd, 540_000);
  assert.equal(result.allocation!.discountVnd, 80_000);
  // The lines the gift/POS side sees are the voucher-adjusted ones, summing to the same 540K.
  const after = applyAllocationToLines([line("a", 1, 620_000)], result.allocation);
  assert.equal(after.reduce((sum, l) => sum + l.quantity * l.unitPriceVnd, 0), 540_000);
});

test("EX-02 / AC-08: a gift that needs 600K is lost under a 50K voucher; the quote reports the loss and the switch keeps it", () => {
  const giftAt = (min: number) => (lines: readonly VoucherPaidLine[]): GiftOutcome => {
    const total = lines.reduce((sum, l) => sum + l.quantity * l.unitPriceVnd, 0);
    return total >= min ? { entitledSlots: 1, retainedSelectedSlots: 1 } : { entitledSlots: 0, retainedSelectedSlots: 0 };
  };
  const campaigns = [fixed("m50", 50_000, 100_000), fixed("m10", 10_000, 100_000)];
  const money = quote({ lines: [line("a", 1, 620_000)], campaigns, giftOutcome: giftAt(600_000) });
  assert.equal(money.selection.merchandiseId, "m50");
  assert.deepEqual(money.giftLoss, { entitledSlotsLost: 1, selectedSlotsLost: 1 });
  const keep = quote({ lines: [line("a", 1, 620_000)], campaigns, giftOutcome: giftAt(600_000), selection: { merchandise: { mode: "MANUAL", voucherId: "m10" }, shipping: { mode: "AUTO" } } });
  assert.equal(keep.giftLoss, null);
  assert.equal(keep.gifts.entitledSlots, 1);
});

test("the gift side receives the lines split exactly where the discount landed", () => {
  const seen: number[][] = [];
  quote({
    lines: [line("a", 3, 100_000)],
    campaigns: [fixed("m10", 10_000, 100_000)],
    giftOutcome: (lines) => {
      seen.push(lines.map((l) => l.unitPriceVnd).sort());
      return noGifts();
    },
  });
  assert.ok(seen.some((prices) => prices.join() === [96_666, 96_667].join()), JSON.stringify(seen));
});

test("quota: an exhausted voucher is shown as EXHAUSTED and never selected; a budget too small for this cart's discount is too", () => {
  const result = quote({
    lines: [line("a", 1, 620_000)],
    campaigns: [
      fixed("full", 50_000, 100_000, { maxUses: 1 }),
      fixed("poor", 40_000, 100_000, { maxBudgetVnd: 100_000 }),
      fixed("ok", 10_000, 100_000),
    ],
  });
  // `full` has no use left, `poor` cannot afford a 40K grant on top of what is committed.
  const exhausted = quote({
    lines: [line("a", 1, 620_000)],
    campaigns: [
      campaign({ id: "full", discount: { type: "FIXED_AMOUNT_VND", amountVnd: 50_000 }, minEligibleSubtotalVnd: 100_000, maxUses: 1 }, { redeemedUses: 1 }),
      campaign({ id: "poor", discount: { type: "FIXED_AMOUNT_VND", amountVnd: 40_000 }, minEligibleSubtotalVnd: 100_000, maxBudgetVnd: 100_000 }, { redeemedVnd: 70_000 }),
      fixed("ok", 10_000, 100_000),
    ],
  });
  assert.equal(result.selection.merchandiseId, "full");
  assert.equal(exhausted.selection.merchandiseId, "ok");
  assert.equal(card(exhausted, "full").reason, "EXHAUSTED");
  assert.equal(card(exhausted, "poor").reason, "EXHAUSTED");
});

test("AC-31: the attempt's own held voucher is not counted against its own quota", () => {
  const onlySlotTaken = campaign({ id: "mine", discount: { type: "FIXED_AMOUNT_VND", amountVnd: 50_000 }, minEligibleSubtotalVnd: 100_000, maxUses: 1 }, { reservedUses: 1, reservedVnd: 50_000 });
  const without = quote({ lines: [line("a", 1, 620_000)], campaigns: [onlySlotTaken] });
  assert.equal(without.selection.merchandiseId, null);
  const withHold = quote({ lines: [line("a", 1, 620_000)], campaigns: [onlySlotTaken], heldCampaignIds: new Set(["mine"]) });
  assert.equal(withHold.selection.merchandiseId, "mine");
});

test("AC-01 / AC-04: manual locks are kept while valid; a stale one is replaced with a notice", () => {
  const campaigns = [fixed("m20", 20_000, 100_000), fixed("m40", 40_000, 100_000)];
  const locked = quote({ lines: [line("a", 1, 300_000)], campaigns, selection: { merchandise: { mode: "MANUAL", voucherId: "m20" }, shipping: { mode: "AUTO" } } });
  assert.equal(locked.selection.merchandiseId, "m20");
  const stale = quote({ lines: [line("a", 1, 300_000)], campaigns, selection: { merchandise: { mode: "MANUAL", voucherId: "gone" }, shipping: { mode: "AUTO" } } });
  assert.equal(stale.selection.merchandiseId, "m40");
  assert.deepEqual(stale.notices.map((n) => [n.group, n.voucherId, n.reason]), [["MERCHANDISE", "gone", "NOT_ELIGIBLE"]]);
  const none = quote({ lines: [line("a", 1, 300_000)], campaigns, selection: { merchandise: { mode: "MANUAL", voucherId: null }, shipping: { mode: "AUTO" } } });
  assert.equal(none.selection.merchandiseId, null);
});

test("AC-20 seam: a combination the POS cannot project is not recommended and its card says so", () => {
  const result = quote({
    lines: [line("a", 1, 620_000)],
    campaigns: [fixed("bad", 50_000, 100_000), fixed("good", 10_000, 100_000)],
    isFeasible: (e) => e.merchandiseId !== "bad",
  });
  assert.equal(result.selection.merchandiseId, "good");
  assert.equal(card(result, "bad").reason, "POS_INFEASIBLE");
  assert.equal(card(result, "bad").state, "UNAVAILABLE");
});

test("AC-28: the totals reconcile to the VND (paid after + fee = total, discounts add up)", () => {
  const result = quote({ lines: [line("a", 2, 333_333), line("b", 1, 12_345)], campaigns: [fixed("m", 77_777, 100_000), freeship("s", null)] });
  assert.equal(result.paidBeforeVnd - result.merchandiseDiscountVnd, result.paidAfterVnd);
  assert.equal(result.paidAfterVnd + result.shippingFeeVnd, result.totalPayableVnd);
  assert.equal(result.shippingFeeBeforeVoucherVnd - result.shippingDiscountVnd, result.shippingFeeVnd);
  assert.equal(result.allocation!.lines.reduce((sum, l) => sum + l.deductionVnd, 0), result.merchandiseDiscountVnd);
});

test("no campaigns is the plain cart: baseline total, no cards, no allocation", () => {
  const result = quote({ lines: [line("a", 1, 200_000)], campaigns: [] });
  assert.equal(result.totalPayableVnd, 230_000);
  assert.deepEqual(result.cards, []);
  assert.equal(result.allocation, null);
  assert.equal(result.voucherCount, 0);
});

test("invalid input fails closed instead of producing a number", () => {
  assert.deepEqual(
    buildVoucherQuote({ lines: [], campaigns: [], existingOtherPromotions: false, campaignShippingFeeVnd: () => 0, giftOutcome: noGifts }),
    { ok: false, reason: "BASELINE_UNAVAILABLE" },
  );
});
