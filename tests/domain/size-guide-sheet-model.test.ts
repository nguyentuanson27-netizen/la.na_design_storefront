import assert from "node:assert/strict";
import test from "node:test";

import { SIZE_GUIDE } from "../../src/brand/index.ts";
import {
  buildSizeGuideSheetTable,
  buildSizeGuideSheetTitle,
  isSelectedGuideSize,
} from "../../src/components/headless/size-guide-sheet-model.ts";
import { resolveProductMappedSizeGuide } from "../../src/routes/product-model.ts";

function chart(id: string) {
  const found = SIZE_GUIDE.charts.find((candidate) => candidate.id === id);
  assert.ok(found, `approved chart ${id} exists`);
  return found;
}

test("phone sheet table: one row per size, weight first, then the chart's own order", () => {
  const table = buildSizeGuideSheetTable(chart("set-vay-form-rong"));

  assert.deepEqual(
    table.columns.map((column) => column.label),
    ["Cân nặng", "Ngực", "Eo", "Mông", "Chiều cao"],
  );
  assert.deepEqual(
    table.columns.map((column) => column.unit),
    ["kg", "cm", "cm", "cm", "cm"],
  );
  assert.deepEqual(
    table.rows.map((row) => row.size),
    ["S", "M", "L", "XL"],
  );
  // Values pass through untouched: the sheet authors no number.
  assert.deepEqual(table.rows[3]!.cells, ["65–75", "98", "74–88", "110", "155–168"]);
});

test("phone sheet table: a measurement the chart lacks makes no column", () => {
  const table = buildSizeGuideSheetTable(chart("set-vay-form-vua"));

  assert.deepEqual(
    table.columns.map((column) => column.label),
    ["Cân nặng", "Ngực", "Eo", "Chiều cao"],
  );
  assert.ok(table.rows.every((row) => row.cells.length === 4 && row.cells.every((cell) => cell !== "")));
});

test("phone sheet table: every approved chart keeps all of its approved values", () => {
  for (const approved of SIZE_GUIDE.charts) {
    const table = buildSizeGuideSheetTable(approved);
    const cells = table.rows.flatMap((row) => row.cells).sort();
    const expected = approved.rows.flatMap((row) => approved.sizes.map((size) => row.values[size]!)).sort();
    assert.deepEqual(cells, expected, approved.id);
  }
});

test("selected size matches ignoring case and spacing, and nothing matches while none is chosen", () => {
  assert.equal(isSelectedGuideSize("XL", "xl"), true);
  assert.equal(isSelectedGuideSize("M", " M "), true);
  assert.equal(isSelectedGuideSize("M", "L"), false);
  assert.equal(isSelectedGuideSize("M", null), false);
});

test("sheet title names the product code, and falls back to the guide's own name without one", () => {
  assert.equal(buildSizeGuideSheetTitle("Áo dài", "V-DA247"), "Bảng size V-DA247");
  assert.equal(buildSizeGuideSheetTitle("Áo dài", "  "), "Bảng size Áo dài");
  assert.equal(buildSizeGuideSheetTitle("Áo dài", null), "Bảng size Áo dài");
});

test("the mapped guide carries the product code for the sheet title", () => {
  assert.equal(resolveProductMappedSizeGuide("ao-dai", null, "V-DA247")?.productCode, "V-DA247");
  assert.equal(resolveProductMappedSizeGuide("ao-dai")?.productCode, null);
});

import {
  findGuideSizeChoice,
  resolveSizeGuideAction,
} from "../../src/components/headless/size-guide-sheet-model.ts";

const CHOICES = [
  { value: "S", disabled: false },
  { value: "M", disabled: false },
  { value: "L", disabled: true },
] as const;

test("a chart row maps to the selector's size by label, and to nothing when the product lacks it", () => {
  assert.equal(findGuideSizeChoice("m", CHOICES)?.value, "M");
  assert.equal(findGuideSizeChoice("XL", CHOICES), null);
});

test("the primary button chooses the picked size only when the selector would accept it", () => {
  const base = { choices: CHOICES, canChoose: true } as const;

  assert.deepEqual(resolveSizeGuideAction({ ...base, pickedSize: "M" }), {
    label: "Chọn size M",
    value: "M",
    enabled: true,
    note: null,
  });
  assert.equal(resolveSizeGuideAction({ ...base, pickedSize: null }).enabled, false);
  assert.equal(resolveSizeGuideAction({ ...base, pickedSize: "XL" }).enabled, false);
  assert.equal(resolveSizeGuideAction({ ...base, pickedSize: "L" }).enabled, false);
  assert.match(resolveSizeGuideAction({ ...base, pickedSize: "L" }).note ?? "", /chưa mua được/);

  const locked = resolveSizeGuideAction({ ...base, canChoose: false, pickedSize: "M" });
  assert.equal(locked.enabled, false);
  assert.match(locked.note ?? "", /loại sản phẩm/);
});
