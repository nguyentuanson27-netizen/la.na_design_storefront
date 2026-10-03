import assert from "node:assert/strict";
import test from "node:test";

import {
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
