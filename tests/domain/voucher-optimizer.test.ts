import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_VOUCHER_CANDIDATES_PER_GROUP,
  createCombinationEvaluator,
  optimizeVouchers,
  type EvaluatedCombination,
  type EvaluatorContext,
  type GiftOutcome,
  type MerchandiseOption,
  type ShippingOption,
  type VoucherOptimization,
  type VoucherSelectionIntent,
} from "../../src/commerce/voucher-optimizer.ts";

type Ok = Extract<VoucherOptimization, { ok: true }>;

const merch = (id: string, discountVnd: number): MerchandiseOption => ({ id, discountVnd });
const ship = (id: string, minEligibleSubtotalVnd: number | null): ShippingOption => ({ id, minEligibleSubtotalVnd });

/**
 * A cart with paid total P, a campaign-less 30K base fee, one gift that unlocks at `giftMin` of paid goods
 * (the shopper already picked it) -- all-shop scope, so a shipping voucher's threshold sees P - D.
 */
function setup(overrides: Partial<EvaluatorContext> & { paid?: number; shippingMin?: number | null; giftMin?: number | null } = {}) {
  const paid = overrides.paid ?? 620_000;
  const giftMin = overrides.giftMin === undefined ? null : overrides.giftMin;
  const discounts = new Map<string, number>();
  const context: EvaluatorContext = {
    paidSubtotalVnd: paid,
    existingOtherPromotions: false,
    campaignShippingFeeVnd: () => 30_000,
    shippingScopeSubtotalAfterVnd: (_shippingId, merchandiseId) => paid - (merchandiseId === null ? 0 : (discounts.get(merchandiseId) ?? 0)),
    giftOutcome: (paidAfter): GiftOutcome =>
      giftMin === null ? { entitledSlots: 0, retainedSelectedSlots: 0 } : { entitledSlots: paidAfter >= giftMin ? 1 : 0, retainedSelectedSlots: paidAfter >= giftMin ? 1 : 0 },
    ...overrides,
  };
  return {
    evaluate: (options: readonly MerchandiseOption[]) => {
      for (const option of options) discounts.set(option.id, option.discountVnd);
      return createCombinationEvaluator(context);
    },
  };
}

function run(
  merchandise: MerchandiseOption[],
  shipping: ShippingOption[],
  extra: Partial<EvaluatorContext> & { paid?: number; giftMin?: number | null } = {},
  options: { selection?: VoucherSelectionIntent; isFeasible?: (evaluation: EvaluatedCombination) => boolean } = {},
): VoucherOptimization {
  return optimizeVouchers({ merchandise, shipping, evaluate: setup(extra).evaluate(merchandise), ...options });
}

function ok(result: VoucherOptimization): Ok {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result as Ok;
}

test("EX-01 / AC-03: 40K merchandise drops freeship (610K) but 20K + freeship pays 600K, so AUTO picks 20K + freeship", () => {
  const result = ok(run([merch("m40", 40_000), merch("m20", 20_000)], [ship("s600", 600_000)]));
  assert.deepEqual(result.selection, { merchandiseId: "m20", shippingId: "s600" });
  assert.equal(result.evaluation.totalPayableVnd, 600_000);
  assert.equal(result.baseline.totalPayableVnd, 650_000);
  assert.equal(result.confirmation, null);
  // The rejected alternative really is dearer, so the choice is a result of the search and not luck.
  const only40 = ok(run([merch("m40", 40_000)], [ship("s600", 600_000)]));
  assert.equal(only40.evaluation.totalPayableVnd, 610_000);
});

test("AC-01: at most one merchandise voucher and one shipping voucher are ever selected", () => {
  const result = ok(run([merch("a", 10_000), merch("b", 30_000), merch("c", 20_000)], [ship("s1", null), ship("s2", null)]));
  assert.equal(result.evaluation.voucherCount, 2);
  assert.equal(result.selection.merchandiseId, "b");
  // Equal shipping vouchers tie on every criterion, so the stable id decides.
  assert.equal(result.selection.shippingId, "s1");
});

test("AC-02: one merchandise plus one freeship voucher combine to the exact total", () => {
  const result = ok(run([merch("m", 50_000)], [ship("s", null)], { paid: 400_000 }));
  assert.equal(result.evaluation.totalPayableVnd, 400_000 - 50_000);
  assert.equal(result.evaluation.shippingDiscountVnd, 30_000);
});

test("AUTO never costs more than no voucher: a voucher that saves nothing is not picked", () => {
  const result = ok(run([], [ship("s", null)], { campaignShippingFeeVnd: () => 0 }));
  assert.deepEqual(result.selection, { merchandiseId: null, shippingId: null });
  assert.equal(result.evaluation.voucherCount, 0);
});

test("AC-09: a shipping voucher whose threshold the merchandise voucher pushes under is ineligible together", () => {
  // P=620K, merchandise 50K leaves 570K < 600K min. Best is merchandise alone (600K...) vs freeship alone.
  const result = ok(run([merch("m50", 50_000)], [ship("s600", 600_000)]));
  // m50 alone: 570K + 30K = 600K. s600 alone: 620K + 0 = 620K. Both: invalid. None: 650K.
  assert.deepEqual(result.selection, { merchandiseId: "m50", shippingId: null });
  assert.equal(result.evaluation.totalPayableVnd, 600_000);
});

test("EX-06 / AC-29: a non-stacking free-ship campaign falls when a merchandise voucher applies, so AUTO picks NONE", () => {
  const result = ok(
    run([merch("m10", 10_000)], [], {
      paid: 100_000,
      campaignShippingFeeVnd: (hasOtherPromotions) => (hasOtherPromotions ? 30_000 : 0),
    }),
  );
  assert.deepEqual(result.selection, { merchandiseId: null, shippingId: null });
  assert.equal(result.evaluation.totalPayableVnd, 100_000);
});

test("EX-06: a manual 10K choice is honoured, shows the new fee and total, and asks for confirmation", () => {
  const result = ok(
    run(
      [merch("m10", 10_000)],
      [],
      { paid: 100_000, campaignShippingFeeVnd: (hasOtherPromotions) => (hasOtherPromotions ? 30_000 : 0) },
      { selection: { merchandise: { mode: "MANUAL", voucherId: "m10" }, shipping: { mode: "AUTO" } } },
    ),
  );
  assert.equal(result.selection.merchandiseId, "m10");
  assert.equal(result.evaluation.shippingFeeVnd, 30_000);
  assert.equal(result.evaluation.totalPayableVnd, 120_000);
  assert.deepEqual(result.confirmation, { totalIncreaseVnd: 20_000, shippingFeeIncreaseVnd: 30_000 });
  assert.deepEqual(result.notices, []);
});

test("AC-30: with stacking allowed (fee stays 0) the voucher is simply the cheaper pick", () => {
  const result = ok(run([merch("m10", 10_000)], [], { paid: 100_000, campaignShippingFeeVnd: () => 0 }));
  assert.deepEqual(result.selection, { merchandiseId: "m10", shippingId: null });
  assert.equal(result.evaluation.totalPayableVnd, 90_000);
});

test("TG-10 B is re-evaluated per candidate: an existing other promotion keeps the fee regardless of the voucher", () => {
  const seen: boolean[] = [];
  const result = ok(
    run([merch("m", 10_000)], [], {
      paid: 100_000,
      existingOtherPromotions: true,
      campaignShippingFeeVnd: (hasOtherPromotions) => {
        seen.push(hasOtherPromotions);
        return hasOtherPromotions ? 30_000 : 0;
      },
    }),
  );
  assert.deepEqual(new Set(seen), new Set([true]));
  assert.equal(result.baseline.totalPayableVnd, 130_000);
  assert.equal(result.evaluation.totalPayableVnd, 120_000);
});

test("EX-02 / AC-08: an AUTO pick that loses the gift is reported with giftLoss; a smaller voucher keeps it", () => {
  // P=620K, gift unlocks at 600K and the shopper already chose it. Money-optimal 50K drops it (570K).
  const result = ok(run([merch("m50", 50_000), merch("m10", 10_000)], [], { giftMin: 600_000 }));
  assert.equal(result.selection.merchandiseId, "m50");
  assert.deepEqual(result.giftLoss, { entitledSlotsLost: 1, selectedSlotsLost: 1 });
  // The shopper can switch to the 10K voucher and keep the gift.
  const keep = ok(
    run([merch("m50", 50_000), merch("m10", 10_000)], [], { giftMin: 600_000 }, { selection: { merchandise: { mode: "MANUAL", voucherId: "m10" }, shipping: { mode: "AUTO" } } }),
  );
  assert.equal(keep.selection.merchandiseId, "m10");
  assert.equal(keep.giftLoss, null);
});

test("EX-07 / AC-36 / TG-09: equal totals prefer the combination that keeps the gift", () => {
  // P=620K, base ship 30K, shipping voucher min 600K, gift unlocks at 600K and is already chosen.
  //   40K alone      -> 580K + 30K = 610K, gift lost
  //   10K + freeship -> 610K +  0K = 610K, gift kept
  const merchandise = [merch("m40", 40_000), merch("m10", 10_000)];
  const result = ok(run(merchandise, [ship("s600", 600_000)], { giftMin: 600_000 }));
  assert.deepEqual(result.selection, { merchandiseId: "m10", shippingId: "s600" });
  assert.equal(result.evaluation.totalPayableVnd, 610_000);
  assert.equal(result.giftLoss, null);

  // The tie is real: with the gift-keeping combination off the table, the 610K gift-losing one is chosen.
  const withoutIt = ok(run(merchandise, [ship("s600", 600_000)], { giftMin: 600_000 }, { isFeasible: (e) => !(e.merchandiseId === "m10" && e.shippingId === "s600") }));
  assert.deepEqual(withoutIt.selection, { merchandiseId: "m40", shippingId: null });
  assert.equal(withoutIt.evaluation.totalPayableVnd, 610_000);
  assert.deepEqual(withoutIt.giftLoss, { entitledSlotsLost: 1, selectedSlotsLost: 1 });
});

test("TG-09 tie-break order: kept chosen gift, then more entitled slots, then fewer vouchers, then stable id", () => {
  type Row = Readonly<{ id: string | null; gifts: GiftOutcome; count: number }>;
  // Every row costs 100 so only the tie-break decides. A row's `count` is what the evaluator reports.
  const pick = (rows: readonly Row[]) =>
    ok(
      optimizeVouchers({
        merchandise: rows.filter((row) => row.id !== null).map((row) => merch(row.id!, 1)),
        shipping: [],
        evaluate: (m) => {
          const row = rows.find((entry) => entry.id === (m?.id ?? null))!;
          return {
            ok: true,
            paidAfterVnd: 100,
            merchandiseDiscountVnd: m?.discountVnd ?? 0,
            shippingFeeBeforeVoucherVnd: 0,
            shippingDiscountVnd: 0,
            shippingFeeVnd: 0,
            totalPayableVnd: 100,
            gifts: row.gifts,
            voucherCount: row.count,
          };
        },
      }),
    ).selection.merchandiseId;
  const gifts = (entitledSlots: number, retainedSelectedSlots: number): GiftOutcome => ({ entitledSlots, retainedSelectedSlots });

  // 1. keeps the shopper's chosen gift, even against more entitled slots
  assert.equal(pick([{ id: null, gifts: gifts(1, 0), count: 0 }, { id: "m1", gifts: gifts(1, 1), count: 1 }, { id: "m2", gifts: gifts(2, 0), count: 1 }]), "m1");
  // 2. same retained gifts -> more valid gift slots
  assert.equal(pick([{ id: null, gifts: gifts(1, 0), count: 0 }, { id: "m2", gifts: gifts(2, 0), count: 1 }]), "m2");
  // 3. same gifts -> fewer vouchers consumed (NONE beats a voucher that saves nothing extra)
  assert.equal(pick([{ id: null, gifts: gifts(1, 0), count: 0 }, { id: "m3", gifts: gifts(1, 0), count: 1 }]), null);
  // 4. everything equal -> stable id, independent of the order the rows were supplied in
  const twins: Row[] = [{ id: "m3", gifts: gifts(1, 0), count: 1 }, { id: "m2", gifts: gifts(1, 0), count: 1 }];
  const noneIsWorse: Row = { id: null, gifts: gifts(0, 0), count: 0 };
  assert.equal(pick([noneIsWorse, ...twins]), "m2");
  assert.equal(pick([noneIsWorse, ...[...twins].reverse()]), "m2");
});

test("a total is never traded for gifts: the cheaper combination wins even when it loses a gift", () => {
  const result = ok(run([merch("m50", 50_000)], [], { giftMin: 600_000 }));
  assert.equal(result.selection.merchandiseId, "m50");
  assert.notEqual(result.giftLoss, null);
});

test("AC-04: a manual lock stays while valid and the other group is still optimized", () => {
  const result = ok(
    run(
      [merch("m20", 20_000), merch("m40", 40_000)],
      [ship("s", null)],
      {},
      { selection: { merchandise: { mode: "MANUAL", voucherId: "m20" }, shipping: { mode: "AUTO" } } },
    ),
  );
  assert.deepEqual(result.selection, { merchandiseId: "m20", shippingId: "s" });
  assert.deepEqual(result.notices, []);
});

test("AC-04: a lock that is no longer eligible is replaced by AUTO with a notice", () => {
  const result = ok(
    run([merch("m20", 20_000)], [], {}, { selection: { merchandise: { mode: "MANUAL", voucherId: "gone" }, shipping: { mode: "AUTO" } } }),
  );
  assert.equal(result.selection.merchandiseId, "m20");
  assert.deepEqual(result.notices, [{ code: "MANUAL_SELECTION_UNAVAILABLE", group: "MERCHANDISE", voucherId: "gone", reason: "NOT_ELIGIBLE" }]);
});

test("a manual shipping lock that cannot apply is dropped with the reason", () => {
  const result = ok(
    run([], [ship("s", null)], { campaignShippingFeeVnd: () => 0 }, { selection: { merchandise: { mode: "AUTO" }, shipping: { mode: "MANUAL", voucherId: "s" } } }),
  );
  assert.equal(result.selection.shippingId, null);
  assert.deepEqual(result.notices, [{ code: "MANUAL_SELECTION_UNAVAILABLE", group: "SHIPPING_FREE", voucherId: "s", reason: "NO_BENEFIT" }]);
});

test("manual NONE is pinned: AUTO does not bring a voucher back for that group", () => {
  const result = ok(
    run([merch("m", 50_000)], [ship("s", null)], {}, { selection: { merchandise: { mode: "MANUAL", voucherId: null }, shipping: { mode: "AUTO" } } }),
  );
  assert.deepEqual(result.selection, { merchandiseId: null, shippingId: "s" });
  const both = ok(
    run([merch("m", 50_000)], [ship("s", null)], {}, { selection: { merchandise: { mode: "MANUAL", voucherId: null }, shipping: { mode: "MANUAL", voucherId: null } } }),
  );
  assert.deepEqual(both.selection, { merchandiseId: null, shippingId: null });
  assert.equal(both.confirmation, null);
});

test("a manual lock that works only with the other group changed keeps the lock and re-optimizes the rest", () => {
  // Locking freeship s600 with m50 is invalid (570K < 600K), so the merchandise group falls back to NONE/other.
  const result = ok(
    run([merch("m50", 50_000)], [ship("s600", 600_000)], {}, { selection: { merchandise: { mode: "AUTO" }, shipping: { mode: "MANUAL", voucherId: "s600" } } }),
  );
  assert.deepEqual(result.selection, { merchandiseId: null, shippingId: "s600" });
  assert.deepEqual(result.notices, []);
});

test("POS seam (AC-20): an infeasible combination is excluded from AUTO", () => {
  const result = ok(run([merch("m50", 50_000), merch("m10", 10_000)], [], {}, { isFeasible: (e) => e.merchandiseId !== "m50" }));
  assert.equal(result.selection.merchandiseId, "m10");
});

test("POS seam (AC-20): a manual lock the vendor cannot project is reported unavailable, never silently kept", () => {
  const result = ok(
    run([merch("m50", 50_000), merch("m10", 10_000)], [], {}, {
      isFeasible: (e) => e.merchandiseId !== "m50",
      selection: { merchandise: { mode: "MANUAL", voucherId: "m50" }, shipping: { mode: "AUTO" } },
    }),
  );
  assert.equal(result.selection.merchandiseId, "m10");
  assert.deepEqual(result.notices, [{ code: "MANUAL_SELECTION_UNAVAILABLE", group: "MERCHANDISE", voucherId: "m50", reason: "POS_INFEASIBLE" }]);
});

test("POS seam: when even no voucher is infeasible nothing is recommended (fail closed)", () => {
  assert.deepEqual(run([merch("m", 1_000)], [], {}, { isFeasible: () => false }), { ok: false, reason: "NO_FEASIBLE_COMBINATION" });
});

test("an unavailable baseline fails closed instead of guessing a total", () => {
  const result = optimizeVouchers({ merchandise: [], shipping: [], evaluate: () => ({ ok: false, reason: "INVALID" }) });
  assert.deepEqual(result, { ok: false, reason: "BASELINE_UNAVAILABLE" });
});

test("candidate lists are bounded and ids must be unique and clean", () => {
  const many = Array.from({ length: MAX_VOUCHER_CANDIDATES_PER_GROUP + 1 }, (_, i) => merch(`m${i}`, 1_000));
  assert.deepEqual(run(many, []), { ok: false, reason: "INVALID_INPUT" });
  assert.deepEqual(run([merch("dup", 1_000), merch("dup", 2_000)], []), { ok: false, reason: "INVALID_INPUT" });
  assert.deepEqual(run([merch("bad id", 1_000)], []), { ok: false, reason: "INVALID_INPUT" });
  assert.deepEqual(run([merch("zero", 0)], []), { ok: false, reason: "INVALID_INPUT" });
  assert.equal(run(many.slice(0, MAX_VOUCHER_CANDIDATES_PER_GROUP), []).ok, true);
});

test("the search is deterministic whatever order candidates arrive in", () => {
  const merchandise = [merch("a", 10_000), merch("b", 10_000), merch("c", 5_000)];
  const shipping = [ship("y", null), ship("x", null)];
  const first = ok(run(merchandise, shipping));
  const second = ok(run([...merchandise].reverse(), [...shipping].reverse()));
  assert.deepEqual(first.selection, second.selection);
  assert.deepEqual(first.selection, { merchandiseId: "a", shippingId: "x" });
});

test("the evaluator refuses a discount that would empty the cart", () => {
  const evaluate = createCombinationEvaluator({
    paidSubtotalVnd: 10_000,
    existingOtherPromotions: false,
    campaignShippingFeeVnd: () => 30_000,
    shippingScopeSubtotalAfterVnd: () => 0,
    giftOutcome: () => ({ entitledSlots: 0, retainedSelectedSlots: 0 }),
  });
  assert.deepEqual(evaluate({ id: "all", discountVnd: 10_000 }, null), { ok: false, reason: "INVALID" });
});
