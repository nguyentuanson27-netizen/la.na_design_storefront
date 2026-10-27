import assert from "node:assert/strict";
import test from "node:test";

import {
  priceStack,
  type StackInputLine,
  type StackLegacyConsent,
  type StackTierParticipant,
} from "../../src/commerce/gift-quantity-stack.ts";
import type { QuantityTierConfig } from "../../src/commerce/gift-quantity-tier.ts";
import {
  MAX_VOUCHER_PAID_LINES,
  allocateMerchandiseDiscount,
  type VoucherAllocation,
  type VoucherPaidLine,
} from "../../src/commerce/voucher-allocation.ts";
import {
  calculateMerchandiseDiscount,
  quoteMerchandiseVoucher,
  sumEligibleLines,
  type MerchandiseTerms,
} from "../../src/commerce/voucher-money.ts";
import { buildVoucherScopeResolver, type VoucherScopeResolver } from "../../src/commerce/voucher-scope.ts";

const SHOP = "shop-1";
const everything: VoucherScopeResolver = () => true;
const line = (lineId: string, quantity: number, unitPriceVnd: number, productId = `p-${lineId}`, categoryKeys: string[] = []): VoucherPaidLine => ({
  lineId,
  product: { productId, shopId: SHOP, categoryKeys },
  quantity,
  unitPriceVnd,
});
const fixed = (amountVnd: number, minEligibleSubtotalVnd: number | null): MerchandiseTerms => ({
  discount: { type: "FIXED_AMOUNT_VND", amountVnd },
  minEligibleSubtotalVnd,
});
const percent = (value: number, maxDiscountVnd: number | null = null, minEligibleSubtotalVnd: number | null = null): MerchandiseTerms => ({
  discount: { type: "PERCENTAGE", percent: value, maxDiscountVnd },
  minEligibleSubtotalVnd,
});

function allocated(result: ReturnType<typeof allocateMerchandiseDiscount>): VoucherAllocation {
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as { allocation: VoucherAllocation }).allocation;
}

/** Every invariant a POS-bound allocation must keep, asserted for any input. */
function assertConserved(lines: readonly VoucherPaidLine[], resolver: VoucherScopeResolver, allocation: VoucherAllocation, discountVnd: number) {
  const byId = new Map(lines.map((l) => [l.lineId, l]));
  let deducted = 0;
  for (const entry of allocation.lines) {
    const source = byId.get(entry.lineId)!;
    assert.equal(resolver(source.product), true, "only in-scope lines appear");
    const units = entry.segments.reduce((sum, s) => sum + s.quantity, 0);
    const after = entry.segments.reduce((sum, s) => sum + s.quantity * s.unitPriceVnd, 0);
    assert.equal(units, source.quantity, "quantity is preserved");
    assert.equal(after, source.quantity * source.unitPriceVnd - entry.deductionVnd, "segments add up to the line after the deduction");
    assert.ok(entry.segments.every((s) => s.unitPriceVnd >= 1 && s.quantity >= 1), "no unit under 1đ");
    assert.ok(entry.segments.length <= 2, "a line splits into at most two price segments");
    deducted += entry.deductionVnd;
  }
  assert.equal(deducted, discountVnd, "the deductions add up to D to the VND");
  assert.equal(allocation.discountVnd, discountVnd);
}

/* ------------------------------------------------------------------ D, thresholds, guards */

test("fixed amount: D is the amount once the in-scope subtotal reaches the minimum", () => {
  const result = calculateMerchandiseDiscount({ terms: fixed(30_000, 600_000), eligibleSubtotalVnd: 620_000, eligibleUnits: 2 });
  assert.deepEqual(result, { ok: true, discountVnd: 30_000, eligibleSubtotalVnd: 620_000 });
  // The minimum is inclusive.
  assert.equal(calculateMerchandiseDiscount({ terms: fixed(30_000, 600_000), eligibleSubtotalVnd: 600_000, eligibleUnits: 1 }).ok, true);
});

test("below the minimum the voucher is ineligible and reports the shortfall (AC-11)", () => {
  const result = calculateMerchandiseDiscount({ terms: fixed(30_000, 600_000), eligibleSubtotalVnd: 599_000, eligibleUnits: 1 });
  assert.deepEqual(result, { ok: false, reason: "BELOW_MINIMUM", eligibleSubtotalVnd: 599_000, shortfallVnd: 1_000 });
});

test("percentage rounds half-up on whole VND", () => {
  const round = (subtotal: number, pct: number) => {
    const r = calculateMerchandiseDiscount({ terms: percent(pct), eligibleSubtotalVnd: subtotal, eligibleUnits: 1 });
    assert.equal(r.ok, true, JSON.stringify(r));
    return (r as { discountVnd: number }).discountVnd;
  };
  assert.equal(round(100_050, 10), 10_005); // exact
  assert.equal(round(100_005, 10), 10_001); // 10000.5 -> half-up
  assert.equal(round(100_004, 10), 10_000); // 10000.4
  assert.equal(round(100_006, 10), 10_001); // 10000.6
  assert.equal(round(333, 33), 110); // 109.89 -> 110
});

test("percentage cap applies after rounding", () => {
  const result = calculateMerchandiseDiscount({ terms: percent(20, 100_000), eligibleSubtotalVnd: 1_000_000, eligibleUnits: 2 });
  assert.deepEqual(result, { ok: true, discountVnd: 100_000, eligibleSubtotalVnd: 1_000_000 });
  assert.equal((calculateMerchandiseDiscount({ terms: percent(20, 500_000), eligibleSubtotalVnd: 1_000_000, eligibleUnits: 2 }) as { discountVnd: number }).discountVnd, 200_000);
});

test("percentage is exact on the largest supported subtotal (BigInt intermediate)", () => {
  const subtotal = 100_000_000_000;
  const r = calculateMerchandiseDiscount({ terms: percent(99), eligibleSubtotalVnd: subtotal, eligibleUnits: 1 });
  assert.deepEqual(r, { ok: true, discountVnd: 99_000_000_000, eligibleSubtotalVnd: subtotal });
});

test("a zero discount, one that eats the whole subtotal, or one that breaks the 1đ floor is refused", () => {
  assert.equal((calculateMerchandiseDiscount({ terms: percent(1), eligibleSubtotalVnd: 40, eligibleUnits: 1 }) as { reason: string }).reason, "ZERO_DISCOUNT");
  assert.equal((calculateMerchandiseDiscount({ terms: fixed(500, null), eligibleSubtotalVnd: 500, eligibleUnits: 1 }) as { reason: string }).reason, "DISCOUNT_NOT_BELOW_SUBTOTAL");
  // 3 units worth 1.000đ in total can give up at most 997đ.
  assert.equal((calculateMerchandiseDiscount({ terms: fixed(998, null), eligibleSubtotalVnd: 1_000, eligibleUnits: 3 }) as { reason: string }).reason, "UNIT_PRICE_FLOOR");
  assert.equal(calculateMerchandiseDiscount({ terms: fixed(997, null), eligibleSubtotalVnd: 1_000, eligibleUnits: 3 }).ok, true);
  assert.equal((calculateMerchandiseDiscount({ terms: fixed(10, null), eligibleSubtotalVnd: 0, eligibleUnits: 0 }) as { reason: string }).reason, "NO_ELIGIBLE_LINES");
});

/* ------------------------------------------------------------------ scope (EX-03) */

test("EX-03: a Dress-only voucher with min 500K is ineligible on Dress 400K + Bag 300K", () => {
  const lines = [line("dress", 1, 400_000, "dress", ["vayDam"]), line("bag", 1, 300_000, "bag", ["phuKien"])];
  const resolver = buildVoucherScopeResolver({ mode: "TARGETED", categoryKeys: ["vayDam"], includeProductIds: [], excludeProductIds: [] }, SHOP);
  assert.deepEqual(sumEligibleLines(lines, resolver), { subtotalVnd: 400_000, units: 1 });
  const quote = quoteMerchandiseVoucher({ terms: fixed(50_000, 500_000), resolver, lines });
  assert.deepEqual(quote, { ok: false, reason: "BELOW_MINIMUM", eligibleSubtotalVnd: 400_000, shortfallVnd: 100_000 });
});

test("EX-03: once the threshold is met the discount lands only on the in-scope line", () => {
  const lines = [line("dress", 1, 550_000, "dress", ["vayDam"]), line("bag", 1, 300_000, "bag", ["phuKien"])];
  const resolver = buildVoucherScopeResolver({ mode: "TARGETED", categoryKeys: ["vayDam"], includeProductIds: [], excludeProductIds: [] }, SHOP);
  const quote = quoteMerchandiseVoucher({ terms: fixed(50_000, 500_000), resolver, lines });
  assert.equal(quote.ok, true, JSON.stringify(quote));
  const q = quote as Extract<typeof quote, { ok: true }>;
  assert.equal(q.eligibleSubtotalVnd, 550_000);
  assert.equal(q.paidBeforeVnd, 850_000);
  assert.equal(q.paidAfterVnd, 800_000);
  assert.deepEqual(q.allocation.lines.map((l) => [l.lineId, l.deductionVnd]), [["dress", 50_000]]);
});

test("a percentage voucher takes its percentage of the in-scope subtotal only", () => {
  const lines = [line("a", 2, 200_000, "a", ["vayDam"]), line("b", 1, 600_000, "b", ["phuKien"])];
  const resolver = buildVoucherScopeResolver({ mode: "TARGETED", categoryKeys: ["vayDam"], includeProductIds: [], excludeProductIds: [] }, SHOP);
  const quote = quoteMerchandiseVoucher({ terms: percent(10), resolver, lines }) as Extract<ReturnType<typeof quoteMerchandiseVoucher>, { ok: true }>;
  assert.equal(quote.discountVnd, 40_000);
  assert.equal(quote.paidAfterVnd, 1_000_000 - 40_000);
});

/* ------------------------------------------------------------------ allocation */

test("allocation splits D by line value, to the VND, and keeps units whole", () => {
  const lines = [line("a", 1, 400_000), line("b", 2, 300_000)];
  const allocation = allocated(allocateMerchandiseDiscount({ lines, resolver: everything, discountVnd: 100_000 }));
  assertConserved(lines, everything, allocation, 100_000);
  assert.deepEqual(allocation.lines.map((l) => [l.lineId, l.deductionVnd]), [["a", 40_000], ["b", 60_000]]);
  // b: 2 units share 60.000 -> 30.000 each
  assert.deepEqual(allocation.lines[1]!.segments, [{ quantity: 2, unitPriceVnd: 270_000 }]);
});

test("a deduction that does not divide a line evenly makes at most two price segments differing by 1đ", () => {
  const lines = [line("a", 3, 100_000)];
  const allocation = allocated(allocateMerchandiseDiscount({ lines, resolver: everything, discountVnd: 10_000 }));
  assertConserved(lines, everything, allocation, 10_000);
  // 10.000 / 3 = 3.333 r1: two units give up 3.333, one gives up 3.334; dearer price listed first.
  assert.deepEqual(allocation.lines[0]!.segments, [
    { quantity: 2, unitPriceVnd: 96_667 },
    { quantity: 1, unitPriceVnd: 96_666 },
  ]);
});

test("the VND left by flooring goes to the largest fractional share, ties to the dearer unit then lineId", () => {
  // Two equal lines, D odd: the single extra đồng goes to the lower lineId.
  const lines = [line("b", 1, 100_000), line("a", 1, 100_000)];
  const allocation = allocated(allocateMerchandiseDiscount({ lines, resolver: everything, discountVnd: 7 }));
  assert.deepEqual(allocation.lines.map((l) => [l.lineId, l.deductionVnd]), [["a", 4], ["b", 3]]);
  // Dearer unit wins a fractional tie: 3 vs 1 shares of 4 over D=2 -> 1.5 / 0.5 -> floors 1/0, leftover to the 3.
  const mixed = [line("x", 1, 300_000), line("y", 1, 100_000)];
  const result = allocated(allocateMerchandiseDiscount({ lines: mixed, resolver: everything, discountVnd: 2 }));
  assertConserved(mixed, everything, result, 2);
  assert.deepEqual(result.lines.map((l) => [l.lineId, l.deductionVnd]), [["x", 2], ["y", 0]]);
});

test("input order never changes the allocation", () => {
  const lines = [line("c", 2, 150_000), line("a", 1, 333_333), line("b", 3, 77_777), line("d", 1, 1)];
  const reversed = [...lines].reverse();
  const first = allocated(allocateMerchandiseDiscount({ lines, resolver: everything, discountVnd: 123_457 }));
  const second = allocated(allocateMerchandiseDiscount({ lines: reversed, resolver: everything, discountVnd: 123_457 }));
  assert.deepEqual(first, second);
  assertConserved(lines, everything, first, 123_457);
});

test("a line that would fall under 1đ is capped and the excess moves to the other lines", () => {
  // 100 units at 2đ can give up only 100đ; the rest of D must land on the dear line.
  const lines = [line("cheap", 100, 2), line("dear", 1, 1_000_000)];
  const allocation = allocated(allocateMerchandiseDiscount({ lines, resolver: everything, discountVnd: 900_000 }));
  assertConserved(lines, everything, allocation, 900_000);
  const cheap = allocation.lines.find((l) => l.lineId === "cheap")!;
  assert.ok(cheap.deductionVnd <= 100);
});

test("D equal to the whole headroom leaves every unit at exactly 1đ", () => {
  const lines = [line("a", 2, 5), line("b", 1, 10)];
  const headroom = 2 * 4 + 9;
  const allocation = allocated(allocateMerchandiseDiscount({ lines, resolver: everything, discountVnd: headroom }));
  assertConserved(lines, everything, allocation, headroom);
  assert.ok(allocation.lines.every((l) => l.segments.every((s) => s.unitPriceVnd === 1)));
  assert.deepEqual(allocateMerchandiseDiscount({ lines, resolver: everything, discountVnd: headroom + 1 }), { ok: false, reason: "UNIT_PRICE_FLOOR" });
});

test("units already at 1đ take nothing and are never driven below it", () => {
  const lines = [line("one", 5, 1), line("big", 1, 10_000)];
  const allocation = allocated(allocateMerchandiseDiscount({ lines, resolver: everything, discountVnd: 5_000 }));
  assertConserved(lines, everything, allocation, 5_000);
  assert.equal(allocation.lines.find((l) => l.lineId === "one")!.deductionVnd, 0);
});

test("randomized carts always conserve D to the VND with every unit >= 1đ and are order-independent", () => {
  let seed = 20261025;
  const next = (max: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return (seed % max) + 1;
  };
  for (let round = 0; round < 300; round += 1) {
    const lines = Array.from({ length: next(8) }, (_, i) => line(`l${i}`, next(6), next(5) === 1 ? next(20) : next(900_000)));
    const units = lines.reduce((s, l) => s + l.quantity, 0);
    const total = lines.reduce((s, l) => s + l.quantity * l.unitPriceVnd, 0);
    const headroom = total - units;
    if (headroom < 1) continue;
    const discountVnd = next(headroom);
    const allocation = allocated(allocateMerchandiseDiscount({ lines, resolver: everything, discountVnd }));
    assertConserved(lines, everything, allocation, discountVnd);
    const shuffled = [...lines].sort(() => next(3) - 2);
    assert.deepEqual(allocated(allocateMerchandiseDiscount({ lines: shuffled, resolver: everything, discountVnd })), allocation);
  }
});

test("out-of-scope lines are never touched and do not absorb the discount", () => {
  const lines = [line("in", 1, 100_000, "in", ["vayDam"]), line("out", 1, 900_000, "out", ["phuKien"])];
  const resolver = buildVoucherScopeResolver({ mode: "TARGETED", categoryKeys: ["vayDam"], includeProductIds: [], excludeProductIds: [] }, SHOP);
  const allocation = allocated(allocateMerchandiseDiscount({ lines, resolver, discountVnd: 10_000 }));
  assert.deepEqual(allocation.lines.map((l) => l.lineId), ["in"]);
  assertConserved(lines, resolver, allocation, 10_000);
});

test("malformed lines or discounts are refused without throwing from the allocator", () => {
  const good = [line("a", 1, 1_000)];
  const bad: Array<readonly VoucherPaidLine[]> = [
    [],
    [line("a", 0, 1_000)],
    [line("a", 1, 0)],
    [line("a", 1.5, 1_000)],
    [line("bad id!", 1, 1_000)],
    [line("a", 1, 1_000), line("a", 1, 2_000)],
    [line("a", 1, Number.MAX_SAFE_INTEGER), line("b", 1, Number.MAX_SAFE_INTEGER)],
    Array.from({ length: MAX_VOUCHER_PAID_LINES + 1 }, (_, i) => line(`l${i}`, 1, 100)),
  ];
  for (const lines of bad) {
    assert.deepEqual(allocateMerchandiseDiscount({ lines, resolver: everything, discountVnd: 10 }), { ok: false, reason: "INVALID_INPUT" });
  }
  for (const discountVnd of [0, -1, 1.5, Number.NaN]) {
    assert.deepEqual(allocateMerchandiseDiscount({ lines: good, resolver: everything, discountVnd }), { ok: false, reason: "INVALID_INPUT" });
  }
});

/* ------------------------------------------------------------------ EX-10 / TG-11 A */

const orderLadder = (threshold: number, totalOff: number): QuantityTierConfig => ({
  basis: "ORDER_SUBTOTAL",
  unit: "FIXED_AMOUNT_TOTAL_VND",
  discountedUnits: "ALL_ELIGIBLE_UNITS",
  selectionPriority: null,
  tiers: [{ minQuantity: threshold, discountValue: totalOff }],
});

function priceCart(lines: StackInputLine[], tiers: StackTierParticipant[]): VoucherPaidLine[] {
  const result = priceStack({ lines, tiers, legacyConsents: new Map() as StackLegacyConsent });
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as Extract<typeof result, { ok: true }>).groups.map((group) => ({
    lineId: group.groupKey,
    product: { productId: "p1", shopId: SHOP, categoryKeys: [] },
    quantity: group.quantity,
    unitPriceVnd: group.unitPriceVnd,
  }));
}

const cart650: StackInputLine = {
  lineKey: "a",
  pancakeVariationId: "var-a",
  quantity: 1,
  product: { productId: "p1", categoryKeys: [] },
  basePriceVnd: 650_000,
  legacy: null,
};
const ladder = (): StackTierParticipant => ({
  id: "order-ladder",
  config: orderLadder(600_000, 30_000),
  resolve: () => true,
  priority: null,
  stackingEnabled: false,
  peers: [],
});

test("EX-10 / AC-46: 650K - ladder 30K - voucher 80K = 540K; no voucher = 620K; never the 570K path", () => {
  const postTier = priceCart([cart650], [ladder()]);
  assert.equal(postTier.reduce((sum, l) => sum + l.quantity * l.unitPriceVnd, 0), 620_000, "no voucher: 620K before shipping");

  const quote = quoteMerchandiseVoucher({ terms: fixed(80_000, 600_000), resolver: everything, lines: postTier });
  assert.equal(quote.ok, true, JSON.stringify(quote));
  const q = quote as Extract<typeof quote, { ok: true }>;
  assert.equal(q.eligibleSubtotalVnd, 620_000, "the voucher threshold is judged on the post-tier 620K, not 650K");
  assert.equal(q.paidBeforeVnd, 620_000);
  assert.equal(q.paidAfterVnd, 540_000);
  assert.notEqual(q.paidAfterVnd, 570_000);
  assertConserved(postTier, everything, q.allocation, 80_000);
});

test("AC-39 / EX-09: the voucher never re-runs the ladder when it pulls P_after under the rung", () => {
  const postTier = priceCart([cart650], [ladder()]);
  // 620K - 80K = 540K is under the 600K rung; the quote must not hand the 30K back or take it twice.
  const q = quoteMerchandiseVoucher({ terms: fixed(80_000, 600_000), resolver: everything, lines: postTier }) as Extract<
    ReturnType<typeof quoteMerchandiseVoucher>,
    { ok: true }
  >;
  assert.equal(q.paidAfterVnd, 650_000 - 30_000 - 80_000);
  // Feeding the voucher-adjusted price back through the ladder would lose the rung (570K path B): prove the
  // difference is real, so the guard above is meaningful.
  const wrongOrder = priceCart([{ ...cart650, basePriceVnd: 570_000 }], [ladder()]);
  assert.equal(wrongOrder.reduce((sum, l) => sum + l.quantity * l.unitPriceVnd, 0), 570_000);
});
