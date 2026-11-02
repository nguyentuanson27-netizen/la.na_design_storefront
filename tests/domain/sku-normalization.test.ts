import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSku, SKU_TRIM_CHARACTERS } from "../../src/integrations/pancake/sku.ts";

test("the characters trimmed are exactly the ones String.prototype.trim() trims, over the whole BMP", () => {
  for (let code = 0; code <= 0xffff; code += 1) {
    const char = String.fromCharCode(code);
    assert.equal(
      SKU_TRIM_CHARACTERS.includes(char),
      char.trim() === "",
      `U+${code.toString(16).padStart(4, "0")}`,
    );
  }
});

test("normalizeSku trims every whitespace the old implementation trimmed and upper-cases ASCII", () => {
  assert.equal(normalizeSku("  svd468-ao-xl  "), "SVD468-AO-XL");
  assert.equal(normalizeSku("\tSKU-A"), "SKU-A");
  assert.equal(normalizeSku("\u00a0SKU-A\u00a0"), "SKU-A");
  assert.equal(normalizeSku("\ufeffsku-a\u3000"), "SKU-A");
  assert.equal(normalizeSku("\n\u2028SKU-A\u2029\r"), "SKU-A");
  assert.equal(normalizeSku("   "), null);
  assert.equal(normalizeSku("\t\u00a0"), null);
  assert.equal(normalizeSku(""), null);
  assert.equal(normalizeSku(null), null);
  assert.equal(normalizeSku(undefined), null);
});

test("only ASCII letters are case-folded and inner characters are significant", () => {
  assert.equal(normalizeSku("stra\u00dfe-1"), "STRA\u00dfE-1", "non-ASCII is left alone, not folded to SS");
  assert.equal(normalizeSku("\u00e1o-1"), "\u00e1O-1");
  assert.equal(normalizeSku("AO XL"), "AO XL");
  assert.notEqual(normalizeSku("AO-XL"), normalizeSku("AO XL"));
  assert.equal(normalizeSku("\u200bSKU-A"), "\u200bSKU-A", "zero-width space is not whitespace to trim()");
});
