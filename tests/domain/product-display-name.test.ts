import assert from "node:assert/strict";
import test from "node:test";

import { categoryByKey } from "../../src/commerce/category-taxonomy.ts";
import {
  normalizeCategoryProductDisplayName,
  splitTrailingProductCode,
  stripTrailingProductCode,
} from "../../src/commerce/product-display-name.ts";

test("product display name drops the trailing Pancake product code", () => {
  assert.equal(stripTrailingProductCode("Set váy Diệu Liên Hoa SV605"), "Set váy Diệu Liên Hoa");
  assert.equal(stripTrailingProductCode("Áo sơ mi Hoa Nhí A132"), "Áo sơ mi Hoa Nhí");
  assert.equal(stripTrailingProductCode("SET VÁY HOA NHÍ SV555"), "SET VÁY HOA NHÍ");
  assert.equal(stripTrailingProductCode("Đầm xoè sv605"), "Đầm xoè");
  assert.equal(stripTrailingProductCode("Váy hoa SV605-2"), "Váy hoa");
  assert.equal(stripTrailingProductCode("  Váy hoa   SV605  "), "Váy hoa");
  // No cap on the letter prefix: any run of ASCII letters followed by digits is a code.
  assert.equal(stripTrailingProductCode("Váy hoa ABCDEFGHI123"), "Váy hoa");
});

test("product display name drops a code behind a separator or in brackets", () => {
  assert.equal(stripTrailingProductCode("Váy hoa - SV605"), "Váy hoa");
  assert.equal(stripTrailingProductCode("Váy hoa | SV605"), "Váy hoa");
  assert.equal(stripTrailingProductCode("Váy hoa (SV605)"), "Váy hoa");
  assert.equal(stripTrailingProductCode("Váy hoa [#SV605]"), "Váy hoa");
  assert.equal(stripTrailingProductCode("Váy hoa #SV605"), "Váy hoa");
});

test("product display name keeps names without a trailing product code", () => {
  assert.equal(stripTrailingProductCode("Set váy Diệu Liên Hoa"), "Set váy Diệu Liên Hoa");
  assert.equal(stripTrailingProductCode("Áo dài Tết 2026"), "Áo dài Tết 2026");
  assert.equal(stripTrailingProductCode("Áo sơ mi size XL"), "Áo sơ mi size XL");
  assert.equal(stripTrailingProductCode("Set 2 món"), "Set 2 món");
  assert.equal(stripTrailingProductCode("VáySV605"), "VáySV605");
  assert.equal(stripTrailingProductCode("SV605 Váy hoa"), "SV605 Váy hoa");
});

test("product display name keeps the code when the rest is only the garment type", () => {
  assert.equal(stripTrailingProductCode("SET VÁY SV771"), "SET VÁY SV771");
  assert.equal(stripTrailingProductCode("SET VAY SV555"), "SET VAY SV555");
  assert.equal(stripTrailingProductCode("Set quần SV12"), "Set quần SV12");
  assert.equal(stripTrailingProductCode("Set quần áo - SV12"), "Set quần áo - SV12");
  assert.equal(stripTrailingProductCode("Áo A132"), "Áo A132");
  assert.equal(stripTrailingProductCode("Váy đầm (VD20)"), "Váy đầm (VD20)");
  assert.equal(stripTrailingProductCode("Áo sơ mi nữ AS7"), "Áo sơ mi nữ AS7");
  assert.deepEqual(splitTrailingProductCode("SET VÁY SV771"), {
    name: "SET VÁY SV771",
    productCode: "SV771",
  });
  assert.deepEqual(splitTrailingProductCode("Váy đầm (VD20)"), {
    name: "Váy đầm (VD20)",
    productCode: "VD20",
  });
  // Names as they appear in the Pancake product list.
  for (const name of [
    "SET VÁY TSV45",
    "SET SQ917",
    "SET VAY SV021",
    "ÁO SD384",
    "SET VAY SV572",
    "TÚI SV244",
    "SET VÁY SV771",
    "SET VÁY TSV15",
    "SET VÁY SV600",
  ]) {
    assert.equal(stripTrailingProductCode(name), name);
  }
  // Any word beyond the garment type is a real name, so the code is split off.
  assert.equal(stripTrailingProductCode("Set váy đỏ SV771"), "Set váy đỏ");
  assert.equal(stripTrailingProductCode("SET VÁY HOA SV771"), "SET VÁY HOA");
});

test("product display name never empties a name that is only a code", () => {
  assert.equal(stripTrailingProductCode("SV605"), "SV605");
  assert.equal(stripTrailingProductCode("(SV605)"), "(SV605)");
});

test("product display name keeps the split-off product code for search", () => {
  assert.deepEqual(splitTrailingProductCode("Set váy Diệu Liên Hoa SV605"), {
    name: "Set váy Diệu Liên Hoa",
    productCode: "SV605",
  });
  assert.deepEqual(splitTrailingProductCode("Váy hoa (#SV605-2)"), {
    name: "Váy hoa",
    productCode: "SV605-2",
  });
  assert.deepEqual(splitTrailingProductCode("Váy hoa [sv605]"), { name: "Váy hoa", productCode: "sv605" });
  assert.deepEqual(splitTrailingProductCode("Áo dài Tết 2026"), {
    name: "Áo dài Tết 2026",
    productCode: null,
  });
  assert.deepEqual(splitTrailingProductCode("SV605"), { name: "SV605", productCode: null });
});

test("normalizes product display name for 4-panel (aoDai4Ta) category", () => {
  assert.equal(
    normalizeCategoryProductDisplayName("Áo dài Bạch Hoa Vi", ["aoDai4Ta"]),
    "Áo dài 4 tà Bạch Hoa Vi",
  );
  assert.equal(
    normalizeCategoryProductDisplayName("Áo Dài Liên Châu", ["aoDai4Ta"]),
    "Áo dài 4 tà Liên Châu",
  );
  assert.equal(
    normalizeCategoryProductDisplayName("Áo dài 4 tà Bạch Hoa Vi", ["aoDai4Ta"]),
    "Áo dài 4 tà Bạch Hoa Vi",
  );
  assert.equal(
    normalizeCategoryProductDisplayName("Áo Dài 4 tà Liên Châu", ["aoDai4Ta"]),
    "Áo dài 4 tà Liên Châu",
  );
  assert.equal(
    normalizeCategoryProductDisplayName("Áo dài Kim Tuyết Mai SD5002", ["aoDai4Ta"]),
    "Áo dài 4 tà Kim Tuyết Mai",
  );
  assert.equal(
    normalizeCategoryProductDisplayName("Set Áo dài Khuynh Sắc", ["aoDai4Ta"]),
    "Áo dài 4 tà Khuynh Sắc",
  );
  assert.equal(
    normalizeCategoryProductDisplayName("Áo dài Bạch Hoa Vi", ["aoDaiTet", "aoDai4Ta"]),
    "Áo dài 4 tà Bạch Hoa Vi",
  );
  assert.equal(
    normalizeCategoryProductDisplayName("Áo dài", ["aoDai4Ta"]),
    "Áo dài 4 tà",
  );
});

test("normalizes product display name for 6-panel (aoDai6Ta) category", () => {
  assert.equal(
    normalizeCategoryProductDisplayName("Áo dài Dao Phụng", ["aoDai6Ta"]),
    "Áo dài 6 tà Dao Phụng",
  );
  assert.equal(
    normalizeCategoryProductDisplayName("Áo Dài Phượng Nghi", ["aoDai6Ta"]),
    "Áo dài 6 tà Phượng Nghi",
  );
  assert.equal(
    normalizeCategoryProductDisplayName("Áo dài 6 tà Dao Phụng", ["aoDai6Ta"]),
    "Áo dài 6 tà Dao Phụng",
  );
  assert.equal(
    normalizeCategoryProductDisplayName("Áo dài Ngọc Thanh Liên SD1711", ["aoDai6Ta"]),
    "Áo dài 6 tà Ngọc Thanh Liên",
  );
});

test("leaves products in other categories unmodified", () => {
  assert.equal(
    normalizeCategoryProductDisplayName("Váy hoa sen SV100", ["vayDam"]),
    "Váy hoa sen",
  );
  assert.equal(
    normalizeCategoryProductDisplayName("Áo dài Tết 2026", ["aoDaiTet"]),
    "Áo dài Tết 2026",
  );
  assert.equal(
    normalizeCategoryProductDisplayName("Set váy Diệu Liên Hoa SV605", ["setVay"]),
    "Set váy Diệu Liên Hoa",
  );
  assert.equal(
    normalizeCategoryProductDisplayName("Áo dài Bạch Hoa Vi", []),
    "Áo dài Bạch Hoa Vi",
  );
});

test("a product in both flap categories takes the 4-panel label, whatever the key order", () => {
  assert.equal(
    normalizeCategoryProductDisplayName("Áo dài Hai Nhóm", ["aoDai6Ta", "aoDai4Ta"]),
    "Áo dài 4 tà Hai Nhóm",
  );
  assert.equal(
    normalizeCategoryProductDisplayName("Áo dài 6 tà Hai Nhóm", ["aoDai4Ta", "aoDai6Ta"]),
    "Áo dài 4 tà Hai Nhóm",
  );
});

test("moving a product between flap categories swaps the label instead of stacking it", () => {
  assert.equal(
    normalizeCategoryProductDisplayName("Áo dài 4 tà Dao Phụng", ["aoDai6Ta"]),
    "Áo dài 6 tà Dao Phụng",
  );
  assert.equal(
    normalizeCategoryProductDisplayName("4 tà Dao Phụng", ["aoDai6Ta"]),
    "Áo dài 6 tà Dao Phụng",
  );
});

test("the garment prefix only matches whole words", () => {
  assert.equal(
    normalizeCategoryProductDisplayName("Áo dàinhẹ", ["aoDai4Ta"]),
    "Áo dài 4 tà Áo dàinhẹ",
  );
});

test("the flap label is read from the category config", () => {
  const label = categoryByKey("aoDai4Ta")?.label;
  assert.ok(label);
  assert.ok(normalizeCategoryProductDisplayName("Bạch Hoa Vi", ["aoDai4Ta"]).startsWith(`${label} `));
});

test("normalization is idempotent for every flap shape", () => {
  for (const [name, keys] of [
    ["Áo dài Kim Tuyết Mai SD5002", ["aoDai4Ta"]],
    ["Set Áo dài Khuynh Sắc", ["aoDai6Ta"]],
    ["Áo dài", ["aoDai4Ta"]],
    ["Váy hoa sen SV100", ["vayDam"]],
  ] as const) {
    const once = normalizeCategoryProductDisplayName(name, keys);
    assert.equal(normalizeCategoryProductDisplayName(once, keys), once);
  }
});
