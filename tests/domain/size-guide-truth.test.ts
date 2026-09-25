import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { SIZE_GUIDE, loadBrandConfig, type SizeGuideConfig } from "../../src/brand/index.ts";
import {
  describePublicSizeTolerance,
  PUBLIC_SIZE_GUIDE,
} from "../../src/content/public-brand-facts.ts";
import { buildSizeGuideViewModel } from "../../src/routes/evergreen-model.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * A4 — the four approved La.na Design size guides, transcribed from master spec §11.
 *
 * Invented measurements cause returns, so every value is asserted rather than sampled: the guides'
 * IDs and order, each chart's size scale, and every cell of every row. A transcription slip is the
 * expected failure mode here, and a test that checked a sample would not find one.
 *
 * The other half is what the tables deliberately do **not** say. There is no fixed manufacturing
 * tolerance -- `±3 cm` was Brand #1's, and `0` would be a fake one -- and `set-vay-form-vua` has no
 * hip row at all, which is the approved shape of that chart rather than a value still to come.
 */

function withSizeGuide(mutate: (draft: SizeGuideConfig) => SizeGuideConfig) {
  return () =>
    loadBrandConfig(undefined, mutate(structuredClone(SIZE_GUIDE) as SizeGuideConfig));
}

const AO_DAI = {
  id: "ao-dai",
  title: "Áo dài",
  sizes: ["S", "M", "L"],
  rows: [
    { parameter: "Ngực (cm)", values: { S: "86", M: "92", L: "98" } },
    { parameter: "Eo (cm)", values: { S: "62–78", M: "66–82", L: "70–86" } },
    { parameter: "Mông (cm)", values: { S: "96", M: "102", L: "108" } },
    { parameter: "Chiều cao (cm)", values: { S: "153–160", M: "158–165", L: "160–170" } },
    { parameter: "Cân nặng (kg)", values: { S: "43–52", M: "52–62", L: "62–72" } },
  ],
} as const;

const SET_VAY_FORM_RONG = {
  id: "set-vay-form-rong",
  title: "Set/Váy form rộng",
  sizes: ["S", "M", "L", "XL"],
  rows: [
    { parameter: "Ngực (cm)", values: { S: "86", M: "90", L: "94", XL: "98" } },
    { parameter: "Eo (cm)", values: { S: "62–74", M: "66–78", L: "70–82", XL: "74–88" } },
    { parameter: "Mông (cm)", values: { S: "98", M: "102", L: "106", XL: "110" } },
    {
      parameter: "Chiều cao (cm)",
      values: { S: "155–168", M: "155–168", L: "155–168", XL: "155–168" },
    },
    { parameter: "Cân nặng (kg)", values: { S: "43–51", M: "51–57", L: "57–65", XL: "65–75" } },
  ],
} as const;

const SET_VAY_FORM_VUA = {
  id: "set-vay-form-vua",
  title: "Set/Váy form vừa",
  sizes: ["S", "M", "L", "XL"],
  rows: [
    { parameter: "Ngực (cm)", values: { S: "84", M: "88", L: "92", XL: "96" } },
    { parameter: "Eo (cm)", values: { S: "62–66", M: "66–72", L: "72–76", XL: "76–80" } },
    // No hip row. This is the original small-form chart; its source provides none (§11.3).
    {
      parameter: "Chiều cao (cm)",
      values: { S: "155–168", M: "155–168", L: "155–168", XL: "155–168" },
    },
    { parameter: "Cân nặng (kg)", values: { S: "43–50", M: "50–57", L: "57–64", XL: "64–72" } },
  ],
} as const;

// Re-issued by the owner on 2026-09-25 from the "Size chart" image for small-form products.
const SET_VAY_FORM_NHO = {
  id: "set-vay-form-nho",
  title: "Set/Váy form nhỏ",
  sizes: ["S", "M", "L", "XL"],
  rows: [
    { parameter: "Ngực (cm)", values: { S: "84–86", M: "86–90", L: "88–92", XL: "90–94" } },
    { parameter: "Eo (cm)", values: { S: "64–66", M: "70–72", L: "76–78", XL: "80–82" } },
    { parameter: "Mông (cm)", values: { S: "96", M: "100", L: "104", XL: "108" } },
    {
      parameter: "Chiều cao (cm)",
      values: { S: "153–168", M: "153–168", L: "153–168", XL: "153–168" },
    },
    { parameter: "Cân nặng (kg)", values: { S: "43–49", M: "50–55", L: "56–63", XL: "63–72" } },
  ],
} as const;

test("A4 the guide declares exactly the four approved charts, in the approved order", () => {
  assert.deepEqual(
    SIZE_GUIDE.charts.map((chart) => chart.id),
    ["ao-dai", "set-vay-form-rong", "set-vay-form-vua", "set-vay-form-nho"],
  );
});

test("A4 every chart matches master spec §11 cell for cell", () => {
  assert.deepEqual(
    SIZE_GUIDE.charts,
    [AO_DAI, SET_VAY_FORM_RONG, SET_VAY_FORM_VUA, SET_VAY_FORM_NHO],
  );
});

test("A4 set-vay-form-vua has no hip row, which is the approved shape of that chart", () => {
  const chart = SIZE_GUIDE.charts.find((candidate) => candidate.id === "set-vay-form-vua");
  assert.ok(chart);
  assert.equal(
    chart.rows.some((row) => row.parameter.startsWith("Mông")),
    false,
    "the source chart provides no hip values and none may be invented",
  );
  // The two charts that do have one still do, so the absence above is specific rather than a
  // hip row dropped from the transcription everywhere.
  for (const id of ["ao-dai", "set-vay-form-rong", "set-vay-form-nho"]) {
    const other = SIZE_GUIDE.charts.find((candidate) => candidate.id === id);
    assert.ok(other);
    assert.equal(other.rows.some((row) => row.parameter.startsWith("Mông")), true, id);
  }
});

test("A4 no fixed tolerance is published, and none is faked as a number", () => {
  assert.equal(SIZE_GUIDE.tolerance, null);
  assert.equal(describePublicSizeTolerance(), null);

  const published = JSON.stringify([SIZE_GUIDE, buildSizeGuideViewModel()]);
  for (const fake of ["±1", "±2", "±3", "±0", "0 cm", "Dung sai"]) {
    assert.equal(published.includes(fake), false, `${fake} must not reach a reader`);
  }
});

test("A4 a tolerance is still representable, and still validated, for a brand that has one", () => {
  // Absence is a fact about this brand, not a field the loader stopped checking.
  const loaded = loadBrandConfig(undefined, {
    ...(structuredClone(SIZE_GUIDE) as SizeGuideConfig),
    tolerance: { cm: 2, note: "Dung sai sai số may mặc: ±2 cm." },
  });
  assert.deepEqual(loaded.sizeGuide.tolerance, {
    cm: 2,
    note: "Dung sai sai số may mặc: ±2 cm.",
  });

  assert.throws(
    withSizeGuide((draft) => ({ ...draft, tolerance: { cm: -1, note: "x" } })),
    /tolerance/,
  );
  assert.throws(
    withSizeGuide((draft) => ({ ...draft, tolerance: { cm: 2, note: "  " } })),
    /tolerance/,
  );
});

test("A4 the measurements are body circumferences, and carry no garment-measurement semantics", () => {
  // §11: Ngực / Eo / Mông are measured on the body. The inherited wording described the garment,
  // which is the difference between a shopper measuring themselves and measuring a product.
  assert.match(SIZE_GUIDE.circumferenceSemanticsNote, /cơ thể/);
  for (const garment of ["quanh sản phẩm", "trải phẳng", "Rộng ngực", "Dài áo", "Dài tay", "Dài quần"]) {
    assert.equal(
      JSON.stringify(SIZE_GUIDE).includes(garment),
      false,
      `${garment} is garment-measurement wording and must not survive`,
    );
  }
});

test("A4 no Brand #1 chart, size scale or menswear copy survives", () => {
  const published = JSON.stringify(SIZE_GUIDE);
  for (const stale of [
    "relaxed-and-elastic-waist",
    "short-sleeve-tops",
    "Sản phẩm dáng rộng",
    "Áo ngắn tay",
    "2XL",
    "1m60–1m85",
  ]) {
    assert.equal(published.includes(stale), false, `${stale} must not survive`);
  }
});

test("A4 the units are cm for body measurements and height, and kg for weight", () => {
  assert.equal(SIZE_GUIDE.unit, "cm");
  for (const chart of SIZE_GUIDE.charts) {
    for (const row of chart.rows) {
      const expected = row.parameter.startsWith("Cân nặng") ? "(kg)" : "(cm)";
      assert.equal(
        row.parameter.endsWith(expected),
        true,
        `${chart.id} row "${row.parameter}" must state its unit as ${expected}`,
      );
    }
  }
});

test("A4 the view model omits tolerance entirely rather than rendering an empty one", () => {
  const model = buildSizeGuideViewModel();

  assert.equal(model.tolerance, null);
  assert.deepEqual(Object.keys(model).sort(), [
    "charts",
    "circumferenceSemanticsNote",
    "guidanceNote",
    "tolerance",
    "unit",
  ]);
  assert.deepEqual(model.charts, PUBLIC_SIZE_GUIDE.charts);
});

test("A4 no surface claims one unit for charts that carry more than one", () => {
  // Review finding on PR #6: the page said "đơn vị cm" and each chart caption repeated
  // "Đơn vị đo: cm", while every chart has a `Cân nặng (kg)` row. §11 splits the units -- body
  // measurements and height in cm, weight in kg -- so a single-unit claim is false for every one
  // of these tables. The rows carry their own unit; nothing above them may override it.
  const page = readFileSync(`${REPO_ROOT}src/app/size-guide/page.tsx`, "utf8");

  assert.doesNotMatch(page, /đơn vị/i, "the page must not claim a blanket unit");
  assert.doesNotMatch(page, /Đơn vị đo/i, "a chart caption must not claim a blanket unit");

  // Every chart really does mix units, which is what makes the claim above wrong rather than
  // merely redundant. Derived from the data so it stays true if a table changes.
  for (const chart of SIZE_GUIDE.charts) {
    const units = new Set(chart.rows.map((row) => row.parameter.match(/\(([^)]+)\)$/)?.[1]));
    assert.equal(units.has("cm"), true, chart.id);
    assert.equal(units.has("kg"), true, chart.id);
    assert.equal(units.size > 1, true, `${chart.id} mixes units, so no single-unit claim holds`);
  }
});
