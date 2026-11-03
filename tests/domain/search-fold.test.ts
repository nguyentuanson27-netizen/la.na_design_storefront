import assert from "node:assert/strict";
import test from "node:test";

import {
  FOLD_FROM,
  FOLD_TO,
  MAX_SEARCH_TERMS,
  escapeLikeTerm,
  foldVietnamese,
  searchTerms,
} from "../../src/commerce/search-fold.ts";

test("search fold removes Vietnamese marks and maps đ to d", () => {
  assert.equal(foldVietnamese("Áo dài"), "ao dai");
  assert.equal(foldVietnamese("Đầm Hoa Sen"), "dam hoa sen");
  assert.equal(foldVietnamese("Set Váy Tơ Gương Thêu"), "set vay to guong theu");
  assert.equal(foldVietnamese("chân váy"), "chan vay");
});

test("search fold treats composed and decomposed input the same", () => {
  const composed = "Áo dài cách tân".normalize("NFC");
  const decomposed = "Áo dài cách tân".normalize("NFD");
  assert.notEqual(composed, decomposed);
  assert.equal(foldVietnamese(decomposed), foldVietnamese(composed));
});

test("the SQL translate tables are the same length and cover every mark the JS fold removes", () => {
  assert.equal([...FOLD_FROM].length, [...FOLD_TO].length);
  for (const [index, char] of [...FOLD_FROM].entries()) {
    assert.equal(foldVietnamese(char), [...FOLD_TO][index], `fold of ${char}`);
  }
});

test("search terms are folded, de-duplicated and bounded", () => {
  assert.deepEqual(searchTerms("  Váy   hoa  sen "), ["vay", "hoa", "sen"]);
  assert.deepEqual(searchTerms("váy vay VÁY"), ["vay"]);
  assert.deepEqual(searchTerms("   "), []);
  assert.equal(searchTerms("a b c d e f g h i j").length, MAX_SEARCH_TERMS);
});

test("LIKE metacharacters in a term are matched literally", () => {
  assert.equal(escapeLikeTerm("50%_off\\"), "50\\%\\_off\\\\");
});
