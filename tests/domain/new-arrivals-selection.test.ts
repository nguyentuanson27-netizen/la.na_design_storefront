import assert from "node:assert/strict";
import test from "node:test";

import { MerchandisingError } from "../../src/commerce/merchandising-input.ts";
import {
  MAX_NEW_ARRIVAL_PRODUCTS,
  applyNewArrivalChange,
} from "../../src/commerce/new-arrivals-selection.ts";

function rejectReason(fn: () => unknown) {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof MerchandisingError);
    return true;
  });
  try { fn(); } catch (error) { return (error as MerchandisingError).reason; }
  throw new Error("Expected rejection");
}

test("manual new arrivals are selected and ordered explicitly, never by a product timestamp", () => {
  assert.deepEqual(applyNewArrivalChange([], "add", "old-product"), ["old-product"]);
  assert.deepEqual(applyNewArrivalChange(["old-product"], "add", "new-product"), [
    "old-product",
    "new-product",
  ]);
  assert.deepEqual(applyNewArrivalChange(["old-product", "new-product"], "move-up", "new-product"), [
    "new-product",
    "old-product",
  ]);
  assert.deepEqual(applyNewArrivalChange(["new-product", "old-product"], "remove", "new-product"), [
    "old-product",
  ]);
  assert.deepEqual(applyNewArrivalChange(["old-product"], "remove", "old-product"), []);
});

test("adding an existing item is idempotent and edge moves preserve order", () => {
  assert.deepEqual(applyNewArrivalChange(["a", "b"], "add", "a"), ["a", "b"]);
  assert.deepEqual(applyNewArrivalChange(["a", "b"], "move-up", "a"), ["a", "b"]);
  assert.deepEqual(applyNewArrivalChange(["a", "b"], "move-down", "b"), ["a", "b"]);
  assert.deepEqual(applyNewArrivalChange(["a", "b"], "move-down", "a"), ["b", "a"]);
});

test("invalid, stale and oversized submissions cannot modify the manual list", () => {
  assert.equal(rejectReason(() => applyNewArrivalChange([], "nope", "a")), "merchandising-shape");
  assert.equal(rejectReason(() => applyNewArrivalChange([], "add", "")), "merchandising-invalid-product");
  assert.equal(rejectReason(() => applyNewArrivalChange(["a"], "remove", "b")), "merchandising-invalid-product");
  assert.equal(rejectReason(() => applyNewArrivalChange(["a"], "move-up", "b")), "merchandising-invalid-product");
  const full = Array.from({ length: MAX_NEW_ARRIVAL_PRODUCTS }, (_, i) => "product-" + i);
  assert.equal(rejectReason(() => applyNewArrivalChange(full, "add", "overflow")), "merchandising-too-many");
});
