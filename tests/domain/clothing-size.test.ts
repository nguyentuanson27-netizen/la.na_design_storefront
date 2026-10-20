import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalizeClothingSize,
  compareClothingSizes,
  sortClothingSizes,
} from "../../src/commerce/clothing-size.ts";

test("sortClothingSizes sorts standard apparel letter sizes in natural order", () => {
  const input = ["L", "M", "XL", "S", "XXL"];
  assert.deepEqual(sortClothingSizes(input), ["S", "M", "L", "XL", "XXL"]);

  const extended = ["3XL", "XS", "XXL", "M", "2XS", "L", "S", "XL", "Freesize"];
  assert.deepEqual(sortClothingSizes(extended), [
    "2XS",
    "XS",
    "S",
    "M",
    "L",
    "XL",
    "XXL",
    "3XL",
    "Freesize",
  ]);
});

test("sortClothingSizes deduplicates case-insensitive size duplicates and normalizes letter sizes", () => {
  const duplicateInput = ["S", "M", "L", "XL", "Xl"];
  assert.deepEqual(sortClothingSizes(duplicateInput), ["S", "M", "L", "XL"]);

  const lowercaseInput = ["xl", "s", "m", "l"];
  assert.deepEqual(sortClothingSizes(lowercaseInput), ["S", "M", "L", "XL"]);
});

test("canonicalizeClothingSize canonicalizes standard letter sizes to uppercase", () => {
  assert.equal(canonicalizeClothingSize("xl"), "XL");
  assert.equal(canonicalizeClothingSize("Xl"), "XL");
  assert.equal(canonicalizeClothingSize("s"), "S");
  assert.equal(canonicalizeClothingSize("2xl"), "2XL");
  assert.equal(canonicalizeClothingSize("Freesize"), "Freesize");
  assert.equal(canonicalizeClothingSize("32"), "32");
});

test("sortClothingSizes sorts numeric clothing sizes in ascending order", () => {
  const numeric = ["32", "28", "30", "29", "31"];
  assert.deepEqual(sortClothingSizes(numeric), ["28", "29", "30", "31", "32"]);
});

test("sortClothingSizes places standard letter sizes before numeric and unknown sizes", () => {
  const mixed = ["Custom", "30", "M", "28", "S"];
  assert.deepEqual(sortClothingSizes(mixed), ["S", "M", "28", "30", "Custom"]);
});

test("compareClothingSizes returns correct relative order", () => {
  assert.ok(compareClothingSizes("S", "M") < 0);
  assert.ok(compareClothingSizes("XL", "L") > 0);
  assert.equal(compareClothingSizes("M", "M"), 0);
});
