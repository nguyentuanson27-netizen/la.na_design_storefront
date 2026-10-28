import assert from "node:assert/strict";
import test from "node:test";

import type { VoucherPaidLine } from "../../src/commerce/voucher-allocation.ts";
import type { VoucherCampaign } from "../../src/commerce/voucher-campaign.ts";
import { quoteMerchandiseStack } from "../../src/commerce/voucher-money.ts";
import type { GiftOutcome, VoucherSelectionIntent } from "../../src/commerce/voucher-optimizer.ts";
import { buildVoucherQuote, type VoucherQuote, type VoucherQuoteInput } from "../../src/commerce/voucher-quote.ts";
import { validateVoucherCampaign } from "../../src/commerce/voucher-rule-validation.ts";
import { buildVoucherScopeResolver } from "../../src/commerce/voucher-scope.ts";

/** ADR 0020 D-3: types stack in sequence by priority, one tier per type, thresholds on the pre-voucher base. */

const SHOP = 940_030;
const line = (lineId: string, quantity: number, unitPriceVnd: number, productId = `p-${lineId}`, categoryKeys: string[] = []): VoucherPaidLine => ({
  lineId,
  product: { productId, shopId: String(SHOP), categoryKeys },
  quantity,
  unitPriceVnd,
});

function tier(input: Record<string, unknown>, type: { id: string; priority: number } | null, ledger: Partial<Pick<VoucherCampaign, "redeemedUses" | "reservedUses" | "redeemedVnd" | "reservedVnd">> = {}): VoucherCampaign {
  const parsed = validateVoucherCampaign({
    name: "t",
    kind: "MERCHANDISE",
    issuance: "AUTO",
    visibility: "PUBLIC",
    scope: { mode: "ALL_SHOP", excludeProductIds: [] },
    ...input,
  });
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  return {
    ...(parsed as { value: object }).value,
    id: String(input.id),
    pancakeShopId: SHOP,
    revision: 1,
    isEnabled: true,
    enabledAt: new Date("2026-10-01T00:00:00Z"),
    disabledAt: null,
    redeemedUses: 0,
    redeemedVnd: 0,
    reservedUses: 0,
    reservedVnd: 0,
    type: type === null ? null : { id: type.id, name: type.id, priority: type.priority },
    ...ledger,
  } as VoucherCampaign;
}
const fixed = (id: string, type: string, priority: number, amountVnd: number, min: number, ledger = {}) =>
  tier({ id, discount: { type: "FIXED_AMOUNT_VND", amountVnd }, minEligibleSubtotalVnd: min }, { id: type, priority }, ledger);
const percent = (id: string, type: string, priority: number, pct: number, min: number, cap: number | null = null, ledger = {}) =>
  tier({ id, discount: { type: "PERCENTAGE", percent: pct, maxDiscountVnd: cap }, minEligibleSubtotalVnd: min }, { id: type, priority }, ledger);
const freeship = (id: string, min: number | null) => tier({ id, kind: "SHIPPING_FREE", minEligibleSubtotalVnd: min }, null);

const noGifts = (): GiftOutcome => ({ entitledSlots: 0, retainedSelectedSlots: 0 });
function quote(overrides: Partial<VoucherQuoteInput> & Pick<VoucherQuoteInput, "lines" | "campaigns">): Extract<VoucherQuote, { ok: true }> {
  const result = buildVoucherQuote({ existingOtherPromotions: false, campaignShippingFeeVnd: () => 30_000, giftOutcome: noGifts, ...overrides });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result as Extract<VoucherQuote, { ok: true }>;
}
const card = (result: Extract<VoucherQuote, { ok: true }>, id: string) => result.cards.find((entry) => entry.campaignId === id)!;

// Type A "by order" (priority 1) and type B "percent" (priority 2), each a ladder.
const ladder = () => [
  fixed("a500", "A", 1, 30_000, 500_000),
  fixed("a1m", "A", 1, 80_000, 1_000_000),
  percent("b500", "B", 2, 5, 500_000, 50_000),
  percent("b1m", "B", 2, 10, 1_000_000, 100_000),
];

test("ADR 0020 example: P=1.000.000 picks the top rung of both types, B on what A left (80.000 + 92.000)", () => {
  const result = quote({ lines: [line("a", 1, 1_000_000)], campaigns: ladder() });
  assert.deepEqual(result.selection.merchandiseIds, ["a1m", "b1m"]);
  assert.equal(result.merchandiseDiscountVnd, 172_000);
  assert.deepEqual(result.merchandise.map((entry) => [entry.campaignId, entry.slot, entry.discountVnd]), [["a1m", "MERCHANDISE:A", 80_000], ["b1m", "MERCHANDISE:B", 92_000]]);
  assert.equal(result.paidAfterVnd, 828_000);
  assert.equal(result.totalPayableVnd, 858_000, "shipping 30.000 is added by the shipping engine");
  assert.equal(result.voucherCount, 2);
  assert.equal(result.linesAfter.reduce((sum, entry) => sum + entry.quantity * entry.unitPriceVnd, 0), 828_000);
});

test("ADR 0020 example: P=520.000 — B's threshold is judged BEFORE A, so it is still reached on the remaining 490.000", () => {
  const result = quote({ lines: [line("a", 1, 520_000)], campaigns: ladder() });
  assert.deepEqual(result.selection.merchandiseIds, ["a500", "b500"]);
  assert.deepEqual(result.merchandise.map((entry) => entry.discountVnd), [30_000, 24_500]);
  assert.equal(result.paidAfterVnd, 465_500);
});

test("only one tier per type: below the top rung the system picks the highest rung reached, never two of a type", () => {
  const result = quote({ lines: [line("a", 1, 700_000)], campaigns: ladder() });
  assert.deepEqual(result.selection.merchandiseIds, ["a500", "b500"]);
  const slots = result.merchandise.map((entry) => entry.slot);
  assert.equal(new Set(slots).size, slots.length);
  assert.equal(card(result, "a1m").state, "UNAVAILABLE");
  assert.deepEqual([card(result, "a1m").reason, card(result, "a1m").shortfallVnd], ["BELOW_MINIMUM", 300_000]);
});

test("a type with no reachable tier contributes nothing; the other type still applies", () => {
  const result = quote({ lines: [line("a", 1, 450_000)], campaigns: ladder().filter((entry) => entry.id !== "a500" && entry.id !== "a1m").concat([fixed("a2m", "A", 1, 150_000, 2_000_000)]) });
  assert.deepEqual(result.selection.merchandiseIds, []);
  const withB = quote({ lines: [line("a", 1, 520_000)], campaigns: [fixed("a2m", "A", 1, 150_000, 2_000_000), percent("b500", "B", 2, 5, 500_000, 50_000)] });
  assert.deepEqual(withB.selection.merchandiseIds, ["b500"]);
  assert.equal(withB.merchandiseDiscountVnd, 26_000);
});

test("priority decides the order: with B first, A's fixed amount is unchanged but B takes 5% of the full base", () => {
  const swapped = [fixed("a500", "A", 2, 30_000, 500_000), percent("b500", "B", 1, 5, 500_000, 50_000)];
  const result = quote({ lines: [line("a", 1, 520_000)], campaigns: swapped });
  assert.deepEqual(result.selection.merchandiseIds, ["b500", "a500"]);
  assert.deepEqual(result.merchandise.map((entry) => [entry.campaignId, entry.discountVnd]), [["b500", 26_000], ["a500", 30_000]]);
});

test("a manual lock on a lower rung is honoured; the other type stays AUTO", () => {
  const selection: VoucherSelectionIntent = { merchandise: { "MERCHANDISE:A": { mode: "MANUAL", voucherId: "a500" } }, shipping: { mode: "AUTO" } };
  const result = quote({ lines: [line("a", 1, 1_000_000)], campaigns: ladder(), selection });
  assert.deepEqual(result.selection.merchandiseIds, ["a500", "b1m"]);
  assert.deepEqual(result.merchandise.map((entry) => entry.discountVnd), [30_000, 97_000]);
  assert.equal(card(result, "a1m").state, "AVAILABLE");
  assert.equal(card(result, "a1m").savingVnd, 80_000, "the card shows what choosing it would take off in this stack");
});

test("an explicit NONE on one type keeps the other type", () => {
  const selection: VoucherSelectionIntent = { merchandise: { "MERCHANDISE:A": { mode: "MANUAL", voucherId: null } }, shipping: { mode: "AUTO" } };
  const result = quote({ lines: [line("a", 1, 1_000_000)], campaigns: ladder(), selection });
  assert.deepEqual(result.selection.merchandiseIds, ["b1m"]);
  assert.equal(result.merchandiseDiscountVnd, 100_000);
});

test("a stale lock (id not in the slot) is dropped with a notice naming the slot, and the slot is optimized again", () => {
  const selection: VoucherSelectionIntent = { merchandise: { "MERCHANDISE:A": { mode: "MANUAL", voucherId: "gone" } }, shipping: { mode: "AUTO" } };
  const result = quote({ lines: [line("a", 1, 1_000_000)], campaigns: ladder(), selection });
  assert.deepEqual(result.selection.merchandiseIds, ["a1m", "b1m"]);
  assert.deepEqual(result.notices.map((entry) => [entry.group, entry.slot, entry.voucherId]), [["MERCHANDISE", "MERCHANDISE:A", "gone"]]);
});

test("an exhausted top rung falls back to the next rung that still has quota (Q5)", () => {
  const campaigns = [fixed("a500", "A", 1, 30_000, 500_000), fixed("a1m", "A", 1, 80_000, 1_000_000, { redeemedUses: 5 })];
  const full = campaigns.map((entry) => (entry.id === "a1m" ? { ...entry, maxUses: 5 } : entry));
  const result = quote({ lines: [line("a", 1, 1_000_000)], campaigns: full });
  assert.deepEqual(result.selection.merchandiseIds, ["a500"]);
  assert.deepEqual([card(result, "a1m").state, card(result, "a1m").reason], ["UNAVAILABLE", "EXHAUSTED"]);
});

test("a tier whose standalone amount does not fit its budget stays hidden (conservative v1 rule); a fitting one is chosen", () => {
  // B's 10% takes 92.000 after A but 100.000 alone: a 95.000 budget hides it, a 100.000 budget shows it.
  const tight = quote({ lines: [line("a", 1, 1_000_000)], campaigns: [fixed("a1m", "A", 1, 80_000, 1_000_000), { ...percent("b1m", "B", 2, 10, 1_000_000, 100_000), maxBudgetVnd: 95_000 }] });
  assert.deepEqual(tight.selection.merchandiseIds, ["a1m"]);
  assert.deepEqual([card(tight, "b1m").state, card(tight, "b1m").reason], ["UNAVAILABLE", "EXHAUSTED"]);
  const fits = quote({ lines: [line("a", 1, 1_000_000)], campaigns: [fixed("a1m", "A", 1, 80_000, 1_000_000), { ...percent("b1m", "B", 2, 10, 1_000_000, 100_000), maxBudgetVnd: 100_000 }] });
  assert.deepEqual(fits.selection.merchandiseIds, ["a1m", "b1m"]);
});

test("with no type at all the quote behaves as v1: one untyped voucher in the MERCHANDISE slot", () => {
  const untyped = tier({ id: "u1", discount: { type: "FIXED_AMOUNT_VND", amountVnd: 30_000 }, minEligibleSubtotalVnd: 600_000 }, null);
  const result = quote({ lines: [line("a", 1, 620_000)], campaigns: [untyped] });
  assert.deepEqual(result.selection, { merchandiseIds: ["u1"], shippingId: null });
  assert.equal(result.merchandise[0]!.slot, "MERCHANDISE");
});

test("shipping threshold is judged after ALL merchandise vouchers (570K misses a 600K freeship)", () => {
  const result = quote({
    lines: [line("a", 1, 620_000)],
    campaigns: [fixed("a500", "A", 1, 30_000, 500_000), freeship("s600", 600_000)],
    selection: { merchandise: { "MERCHANDISE:A": { mode: "MANUAL", voucherId: "a500" } }, shipping: { mode: "MANUAL", voucherId: "s600" } },
  });
  assert.equal(result.selection.shippingId, null, "590K is under 600K, so the locked freeship is dropped");
  assert.equal(result.notices.some((entry) => entry.group === "SHIPPING_FREE"), true);
});

test("a later type whose fixed discount no longer fits the reduced base makes that combination invalid, never silently clamped", () => {
  const lines = [line("a", 1, 100_000)];
  const resolver = buildVoucherScopeResolver({ mode: "ALL_SHOP", excludeProductIds: [] }, String(SHOP));
  const stack = quoteMerchandiseStack({
    lines,
    steps: [
      { id: "first", terms: { discount: { type: "FIXED_AMOUNT_VND", amountVnd: 60_000 }, minEligibleSubtotalVnd: 70_000 }, resolver },
      { id: "second", terms: { discount: { type: "FIXED_AMOUNT_VND", amountVnd: 50_000 }, minEligibleSubtotalVnd: 80_000 }, resolver },
    ],
  });
  assert.equal(stack.ok, false);
  assert.deepEqual(stack.ok ? null : [stack.failedId, stack.reason], ["second", "DISCOUNT_NOT_BELOW_SUBTOTAL"]);
});

test("every VND lands: a two-voucher stack over two lines allocates exactly and keeps every unit at 1đ or more", () => {
  const lines = [line("x", 3, 199_000, "px"), line("y", 2, 250_000, "py")];
  const resolver = buildVoucherScopeResolver({ mode: "ALL_SHOP", excludeProductIds: [] }, String(SHOP));
  const stack = quoteMerchandiseStack({
    lines,
    steps: [
      { id: "fixed", terms: { discount: { type: "FIXED_AMOUNT_VND", amountVnd: 77_777 }, minEligibleSubtotalVnd: 500_000 }, resolver },
      { id: "pct", terms: { discount: { type: "PERCENTAGE", percent: 7, maxDiscountVnd: null }, minEligibleSubtotalVnd: 500_000 }, resolver },
    ],
  });
  assert.equal(stack.ok, true);
  if (!stack.ok) return;
  const before = 3 * 199_000 + 2 * 250_000;
  assert.equal(stack.paidBeforeVnd, before);
  const after = stack.linesAfter.reduce((sum, entry) => sum + entry.quantity * entry.unitPriceVnd, 0);
  assert.equal(after, before - stack.discountVnd);
  assert.equal(stack.steps[0]!.allocation.lines.reduce((sum, entry) => sum + entry.deductionVnd, 0), 77_777);
  assert.equal(stack.steps[1]!.discountVnd, Math.floor(((before - 77_777) * 7 * 2 + 100) / 200));
  assert.equal(stack.linesAfter.every((entry) => entry.unitPriceVnd >= 1), true);
  assert.equal(new Set(stack.linesAfter.map((entry) => entry.lineId)).size, stack.linesAfter.length, "segment ids stay unique across stages");
});

test("the grid is bounded: too many slots or cells fails closed instead of searching partially", () => {
  const many = Array.from({ length: 9 }, (_, index) => fixed(`t${index}`, `T${index}`, index + 1, 1_000, 5_000));
  const result = buildVoucherQuote({ lines: [line("a", 1, 100_000)], campaigns: many, existingOtherPromotions: false, campaignShippingFeeVnd: () => 0, giftOutcome: noGifts });
  assert.deepEqual(result, { ok: false, reason: "INVALID_INPUT" });
});

test("a ladder the Admin accepts picks the highest rung reached on every cart size, caps included (review of #222)", () => {
  // 5% cap 50K from 500K, 10% cap 100K from 1M: the upper rung is strictly better wherever it is reached.
  const rungs = [percent("low", "P", 1, 5, 500_000, 50_000), percent("high", "P", 1, 10, 1_000_000, 100_000)];
  for (const [subtotal, expected, discount] of [[600_000, "low", 30_000], [999_999, "low", 50_000], [1_000_000, "high", 100_000], [2_000_000, "high", 100_000], [5_000_000, "high", 100_000]] as const) {
    const result = quote({ lines: [line("a", 1, subtotal)], campaigns: rungs });
    assert.deepEqual(result.selection.merchandiseIds, [expected], String(subtotal));
    assert.equal(result.merchandiseDiscountVnd, discount, String(subtotal));
  }
});

test("two rungs that cost the same: the cart that reached the higher rung gets it, whatever the ids sort like (review of #222)", () => {
  // At exactly 1.000.000 both give 50.000 (5% of 1M against a 50K cap); the Admin accepts the pair because the cap rises.
  const sameAtThreshold = [percent("a_lower", "P", 1, 5, 500_000, 50_000), percent("z_higher", "P", 1, 5, 1_000_000, 100_000)];
  for (const subtotal of [1_000_000, 1_000_001]) {
    const result = quote({ lines: [line("a", 1, subtotal)], campaigns: sameAtThreshold });
    assert.deepEqual(result.selection.merchandiseIds, ["z_higher"], String(subtotal));
  }
  assert.deepEqual(quote({ lines: [line("a", 1, 999_999)], campaigns: sameAtThreshold }).selection.merchandiseIds, ["a_lower"]);

  // Both capped at 80.000 from 1.6M up: still a tie in money, still the higher rung.
  const bothCapped = [percent("a_lower", "P", 1, 5, 500_000, 80_000), percent("z_higher", "P", 1, 10, 1_000_000, 80_000)];
  assert.deepEqual(quote({ lines: [line("a", 1, 2_000_000)], campaigns: bothCapped }).selection.merchandiseIds, ["z_higher"]);

  // Untyped v1 vouchers have no rung: equal money keeps the stable-id order.
  const untyped = [
    tier({ id: "u_b", discount: { type: "FIXED_AMOUNT_VND", amountVnd: 20_000 }, minEligibleSubtotalVnd: 100_000 }, null),
    tier({ id: "u_a", discount: { type: "FIXED_AMOUNT_VND", amountVnd: 20_000 }, minEligibleSubtotalVnd: 500_000 }, null),
  ];
  assert.deepEqual(quote({ lines: [line("a", 1, 600_000)], campaigns: untyped }).selection.merchandiseIds, ["u_a"]);
});
