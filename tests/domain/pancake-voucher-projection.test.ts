import assert from "node:assert/strict";
import test from "node:test";

import { projectBenefitQuoteForVendor } from "../../src/commerce/pancake-gift-projection.ts";
import {
  canProjectExactMoney,
  createVoucherPosFeasibility,
  type CompleteVoucherQuote,
} from "../../src/commerce/pancake-voucher-projection.ts";
import type { VoucherPaidLine } from "../../src/commerce/voucher-allocation.ts";
import type { VoucherCampaign } from "../../src/commerce/voucher-campaign.ts";
import { buildVoucherQuote } from "../../src/commerce/voucher-quote.ts";
import { validateVoucherCampaign } from "../../src/commerce/voucher-rule-validation.ts";

const paid = (lineId: string, pancakeVariationId: string, quantity: number, unitPriceVnd: number) => ({ lineId, pancakeVariationId, quantity, unitPriceVnd });
const complete = (overrides: Partial<CompleteVoucherQuote> = {}): CompleteVoucherQuote => ({
  paidLines: [paid("a", "V1", 2, 100_000)],
  gifts: [],
  expectedPaidSubtotalVnd: 200_000,
  shippingFeeVnd: 30_000,
  expectedTotalVnd: 230_000,
  ...overrides,
});

test("a representable complete quote projects, with a hash and the website paid subtotal", () => {
  const verdict = canProjectExactMoney(complete());
  assert.equal(verdict.ok, true);
  assert.equal((verdict as { paidTotalVnd: number }).paidTotalVnd, 200_000);
  assert.match((verdict as { hash: string }).hash, /^[0-9a-f]{64}$/);
});

test("deterministic: the same quote gives the same lines and hash, whatever order the lines arrive in", () => {
  const lines = [paid("b", "V2", 1, 50_000), paid("a", "V1", 2, 100_000), paid("c", "V1", 1, 99_999)];
  const quote = (paidLines: typeof lines) => complete({ paidLines, expectedPaidSubtotalVnd: 349_999, expectedTotalVnd: 379_999 });
  assert.deepEqual(canProjectExactMoney(quote(lines)), canProjectExactMoney(quote([...lines].reverse())));
});

test("the gift offset is carved out of paid units and the vendor total still equals the website total", () => {
  const verdict = canProjectExactMoney(complete({ gifts: [{ pancakeVariationId: "G1", quantity: 2 }] }));
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  const lines = (verdict as unknown as { lines: { pancakeVariationId: string; quantity: number; unitPriceVnd: number }[] }).lines;
  assert.equal(lines.reduce((sum, l) => sum + l.quantity * l.unitPriceVnd, 0), 200_000);
  assert.deepEqual(lines.filter((l) => l.pancakeVariationId === "G1"), [{ pancakeVariationId: "G1", quantity: 2, unitPriceVnd: 1_000 }]);
});

test("AC-20: a gift offset the paid units cannot absorb is infeasible, never rounded", () => {
  const verdict = canProjectExactMoney(complete({ paidLines: [paid("a", "V1", 2, 1)], expectedPaidSubtotalVnd: 2, expectedTotalVnd: 30_002, gifts: [{ pancakeVariationId: "G1", quantity: 1 }] }));
  assert.deepEqual(verdict, { ok: false, reason: "VENDOR_PROJECTION_INFEASIBLE" });
});

test("a mismatch between the vendor lines and the website totals is refused", () => {
  assert.deepEqual(canProjectExactMoney(complete({ expectedPaidSubtotalVnd: 199_999, expectedTotalVnd: 229_999 })), { ok: false, reason: "TOTAL_MISMATCH" });
  assert.deepEqual(canProjectExactMoney(complete({ expectedTotalVnd: 230_001 })), { ok: false, reason: "TOTAL_MISMATCH" });
  assert.deepEqual(canProjectExactMoney(complete({ shippingFeeVnd: 0 })), { ok: false, reason: "TOTAL_MISMATCH" });
});

test("malformed quotes fail closed", () => {
  const invalid = { ok: false, reason: "VENDOR_PROJECTION_INVALID" };
  assert.deepEqual(canProjectExactMoney(complete({ paidLines: [] })), invalid);
  assert.deepEqual(canProjectExactMoney(complete({ paidLines: [paid("a", "V1", 0, 100)] })), invalid);
  assert.deepEqual(canProjectExactMoney(complete({ paidLines: [paid("a", "V1", 1, 0)] })), invalid);
  assert.deepEqual(canProjectExactMoney(complete({ paidLines: [paid("a", "", 1, 100)] })), invalid);
  assert.deepEqual(canProjectExactMoney(complete({ shippingFeeVnd: -1 })), invalid);
  assert.deepEqual(canProjectExactMoney(complete({ expectedPaidSubtotalVnd: 0 })), invalid);
  assert.deepEqual(canProjectExactMoney(null as never), invalid);
});

test("lockstep with the order submit: the adapter and the snapshot re-derivation produce the identical lines and hash", () => {
  // pancake-order-submit re-derives from the stored PAID/GIFT quote lines with this exact call.
  const quote = complete({ paidLines: [paid("P:1", "V1", 2, 96_667), paid("P:2", "V1", 1, 96_666), paid("P:3", "V2", 1, 131_538)], gifts: [{ pancakeVariationId: "G1", quantity: 1 }], expectedPaidSubtotalVnd: 421_538, expectedTotalVnd: 451_538 });
  const adapter = canProjectExactMoney(quote);
  const submit = projectBenefitQuoteForVendor([
    { lineId: "P:1", role: "PAID", pancakeVariationId: "V1", quantity: 2, unitPriceVnd: 96_667 },
    { lineId: "P:2", role: "PAID", pancakeVariationId: "V1", quantity: 1, unitPriceVnd: 96_666 },
    { lineId: "P:3", role: "PAID", pancakeVariationId: "V2", quantity: 1, unitPriceVnd: 131_538 },
    { lineId: "G:1", role: "GIFT", pancakeVariationId: "G1", quantity: 1, unitPriceVnd: 0 },
  ]);
  assert.equal(adapter.ok && submit.ok, true);
  assert.equal((adapter as { hash: string }).hash, (submit as { hash: string }).hash);
  assert.deepEqual((adapter as { lines: unknown }).lines, (submit as { lines: unknown }).lines);
});

/* -------------------------------------------------- injected into the quote (AC-20 end to end) */

const SHOP = 940_011;
function fixed(id: string, amountVnd: number, minEligibleSubtotalVnd: number): VoucherCampaign {
  const parsed = validateVoucherCampaign({
    name: id, kind: "MERCHANDISE", issuance: "AUTO", visibility: "PUBLIC", scope: { mode: "ALL_SHOP", excludeProductIds: [] },
    discount: { type: "FIXED_AMOUNT_VND", amountVnd }, minEligibleSubtotalVnd,
  });
  assert.equal(parsed.ok, true);
  return { ...(parsed as { value: object }).value, id, pancakeShopId: SHOP, revision: 1, isEnabled: true, enabledAt: new Date("2026-10-01T00:00:00Z"), disabledAt: null, redeemedUses: 0, redeemedVnd: 0, reservedUses: 0, reservedVnd: 0 } as VoucherCampaign;
}
const cartLine = (lineId: string, quantity: number, unitPriceVnd: number): VoucherPaidLine => ({ lineId, product: { productId: lineId, shopId: String(SHOP), categoryKeys: [] }, quantity, unitPriceVnd });

test("AC-20: AUTO leaves out a voucher that would make the gift unrepresentable; a manual lock on it is reported POS_INFEASIBLE and nothing is granted", () => {
  // Cart 1.004đ (a: 2 x 2đ, b: 1 x 1.000đ). A 1.000đ voucher is fine alone, but one gift unit needs 1.000đ to come out of paid units.
  const lines = [cartLine("a", 2, 2), cartLine("b", 1, 1_000)];
  const feasible = createVoucherPosFeasibility({
    variationOfLine: new Map([["a", "V1"], ["b", "V2"]]),
    giftsOf: () => [{ pancakeVariationId: "G1", quantity: 1 }],
  });
  const base = {
    lines,
    campaigns: [fixed("tight", 1_000, 1_001), fixed("loose", 1, 1_001)],
    existingOtherPromotions: false,
    campaignShippingFeeVnd: () => 30_000,
    giftOutcome: () => ({ entitledSlots: 1, retainedSelectedSlots: 1 }),
    isFeasibleOnLines: feasible,
  };
  const auto = buildVoucherQuote(base);
  assert.equal(auto.ok, true, JSON.stringify(auto));
  // With a gift unit (1.000đ) to absorb, the tight voucher leaves only 4đ of paid money: not representable.
  const ok = auto as Extract<typeof auto, { ok: true }>;
  assert.equal(ok.selection.merchandiseIds.includes("tight"), false);
  assert.equal(ok.cards.find((c) => c.campaignId === "tight")?.reason, "POS_INFEASIBLE");
  const manual = buildVoucherQuote({ ...base, selection: { merchandise: { MERCHANDISE: { mode: "MANUAL", voucherId: "tight" } }, shipping: { mode: "AUTO" } } }) as Extract<ReturnType<typeof buildVoucherQuote>, { ok: true }>;
  assert.equal(manual.selection.merchandiseIds.includes("tight"), false);
  assert.deepEqual(manual.notices.map((n) => [n.voucherId, n.reason]), [["tight", "POS_INFEASIBLE"]]);
  assert.equal(manual.held, false);
});

test("a line the feasibility predicate cannot place is infeasible (fail closed)", () => {
  const feasible = createVoucherPosFeasibility({ variationOfLine: new Map(), giftsOf: () => [] });
  const result = buildVoucherQuote({
    lines: [cartLine("a", 1, 700_000)],
    campaigns: [fixed("m", 50_000, 100_000)],
    existingOtherPromotions: false,
    campaignShippingFeeVnd: () => 30_000,
    giftOutcome: () => ({ entitledSlots: 0, retainedSelectedSlots: 0 }),
    isFeasibleOnLines: feasible,
  });
  // Even NONE/NONE cannot be placed, so nothing is recommended.
  assert.deepEqual(result, { ok: false, reason: "NO_FEASIBLE_COMBINATION" });
});
