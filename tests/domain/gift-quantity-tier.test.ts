import assert from "node:assert/strict";
import test from "node:test";

import {
  applyTierStep,
  findPricesInvalidForTier,
  MAX_TIER_LINES,
  MAX_TIER_UNITS,
  MAX_TIERS_PER_CAMPAIGN,
  priceQuantityTier,
  validateTierConfig,
  type QuantityTierConfig,
  type TierInputLine,
  type TierResult,
} from "../../src/commerce/gift-quantity-tier.ts";

const pct = (
  tiers: Array<[number, number]>,
  discountedUnits: QuantityTierConfig["discountedUnits"] = "ALL_ELIGIBLE_UNITS",
  selectionPriority: QuantityTierConfig["selectionPriority"] = null,
): QuantityTierConfig => ({
  unit: "PERCENTAGE",
  discountedUnits,
  selectionPriority,
  tiers: tiers.map(([minQuantity, discountValue]) => ({ minQuantity, discountValue })),
});
const vnd = (
  tiers: Array<[number, number]>,
  discountedUnits: QuantityTierConfig["discountedUnits"] = "ALL_ELIGIBLE_UNITS",
  selectionPriority: QuantityTierConfig["selectionPriority"] = null,
): QuantityTierConfig => ({ ...pct(tiers, discountedUnits, selectionPriority), unit: "FIXED_AMOUNT_PER_UNIT_VND" });
const line = (lineKey: string, quantity: number, unitPriceVnd: number, pancakeVariationId = `v-${lineKey}`): TierInputLine => ({
  lineKey, pancakeVariationId, quantity, unitPriceVnd,
});

function applied(result: TierResult) {
  assert.equal(result.status, "APPLIED", JSON.stringify(result));
  return result as Extract<TierResult, { status: "APPLIED" }>;
}
const sum = (result: TierResult) =>
  "segments" in result ? result.segments.reduce((total, segment) => total + segment.lineTotalVnd, 0) : NaN;

test("EX-07: tier N=3 10%, Q=5 — ALL discounts 5 units, FROM discounts 3 units", () => {
  const lines = [line("a", 5, 100_000)];
  const all = applied(priceQuantityTier(pct([[3, 10]]), lines));
  assert.equal(all.discountedUnitCount, 5);
  assert.equal(all.totalDiscountVnd, 50_000);
  const from = applied(priceQuantityTier(pct([[3, 10]], "FROM_REACHED_THRESHOLD", "CHEAPEST_FIRST"), lines));
  assert.equal(from.discountedUnitCount, 3);
  assert.equal(from.totalDiscountVnd, 30_000);
  assert.deepEqual(
    from.segments.map((segment) => [segment.segmentKey, segment.quantity, segment.unitPriceVnd]),
    [["a:disc", 3, 90_000], ["a:full", 2, 100_000]],
  );
});

test("below the start threshold nothing is discounted and prices come back unchanged", () => {
  const result = priceQuantityTier(pct([[3, 10]]), [line("a", 2, 100_000)]);
  assert.equal(result.status, "NOT_REACHED");
  assert.equal(sum(result), 200_000);
  assert.equal(result.status === "NOT_REACHED" && result.startThreshold, 3);
});

test("EX-08: FROM at Q=3 with 400k/600k/800k — CHEAPEST discounts the 400k unit, MOST_EXPENSIVE the 800k unit", () => {
  const lines = [line("mid", 1, 600_000), line("hi", 1, 800_000), line("lo", 1, 400_000)];
  const cheapest = applied(priceQuantityTier(pct([[3, 10]], "FROM_REACHED_THRESHOLD", "CHEAPEST_FIRST"), lines));
  assert.deepEqual(cheapest.segments.filter((s) => s.discounted).map((s) => [s.lineKey, s.unitPriceVnd]), [["lo", 360_000]]);
  assert.equal(cheapest.totalDiscountVnd, 40_000);
  const expensive = applied(priceQuantityTier(pct([[3, 10]], "FROM_REACHED_THRESHOLD", "MOST_EXPENSIVE_FIRST"), lines));
  assert.deepEqual(expensive.segments.filter((s) => s.discounted).map((s) => [s.lineKey, s.unitPriceVnd]), [["hi", 720_000]]);
  assert.equal(expensive.totalDiscountVnd, 80_000);
});

test("EX-17: 3 x 100.001 with tier N=3 10% FROM yields 2 x 100.001 + 1 x 90.001 = 290.003, prices never averaged", () => {
  const result = applied(priceQuantityTier(pct([[3, 10]], "FROM_REACHED_THRESHOLD", "CHEAPEST_FIRST"), [line("v", 3, 100_001, "same-variation")]));
  assert.deepEqual(
    result.segments.map((s) => [s.pancakeVariationId, s.quantity, s.unitPriceVnd, s.lineTotalVnd]),
    [["same-variation", 1, 90_001, 90_001], ["same-variation", 2, 100_001, 200_002]],
  );
  assert.equal(sum(result), 290_003);
  // distinct, stable segment keys even though the variation repeats
  assert.deepEqual(result.segments.map((s) => s.segmentKey), ["v:disc", "v:full"]);
});

test("D-06 rounding is half-up per unit: 5 x 90% = 5 per unit, so 3 units = 15 (not a rounded 13.5 -> 14)", () => {
  assert.equal(applyTierStep("PERCENTAGE", 10, 100_001), 90_001);
  assert.equal(applyTierStep("PERCENTAGE", 10, 5), 5, "4.5 rounds half-up to 5, which is 0 VND off — valid");
  const result = applied(priceQuantityTier(pct([[1, 10]]), [line("tiny", 3, 5)]));
  assert.equal(sum(result), 15);
  assert.equal(result.totalDiscountVnd, 0);
  // the same unit rounds identically however many units there are
  assert.equal(sum(applied(priceQuantityTier(pct([[1, 10]]), [line("tiny", 1, 5)]))), 5);
});

test("EX-19: 500k, tiers N=2 10% / N=4 15%, FROM — Q=3 saves 100.000, Q=4 saves 225.000 (the old formula would give 75.000)", () => {
  const config = pct([[2, 10], [4, 15]], "FROM_REACHED_THRESHOLD", "CHEAPEST_FIRST");
  const saved = (q: number) => {
    const result = priceQuantityTier(config, [line("x", q, 500_000)]);
    return result.status === "APPLIED" ? result.totalDiscountVnd : 0;
  };
  assert.equal(saved(1), 0);
  assert.equal(saved(2), 50_000);
  assert.equal(saved(3), 100_000);
  const four = applied(priceQuantityTier(config, [line("x", 4, 500_000)]));
  assert.equal(four.totalDiscountVnd, 225_000);
  assert.equal(four.discountedUnitCount, 3);
  assert.equal(four.winningTier.discountValue, 15, "only the highest reached tier supplies the value");
});

test("highest reached tier only: ALL applies the top tier's value to every unit, not a blend", () => {
  const result = applied(priceQuantityTier(pct([[2, 10], [4, 20]]), [line("x", 4, 100_000)]));
  assert.equal(result.winningTier.minQuantity, 4);
  assert.equal(result.totalDiscountVnd, 4 * 20_000);
  const middle = applied(priceQuantityTier(pct([[2, 10], [4, 20]]), [line("x", 3, 100_000)]));
  assert.equal(middle.winningTier.minQuantity, 2);
  assert.equal(middle.totalDiscountVnd, 3 * 10_000);
});

test("property: with non-decreasing tier values, one more unit never lowers this tier's total benefit", () => {
  const configs = [
    pct([[2, 10], [4, 15]], "FROM_REACHED_THRESHOLD", "CHEAPEST_FIRST"),
    pct([[2, 10], [4, 15]], "FROM_REACHED_THRESHOLD", "MOST_EXPENSIVE_FIRST"),
    pct([[3, 5], [6, 5], [9, 30]], "ALL_ELIGIBLE_UNITS"),
    vnd([[2, 10_000], [5, 25_000]], "FROM_REACHED_THRESHOLD", "CHEAPEST_FIRST"),
    vnd([[2, 10_000], [5, 25_000]], "ALL_ELIGIBLE_UNITS"),
  ];
  for (const config of configs) {
    let previous = 0;
    for (let q = 1; q <= 14; q += 1) {
      const result = priceQuantityTier(config, [line("only", q, 500_000)]);
      const benefit = result.status === "APPLIED" ? result.totalDiscountVnd : 0;
      assert.ok(benefit >= previous, `${config.unit}/${config.discountedUnits}: Q=${q} benefit ${benefit} < ${previous}`);
      previous = benefit;
    }
  }
});

test("FROM + VND: fixed amount per discounted unit, never a total and never a sale price", () => {
  const result = applied(priceQuantityTier(vnd([[3, 50_000]], "FROM_REACHED_THRESHOLD", "CHEAPEST_FIRST"), [line("a", 4, 500_000)]));
  assert.equal(result.discountedUnitCount, 2);
  assert.equal(result.totalDiscountVnd, 100_000);
  assert.deepEqual(result.segments.map((s) => [s.quantity, s.unitPriceVnd]), [[2, 450_000], [2, 500_000]]);
});

test("discounted units span lines in deterministic order; ties break by variation then line key, not input order", () => {
  const config = pct([[2, 10]], "FROM_REACHED_THRESHOLD", "CHEAPEST_FIRST");
  const a = [line("l1", 1, 100_000, "vB"), line("l2", 1, 100_000, "vA"), line("l3", 1, 100_000, "vA")];
  const forward = applied(priceQuantityTier(config, a));
  const reversed = applied(priceQuantityTier(config, [...a].reverse()));
  const pick = (r: ReturnType<typeof applied>) => r.segments.filter((s) => s.discounted).map((s) => s.lineKey).sort();
  assert.deepEqual(pick(forward), pick(reversed));
  assert.deepEqual(pick(forward), ["l2", "l3"].slice(0, 2).sort(), "vA lines come first, then line key");
  assert.equal(forward.discountedUnitCount, 2);
});

test("EX-21: a VND step that cannot leave a paid unit >= 1 VND drops the WHOLE tier, never clamps or partially applies", () => {
  const config = vnd([[2, 50_000]]);
  const result = priceQuantityTier(config, [line("cheap", 1, 40_000), line("rich", 1, 900_000)]);
  assert.equal(result.status, "TIER_PRICE_INVALID");
  assert.ok(result.status === "TIER_PRICE_INVALID");
  assert.deepEqual(result.offendingLineKeys, ["cheap"]);
  assert.equal(result.totalDiscountVnd, 0);
  assert.equal(sum(result), 940_000, "prices come back exactly as given");
  assert.ok(result.segments.every((segment) => !segment.discounted));
  // exactly equal to the price is also invalid: 0 VND is never a paid price
  assert.equal(priceQuantityTier(vnd([[1, 40_000]]), [line("eq", 1, 40_000)]).status, "TIER_PRICE_INVALID");
  // one more VND of headroom is valid
  assert.equal(priceQuantityTier(vnd([[1, 39_999]]), [line("ok", 1, 40_000)]).status, "APPLIED");
});

test("FROM only validates the units it would actually discount", () => {
  const config = vnd([[2, 50_000]], "FROM_REACHED_THRESHOLD", "MOST_EXPENSIVE_FIRST");
  // Q=2 -> 1 discounted unit; the expensive one is chosen, the cheap one is never touched
  const result = applied(priceQuantityTier(config, [line("cheap", 1, 40_000), line("rich", 1, 900_000)]));
  assert.deepEqual(result.segments.filter((s) => s.discounted).map((s) => s.lineKey), ["rich"]);
});

test("a percentage that rounds a tiny price to 0 VND is invalid, never a free paid line", () => {
  const result = priceQuantityTier(pct([[1, 99]]), [line("one", 1, 1)]);
  assert.equal(result.status, "TIER_PRICE_INVALID");
  assert.equal(applyTierStep("PERCENTAGE", 99, 49), null, "49 x 1% = 0.49 rounds to 0");
  assert.equal(applyTierStep("PERCENTAGE", 99, 50), 1, "0.5 rounds half-up to 1");
});

test("a result never contains a 0 VND or negative paid segment", () => {
  for (const price of [1, 2, 49, 50, 51, 99, 100, 101, 12_345, 999_999]) {
    for (const value of [1, 10, 50, 99]) {
      const result = priceQuantityTier(pct([[1, value]]), [line("p", 2, price)]);
      if (result.status === "APPLIED") assert.ok(result.segments.every((segment) => segment.unitPriceVnd >= 1));
      else assert.equal(result.status, "TIER_PRICE_INVALID");
    }
  }
});

test("config validation: strictly increasing thresholds, non-decreasing same-unit values, unit ranges, selection rules", () => {
  assert.deepEqual(validateTierConfig(pct([[2, 10], [4, 15]])), []);
  assert.ok(validateTierConfig(pct([])).includes("TIERS_EMPTY"));
  assert.ok(validateTierConfig(pct([[2, 10], [2, 15]])).includes("THRESHOLD_NOT_STRICTLY_INCREASING"));
  assert.ok(validateTierConfig(pct([[4, 10], [2, 15]])).includes("THRESHOLD_NOT_STRICTLY_INCREASING"));
  assert.ok(validateTierConfig(pct([[2, 15], [4, 10]])).includes("VALUE_DECREASES_WITH_THRESHOLD"));
  assert.ok(validateTierConfig(vnd([[2, 20_000], [4, 10_000]])).includes("VALUE_DECREASES_WITH_THRESHOLD"));
  assert.ok(validateTierConfig(pct([[0, 10]])).includes("THRESHOLD_INVALID"));
  assert.ok(validateTierConfig(pct([[1.5, 10]])).includes("THRESHOLD_INVALID"));
  assert.ok(validateTierConfig(pct([[2, 0]])).includes("VALUE_INVALID"));
  assert.ok(validateTierConfig(pct([[2, 100]])).includes("VALUE_INVALID"));
  assert.ok(validateTierConfig(vnd([[2, 0]])).includes("VALUE_INVALID"));
  assert.ok(validateTierConfig(vnd([[2, -5]])).includes("VALUE_INVALID"));
  assert.ok(validateTierConfig(vnd([[2, 2_000_000_001]])).includes("VALUE_INVALID"));
  assert.ok(validateTierConfig(pct(Array.from({ length: MAX_TIERS_PER_CAMPAIGN + 1 }, (_, i) => [i + 1, 1] as [number, number]))).includes("TIERS_TOO_MANY"));
  assert.ok(validateTierConfig(pct([[2, 10]], "FROM_REACHED_THRESHOLD", null)).includes("SELECTION_PRIORITY_REQUIRED"));
  assert.ok(validateTierConfig(pct([[2, 10]], "ALL_ELIGIBLE_UNITS", "CHEAPEST_FIRST")).includes("SELECTION_PRIORITY_NOT_APPLICABLE"));
  assert.ok(validateTierConfig({ ...pct([[2, 10]]), unit: "FIXED_PRICE" as never }).includes("UNIT_INVALID"));
  assert.ok(validateTierConfig({ ...pct([[2, 10]]), discountedUnits: "SOME" as never }).includes("DISCOUNTED_UNITS_INVALID"));
});

test("the engine refuses to price from an invalid ladder", () => {
  const result = priceQuantityTier(pct([[2, 15], [4, 10]]), [line("a", 5, 100_000)]);
  assert.deepEqual(result, { status: "INVALID_CONFIG", issues: ["VALUE_DECREASES_WITH_THRESHOLD"] });
});

test("input bounds and malformed lines are rejected, not priced", () => {
  const config = pct([[1, 10]]);
  assert.deepEqual(priceQuantityTier(config, [line("a", 0, 100)]), { status: "INVALID_INPUT", reason: "QUANTITY_INVALID" });
  assert.deepEqual(priceQuantityTier(config, [line("a", 1.5, 100)]), { status: "INVALID_INPUT", reason: "QUANTITY_INVALID" });
  assert.deepEqual(priceQuantityTier(config, [line("a", 1, 0)]), { status: "INVALID_INPUT", reason: "PRICE_INVALID" });
  assert.deepEqual(priceQuantityTier(config, [line("a", 1, -3)]), { status: "INVALID_INPUT", reason: "PRICE_INVALID" });
  assert.deepEqual(priceQuantityTier(config, [line("a", 1, 100), line("a", 1, 100)]), { status: "INVALID_INPUT", reason: "LINE_KEY_INVALID" });
  assert.deepEqual(priceQuantityTier(config, [line("", 1, 100)]), { status: "INVALID_INPUT", reason: "LINE_KEY_INVALID" });
  assert.deepEqual(
    priceQuantityTier(config, Array.from({ length: MAX_TIER_LINES + 1 }, (_, i) => line(`l${i}`, 1, 100))),
    { status: "INVALID_INPUT", reason: "TOO_MANY_LINES" },
  );
  assert.deepEqual(priceQuantityTier(config, [line("a", MAX_TIER_UNITS + 1, 100)]), { status: "INVALID_INPUT", reason: "TOO_MANY_UNITS" });
  assert.deepEqual(
    priceQuantityTier(config, [line("a", MAX_TIER_UNITS, Number.MAX_SAFE_INTEGER)]),
    { status: "INVALID_INPUT", reason: "TOTAL_OVERFLOW" },
    "an overflowing total is an error, never a wrapped number",
  );
  assert.deepEqual(
    priceQuantityTier(pct([[99, 10]]), [line("a", 2, Number.MAX_SAFE_INTEGER)]),
    { status: "INVALID_INPUT", reason: "TOTAL_OVERFLOW" },
    "also when no tier is reached",
  );
});

test("money is exact at the top of the safe-integer range for a single unit", () => {
  const result = applied(priceQuantityTier(pct([[1, 10]]), [line("big", 1, Number.MAX_SAFE_INTEGER)]));
  assert.ok(Number.isSafeInteger(result.segments[0]!.unitPriceVnd));
  // 9007199254740991 * 0.9 = 8106479329266891.9 -> half-up 8106479329266892
  assert.equal(result.segments[0]!.unitPriceVnd, 8_106_479_329_266_892);
});

test("publish-time safety: prices the largest tier value cannot leave valid are reported with remaining prices as input", () => {
  const config = vnd([[2, 10_000], [4, 50_000]]);
  assert.deepEqual(findPricesInvalidForTier(config, [40_000, 50_000, 50_001, 900_000]), [40_000, 50_000]);
  assert.deepEqual(findPricesInvalidForTier(pct([[2, 99]]), [1, 49, 50, 1_000]), [1, 49]);
  assert.deepEqual(findPricesInvalidForTier(pct([[2, 15], [4, 10]]), [1]), [], "an invalid ladder reports nothing here; validate it first");
  // EX-21 shape: price remaining after a 10% flash on 44.444 -> 40.000 cannot take a 50.000 step
  assert.deepEqual(findPricesInvalidForTier(vnd([[1, 50_000]]), [40_000]), [40_000]);
});

test("segments total always equals the sum of source totals minus the reported discount", () => {
  const lines = [line("a", 3, 123_457), line("b", 2, 98_765), line("c", 4, 250_001)];
  for (const config of [
    pct([[2, 7]], "ALL_ELIGIBLE_UNITS"),
    pct([[2, 7], [5, 12]], "FROM_REACHED_THRESHOLD", "CHEAPEST_FIRST"),
    pct([[2, 7], [5, 12]], "FROM_REACHED_THRESHOLD", "MOST_EXPENSIVE_FIRST"),
    vnd([[3, 9_999]], "FROM_REACHED_THRESHOLD", "MOST_EXPENSIVE_FIRST"),
  ]) {
    const result = priceQuantityTier(config, lines);
    const before = lines.reduce((total, l) => total + l.quantity * l.unitPriceVnd, 0);
    assert.ok(result.status === "APPLIED");
    assert.equal(sum(result), before - result.totalDiscountVnd);
    assert.equal(result.segments.reduce((q, s) => q + s.quantity, 0), 9, "no unit is created or lost");
  }
});
