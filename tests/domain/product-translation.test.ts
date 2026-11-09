import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_PRODUCT_TRANSLATION,
  PRODUCT_TRANSLATION_LIMITS,
  isEmptyProductTranslation,
  overlayProductName,
  overlayProductTranslation,
  parseProductTranslationInput,
  type ProductTranslation,
} from "../../src/commerce/product-translation.ts";

const source = {
  id: "p1",
  name: "Áo dài cách tân Diệp Họa Thư",
  editorialDescription: "Phom 4 tà thướt tha.",
  material: "Lụa tơ tằm",
  craftDetails: ["May giấu chỉ thủ công"],
  careInstructions: "Giặt tay nước lạnh.",
  seoTitle: "Áo dài cách tân",
  seoDescription: "Mô tả SEO",
};

const full: ProductTranslation = {
  name: "Diệp Họa Thư modern ao dai",
  editorialDescription: "A graceful 4-panel cut.",
  material: "Mulberry silk",
  craftDetails: ["Hand-finished hidden stitching", "  ", "Fabric-covered buttons"],
  careInstructions: "Hand wash cold.",
  seoTitle: "Modern ao dai",
  seoDescription: "SEO description",
};

test("a full translation replaces every field and drops blank craft lines", () => {
  const out = overlayProductTranslation(source, full);
  assert.equal(out.name, "Diệp Họa Thư modern ao dai");
  assert.equal(out.editorialDescription, "A graceful 4-panel cut.");
  assert.equal(out.material, "Mulberry silk");
  assert.deepEqual(out.craftDetails, ["Hand-finished hidden stitching", "Fabric-covered buttons"]);
  assert.equal(out.careInstructions, "Hand wash cold.");
  assert.equal(out.seoTitle, "Modern ao dai");
  assert.equal(out.id, "p1", "fields the translation does not own are untouched");
});

test("a field left empty falls back to the Vietnamese, so a half translation is still whole", () => {
  const out = overlayProductTranslation(source, { ...EMPTY_PRODUCT_TRANSLATION, name: "Modern ao dai", material: "   " });
  assert.equal(out.name, "Modern ao dai");
  assert.equal(out.material, "Lụa tơ tằm");
  assert.equal(out.editorialDescription, source.editorialDescription);
  assert.deepEqual(out.craftDetails, source.craftDetails);
});

test("no translation, or an empty one, returns the product as it was", () => {
  assert.equal(overlayProductTranslation(source, undefined), source);
  assert.deepEqual(overlayProductTranslation(source, EMPTY_PRODUCT_TRANSLATION), source);
  assert.equal(overlayProductName(source, undefined), source);
  assert.equal(overlayProductName(source, { name: null }), source);
});

test("the name-only overlay changes nothing but the name", () => {
  const out = overlayProductName(source, { name: "Modern ao dai" });
  assert.equal(out.name, "Modern ao dai");
  assert.equal(out.material, source.material);
  assert.notEqual(out, source, "a new object: the cached source is never written to");
  assert.equal(source.name, "Áo dài cách tân Diệp Họa Thư");
});

test("a field the product does not carry is not invented", () => {
  const out = overlayProductTranslation({ name: "Set váy" }, full);
  assert.equal(out.name, "Diệp Họa Thư modern ao dai");
  assert.equal("material" in out, false);
  assert.equal("craftDetails" in out, false);
});

test("the admin input is trimmed, empty text becomes no overlay, craft details are one per line", () => {
  const result = parseProductTranslationInput({
    name: "  Modern ao dai  ",
    editorialDescription: "",
    material: null,
    craftDetails: "Hand stitched\r\n\r\n  Covered buttons  \n",
    careInstructions: "   ",
    seoTitle: undefined,
    seoDescription: "Desc",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.name, "Modern ao dai");
  assert.equal(result.value.editorialDescription, null);
  assert.equal(result.value.material, null);
  assert.deepEqual(result.value.craftDetails, ["Hand stitched", "Covered buttons"]);
  assert.equal(result.value.careInstructions, null);
  assert.equal(result.value.seoTitle, null);
  assert.equal(result.value.seoDescription, "Desc");
});

test("input over a limit is refused with the field named, never cut", () => {
  const base = { name: "", editorialDescription: "", material: "", craftDetails: "", careInstructions: "", seoTitle: "", seoDescription: "" };
  const long = (n: number) => "x".repeat(n + 1);
  assert.deepEqual(parseProductTranslationInput({ ...base, name: long(PRODUCT_TRANSLATION_LIMITS.name) }), { ok: false, field: "name" });
  assert.deepEqual(parseProductTranslationInput({ ...base, seoTitle: long(PRODUCT_TRANSLATION_LIMITS.seoTitle) }), { ok: false, field: "seoTitle" });
  assert.deepEqual(parseProductTranslationInput({ ...base, seoDescription: long(PRODUCT_TRANSLATION_LIMITS.seoDescription) }), { ok: false, field: "seoDescription" });
  assert.deepEqual(parseProductTranslationInput({ ...base, craftDetails: Array.from({ length: PRODUCT_TRANSLATION_LIMITS.craftDetailCount + 1 }, () => "a").join("\n") }), { ok: false, field: "craftDetails" });
  assert.deepEqual(parseProductTranslationInput({ ...base, craftDetails: long(PRODUCT_TRANSLATION_LIMITS.craftDetail) }), { ok: false, field: "craftDetails" });
  assert.deepEqual(parseProductTranslationInput({ ...base, material: 42 }), { ok: false, field: "material" });
});

test("a translation with nothing in it is empty, so saving it removes the row", () => {
  assert.equal(isEmptyProductTranslation(EMPTY_PRODUCT_TRANSLATION), true);
  assert.equal(isEmptyProductTranslation({ ...EMPTY_PRODUCT_TRANSLATION, name: "x" }), false);
  assert.equal(isEmptyProductTranslation({ ...EMPTY_PRODUCT_TRANSLATION, craftDetails: ["a"] }), false);
});
