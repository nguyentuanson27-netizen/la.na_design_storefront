import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { tiersAfterBasisChange } from "../../src/components/admin/gift-quantity-tier-basis.ts";

const rows = [{ key: 0, min: "3", value: "10" }, { key: 1, min: "5", value: "15" }];

test("switching pieces -> order value clears every threshold, so '3 pieces' cannot become 'an order from 3 ₫'", () => {
  const next = tiersAfterBasisChange(rows, "QUANTITY", "ORDER_SUBTOTAL", false);
  assert.deepEqual(next.map((row) => row.min), ["", ""]);
  assert.deepEqual(next.map((row) => row.value), ["10", "15"], "a percentage means the same on both bases");
  assert.deepEqual(next.map((row) => row.key), [0, 1]);
});

test("switching order value -> pieces clears the thresholds too: 500.000 ₫ must not turn into 500.000 pieces", () => {
  const next = tiersAfterBasisChange([{ key: 0, min: "500000", value: "5" }], "ORDER_SUBTOTAL", "QUANTITY", false);
  assert.equal(next[0]!.min, "");
});

test("a discount amount whose unit was cleared by the switch is cleared with it", () => {
  const next = tiersAfterBasisChange([{ key: 0, min: "3", value: "20000" }], "QUANTITY", "ORDER_SUBTOTAL", true);
  assert.deepEqual([next[0]!.min, next[0]!.value], ["", ""]);
});

test("choosing the basis the form is already on changes nothing, and the input is not mutated", () => {
  const same = tiersAfterBasisChange(rows, "QUANTITY", "QUANTITY", false);
  assert.deepEqual(same, rows);
  assert.notEqual(same, rows);
  tiersAfterBasisChange(rows, "QUANTITY", "ORDER_SUBTOTAL", true);
  assert.deepEqual(rows, [{ key: 0, min: "3", value: "10" }, { key: 1, min: "5", value: "15" }]);
});

test("the admin form routes a basis change through that helper", () => {
  const source = readFileSync(new URL("../../src/components/admin/gift-quantity-tier-fields.tsx", import.meta.url), "utf8");
  const choose = source.slice(source.indexOf("function chooseBasis"), source.indexOf("function changeTier"));
  assert.match(choose, /setTiers\(\(previous\) => tiersAfterBasisChange\(previous, basis, next,/);
});
