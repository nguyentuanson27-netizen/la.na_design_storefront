import assert from "node:assert/strict";
import test from "node:test";

import { stripTrailingProductCode } from "../../src/commerce/product-display-name.ts";

test("product display name drops the trailing Pancake product code", () => {
  assert.equal(stripTrailingProductCode("Set váy Diệu Liên Hoa SV605"), "Set váy Diệu Liên Hoa");
  assert.equal(stripTrailingProductCode("Áo A132"), "Áo");
  assert.equal(stripTrailingProductCode("SET VAY SV555"), "SET VAY");
  assert.equal(stripTrailingProductCode("Đầm xoè sv605"), "Đầm xoè");
  assert.equal(stripTrailingProductCode("Váy hoa SV605-2"), "Váy hoa");
  assert.equal(stripTrailingProductCode("  Váy hoa   SV605  "), "Váy hoa");
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

test("product display name never empties a name that is only a code", () => {
  assert.equal(stripTrailingProductCode("SV605"), "SV605");
  assert.equal(stripTrailingProductCode("(SV605)"), "(SV605)");
});
