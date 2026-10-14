import assert from "node:assert/strict";
import test from "node:test";

import {
  GIFT_VENDOR_UNIT_PRICE_VND,
  hashVendorLines,
  projectBenefitQuoteForVendor,
  type ProjectionLine,
} from "../../src/commerce/pancake-gift-projection.ts";

const paid = (lineId: string, variation: string, quantity: number, unitPriceVnd: number): ProjectionLine => ({ lineId, role: "PAID", pancakeVariationId: variation, quantity, unitPriceVnd });
const gift = (lineId: string, variation: string, quantity: number): ProjectionLine => ({ lineId, role: "GIFT", pancakeVariationId: variation, quantity, unitPriceVnd: 0 });

const linesOf = (result: ReturnType<typeof projectBenefitQuoteForVendor>) => {
  assert.ok(result.ok, JSON.stringify(result));
  return result.ok ? result.lines.map((line) => [line.pancakeVariationId, line.quantity, line.unitPriceVnd]) : [];
};

/** The ADR 0016 D-08 text, executed literally unit by unit: the oracle for the closed-form walk. */
function reference(lines: readonly ProjectionLine[]) {
  const giftUnits = lines.filter((line) => line.role === "GIFT").reduce((sum, line) => sum + line.quantity, 0);
  let remaining = giftUnits * GIFT_VENDOR_UNIT_PRICE_VND;
  const units: Array<{ lineId: string; index: number; variation: string; price: number }> = [];
  for (const line of lines.filter((candidate) => candidate.role === "PAID")) {
    for (let index = 0; index < line.quantity; index += 1) units.push({ lineId: line.lineId, index, variation: line.pancakeVariationId, price: line.unitPriceVnd });
  }
  units.sort((a, b) => b.price - a.price || (a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0) || a.index - b.index);
  for (const unit of units) {
    const take = Math.min(remaining, unit.price - 1);
    unit.price -= take;
    remaining -= take;
  }
  if (remaining > 0) return null;
  const grouped = new Map<string, number>();
  for (const unit of units) grouped.set(`${unit.variation}\u0000${unit.price}`, (grouped.get(`${unit.variation}\u0000${unit.price}`) ?? 0) + 1);
  for (const line of lines.filter((candidate) => candidate.role === "GIFT")) {
    grouped.set(`${line.pancakeVariationId}\u0000${GIFT_VENDOR_UNIT_PRICE_VND}`, (grouped.get(`${line.pancakeVariationId}\u0000${GIFT_VENDOR_UNIT_PRICE_VND}`) ?? 0) + line.quantity);
  }
  return [...grouped].map(([key, quantity]) => { const [variation, price] = key.split("\u0000"); return [variation!, quantity, Number(price)] as const; })
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : b[2] - a[2]));
}

test("the gift unit price is the single owner-approved constant", () => {
  assert.equal(GIFT_VENDOR_UNIT_PRICE_VND, 1000);
});

test("no gift: the projection is the paid segments, unmerged across prices (EX-17: 2 x 100.001d + 1 x 90.001d = 290.003d)", () => {
  const result = projectBenefitQuoteForVendor([paid("P:v:0", "v", 2, 100_001), paid("P:v:1", "v", 1, 90_001)]);
  assert.deepEqual(linesOf(result), [["v", 2, 100_001], ["v", 1, 90_001]]);
  assert.ok(result.ok && result.paidTotalVnd === 290_003);
});

test("gift units go out at 1.000d and the same amount is taken from the dearest paid units first, total unchanged", () => {
  const input = [paid("P:v:0", "v", 2, 100_001), paid("P:v:1", "v", 1, 90_001), gift("G:c:g", "g", 3)];
  const result = projectBenefitQuoteForVendor(input);
  assert.deepEqual(linesOf(result), [["g", 3, 1000], ["v", 1, 100_001], ["v", 1, 97_001], ["v", 1, 90_001]]);
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.lines.reduce((sum, line) => sum + line.quantity * line.unitPriceVnd, 0), 290_003, "the Pancake total is the website total");
  }
});

test("a gift of a variation that is also bought: the case GQ01 proved (99.000d + 1.000d on one variation)", () => {
  assert.deepEqual(linesOf(projectBenefitQuoteForVendor([paid("P:v:0", "v", 1, 100_000), gift("G:c:v", "v", 1)])), [["v", 1, 99_000], ["v", 1, 1000]]);
  // When a deducted paid unit lands on exactly 1.000d it joins the gift line instead of repeating it.
  assert.deepEqual(linesOf(projectBenefitQuoteForVendor([paid("P:v:0", "v", 1, 2000), gift("G:c:v", "v", 1)])), [["v", 2, 1000]]);
});

test("a unit never reaches 0d: deductions saturate at price - 1 and spill to the next unit", () => {
  assert.deepEqual(linesOf(projectBenefitQuoteForVendor([paid("P:v:0", "v", 2, 600), gift("G:c:g", "g", 1)])), [["g", 1, 1000], ["v", 1, 199], ["v", 1, 1]].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (b[2] as number) - (a[2] as number))));
  const result = projectBenefitQuoteForVendor([paid("P:v:0", "v", 1, 1), gift("G:c:g", "g", 1)]);
  assert.deepEqual(result, { ok: false, reason: "VENDOR_PROJECTION_INFEASIBLE" });
  assert.deepEqual(projectBenefitQuoteForVendor([paid("P:v:0", "v", 1, 1000), gift("G:c:g", "g", 2)]), { ok: false, reason: "VENDOR_PROJECTION_INFEASIBLE" });
  // Exactly enough room is feasible: 3 units at 334d can give 333 each = 999, one gift needs 1000 -> not; 4 units can.
  assert.equal(projectBenefitQuoteForVendor([paid("P:v:0", "v", 3, 334), gift("G:c:g", "g", 1)]).ok, false);
  assert.equal(projectBenefitQuoteForVendor([paid("P:v:0", "v", 4, 334), gift("G:c:g", "g", 1)]).ok, true);
});

test("determinism: input order is irrelevant and the hash follows the lines", () => {
  const input = [paid("P:a:0", "a", 3, 120_000), paid("P:b:0", "b", 1, 95_500), paid("P:a:1", "a", 1, 110_000), gift("G:c:g", "g", 2), gift("G:d:h", "h", 1)];
  const forward = projectBenefitQuoteForVendor(input);
  const reversed = projectBenefitQuoteForVendor([...input].reverse());
  assert.deepEqual(forward, reversed);
  assert.ok(forward.ok && /^[0-9a-f]{64}$/.test(forward.hash));
  if (forward.ok) {
    assert.equal(forward.hash, hashVendorLines(forward.lines));
    assert.notEqual(forward.hash, hashVendorLines([...forward.lines].reverse().map((line, index) => (index === 0 ? { ...line, quantity: line.quantity + 1 } : line))));
  }
});

test("quantities are never enumerated: a billion-unit line projects in constant time", () => {
  const result = projectBenefitQuoteForVendor([paid("P:v:0", "v", 1_000_000_000, 100_000), gift("G:c:g", "g", 100)]);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(linesOf(result), [["g", 100, 1000], ["v", 1, 1], ["v", 1, 99_999], ["v", 999_999_998, 100_000]].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (b[2] as number) - (a[2] as number))));
  assert.equal(result.paidTotalVnd, 100_000_000_000_000);
});

test("the closed-form walk agrees with the literal unit-by-unit rule on many shapes", () => {
  let seed = 12345;
  const next = (bound: number) => { seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff; return seed % bound; };
  for (let round = 0; round < 400; round += 1) {
    const lines: ProjectionLine[] = [];
    for (let index = 0, count = 1 + next(4); index < count; index += 1) lines.push(paid(`P:${index}`, `v${next(3)}`, 1 + next(6), 1 + next(5) === 1 ? 1 + next(3) : 500 + next(3000)));
    if (next(3) > 0) for (let index = 0, count = 1 + next(3); index < count; index += 1) lines.push(gift(`G:${index}`, `g${next(2)}`, 1 + next(3)));
    const expected = reference(lines);
    const actual = projectBenefitQuoteForVendor(lines);
    if (expected === null) assert.deepEqual(actual, { ok: false, reason: "VENDOR_PROJECTION_INFEASIBLE" }, JSON.stringify(lines));
    else assert.deepEqual(linesOf(actual), expected.map((line) => [...line]), JSON.stringify(lines));
  }
});

test("malformed quotes are refused, never repaired", () => {
  const invalid = { ok: false, reason: "VENDOR_PROJECTION_INVALID" };
  assert.deepEqual(projectBenefitQuoteForVendor([]), invalid);
  assert.deepEqual(projectBenefitQuoteForVendor([gift("G:c:g", "g", 1)]), invalid); // nothing paid
  assert.deepEqual(projectBenefitQuoteForVendor([paid("P:v:0", "v", 1, 0)]), invalid);
  assert.deepEqual(projectBenefitQuoteForVendor([paid("P:v:0", "v", 0, 100)]), invalid);
  assert.deepEqual(projectBenefitQuoteForVendor([paid("P:v:0", "v", 1.5, 100)]), invalid);
  assert.deepEqual(projectBenefitQuoteForVendor([paid("P:v:0", "v", 1, 100), { ...gift("G:c:g", "g", 1), unitPriceVnd: 5 }]), invalid);
  assert.deepEqual(projectBenefitQuoteForVendor([paid("P:v:0", "", 1, 100)]), invalid);
  assert.deepEqual(projectBenefitQuoteForVendor([paid("P:v:0", "v", 1, 100), { ...paid("P:v:1", "v", 1, 100), role: "OTHER" as never }]), invalid);
  assert.deepEqual(projectBenefitQuoteForVendor(null as never), invalid);
  assert.deepEqual(projectBenefitQuoteForVendor(Array.from({ length: 401 }, (_, index) => paid(`P:${index}`, `v${index}`, 1, 100))), invalid);
  assert.deepEqual(projectBenefitQuoteForVendor([paid("P:v:0", "v", Number.MAX_SAFE_INTEGER, 100)]), invalid);
});
