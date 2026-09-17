/**
 * I2 — what the selling-policy boundary is allowed to store (ADR 0014 §5).
 *
 * The mode allowlist is the part most worth pinning. `resolveSellingPolicy()` answers an
 * unrecognized *stored* mode with `STANDARD`, and repeating that leniency on write would turn a
 * typo into a silent demotion that the operator is told was saved. These assert the write path does
 * the opposite of the read path, on purpose.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_NEGATIVE_STOCK_LIMIT } from "../../src/commerce/capacity-policy.ts";
import {
  parseSellingPolicySubmission,
  SellingPolicyError,
  SELLING_POLICY_MODE_INPUTS,
} from "../../src/commerce/capacity-policy-input.ts";

const PRODUCT_ID = "clx0000product0001";

function refusalFor(input: unknown): string {
  try {
    parseSellingPolicySubmission(input);
  } catch (error) {
    assert.ok(error instanceof SellingPolicyError, "must refuse with a typed reason");
    return error.reason;
  }
  return assert.fail("the submission was accepted");
}

test("I2 each of the three modes maps to its stored enum and nothing else does", () => {
  assert.deepEqual([...SELLING_POLICY_MODE_INPUTS], ["standard", "oversell", "preorder"]);

  for (const [input, stored] of [
    ["standard", "STANDARD"],
    ["oversell", "OVERSELL"],
    ["preorder", "PREORDER"],
  ] as const) {
    const parsed = parseSellingPolicySubmission({ productId: PRODUCT_ID, sellingMode: input });
    assert.equal(parsed.sellingMode, stored);
  }

  // Refused rather than coerced. `STANDARD` is the safe answer on read and the WRONG answer on
  // write: an operator who typed "Oversell" would be told their change was saved while the product
  // stayed standard.
  for (const rejected of [
    "STANDARD",
    "Oversell",
    " preorder",
    "preorder ",
    "",
    "backorder",
    null,
    undefined,
    1,
    ["oversell"],
  ]) {
    assert.equal(
      refusalFor({ productId: PRODUCT_ID, sellingMode: rejected }),
      "selling-policy-unknown-mode",
      `${JSON.stringify(rejected)} must not resolve to a mode`,
    );
  }

  // A prototype key is truthy on a plain object lookup, so the allowlist is checked rather than the
  // map alone. Without that check, `constructor` would have parsed as a mode.
  for (const inherited of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.equal(
      refusalFor({ productId: PRODUCT_ID, sellingMode: inherited }),
      "selling-policy-unknown-mode",
    );
  }
});

test("I2 the limit defaults to the approved value and refuses anything unstorable", () => {
  // Absent and null both mean "use the approved default", so a form that hides the field for
  // `standard`, or empties it, still submits something storable.
  for (const absent of [undefined, null]) {
    const parsed = parseSellingPolicySubmission({
      productId: PRODUCT_ID,
      sellingMode: "oversell",
      negativeStockLimit: absent,
    });
    assert.equal(parsed.negativeStockLimit, DEFAULT_NEGATIVE_STOCK_LIMIT);
  }

  // 0 is legitimate: "oversell enabled, no negative allowance", which `evaluateVariantCapacity`
  // accepts. There is no lower bound, because the master spec fixes none — comment 5714858155.
  // `-250` is here so a floor cannot quietly come back: an earlier version of this parser invented
  // `-200` and would have refused a limit the approved contract allows.
  for (const accepted of [0, -1, -20, -200, -201, -250, -1_000_000]) {
    const parsed = parseSellingPolicySubmission({
      productId: PRODUCT_ID,
      sellingMode: "oversell",
      negativeStockLimit: accepted,
    });
    assert.equal(parsed.negativeStockLimit, accepted);
  }

  // Only two families are refused: a positive limit, which the gate refuses as `invalid-limit`
  // anyway, and a value that is not a safe integer, which is not a limit at all.
  for (const rejected of [
    1,
    5,
    -0.5,
    Number.NaN,
    Number.NEGATIVE_INFINITY,
    "-20",
    {},
  ]) {
    assert.equal(
      refusalFor({ productId: PRODUCT_ID, sellingMode: "oversell", negativeStockLimit: rejected }),
      "selling-policy-invalid-limit",
      `${JSON.stringify(rejected)} must not be storable`,
    );
  }
});

test("I2 the limit survives a switch to standard rather than being discarded", () => {
  // §5 floors STANDARD at 0 whatever the limit says, so the stored value is inert there. Keeping it
  // is still the right call: discarding it would lose an allowance the operator had already set the
  // moment they toggled to standard and back, with nothing to tell them it was gone.
  const parsed = parseSellingPolicySubmission({
    productId: PRODUCT_ID,
    sellingMode: "standard",
    negativeStockLimit: -8,
  });
  assert.equal(parsed.sellingMode, "STANDARD");
  assert.equal(parsed.negativeStockLimit, -8);
});

test("I2 a submission that is not a product-shaped object is refused before anything else", () => {
  for (const shapeless of [null, undefined, "productId=x", 7, true]) {
    assert.equal(refusalFor(shapeless), "selling-policy-shape");
  }

  for (const badId of ["", "   ", "x".repeat(65), 42, null, undefined, {}]) {
    assert.equal(
      refusalFor({ productId: badId, sellingMode: "oversell" }),
      "selling-policy-invalid-product",
      `${JSON.stringify(badId)} is not a product id`,
    );
  }

  // Trimmed, not rejected — a form field that picked up whitespace still names a real product.
  assert.equal(
    parseSellingPolicySubmission({ productId: `  ${PRODUCT_ID}  `, sellingMode: "standard" })
      .productId,
    PRODUCT_ID,
  );
});
