import assert from "node:assert/strict";
import test from "node:test";

import type {
  CartMutationAnalytics,
  StorefrontCartRemoveResult,
  StorefrontCartUpdateResult,
} from "../../src/commerce/storefront-cart-public-actions.ts";
import {
  CART_LINE_MAX_QUANTITY,
  resolveCartLineQuantity,
  resolveCartLineRemoveOutcome,
  resolveCartLineUpdateOutcome,
  resolveCartLineThrownOutcome,
} from "../../src/components/headless/cart-line-model.ts";

/**
 * Characterization tests for the cart line editor's decisions, captured before they moved out of
 * `CartLineControls`.
 *
 * The hook that wires these up cannot be unit-tested here: it reaches the cart server actions,
 * which import `next/headers`, and it drives the router. So the decisions live in a pure module,
 * and that module is what these tests hold to the baseline -- which typed quantities the editor
 * will submit, what a shopper is told when a mutation is refused, and when the route is refreshed.
 */

const analytics: CartMutationAnalytics = {
  event: "add_to_cart",
  item: {} as CartMutationAnalytics["item"],
};

/* --------------------------------------------------------------- typed quantity */

test("a plain positive integer is submittable", () => {
  assert.deepEqual(resolveCartLineQuantity("3"), { value: 3, isValid: true });
});

test("zero and negatives are refused: removal is its own button", () => {
  assert.equal(resolveCartLineQuantity("0").isValid, false);
  assert.equal(resolveCartLineQuantity("-1").isValid, false);
});

test("a quantity past what the column can hold is refused before any request", () => {
  assert.equal(resolveCartLineQuantity(String(CART_LINE_MAX_QUANTITY)).isValid, true);
  assert.equal(resolveCartLineQuantity(String(CART_LINE_MAX_QUANTITY + 1)).isValid, false);
});

test("fractions, blanks and non-numbers are refused", () => {
  for (const raw of ["", " ", "1.5", "abc", "1e3000", "NaN"]) {
    assert.equal(resolveCartLineQuantity(raw).isValid, false, `${raw || "(blank)"} must be refused`);
  }
});

/* ------------------------------------------------------------- update outcomes */

test("a committed update says so, refreshes the route and carries the server's event", () => {
  const result: StorefrontCartUpdateResult = { ok: true, analytics };

  assert.deepEqual(resolveCartLineUpdateOutcome(result), {
    message: "Đã cập nhật số lượng.",
    refreshes: true,
    analytics,
  });
});

test("a committed update with no safe event still commits and still refreshes", () => {
  // An unchanged quantity or a snapshot that could not be built emits nothing rather than
  // something approximate. The cart is still correct, so the shopper is still told.
  const outcome = resolveCartLineUpdateOutcome({ ok: true, analyticsUnavailable: true });

  assert.equal(outcome.message, "Đã cập nhật số lượng.");
  assert.equal(outcome.refreshes, true);
  assert.equal(outcome.analytics, undefined);
});

test("an unavailable line gets the precise message, other refusals the generic one", () => {
  assert.equal(
    resolveCartLineUpdateOutcome({ ok: false, reason: "LINE_UNAVAILABLE" }).message,
    "Số lượng này hiện không khả dụng. Hãy thử số lượng thấp hơn.",
  );

  for (const reason of ["INVALID_INPUT", "UPDATE_FAILED"] as const) {
    assert.equal(
      resolveCartLineUpdateOutcome({ ok: false, reason }).message,
      "Không thể cập nhật số lượng lúc này.",
    );
  }
});

test("a refused update still refreshes, because the cart may have moved underneath", () => {
  assert.equal(resolveCartLineUpdateOutcome({ ok: false, reason: "LINE_UNAVAILABLE" }).refreshes, true);
  assert.equal(resolveCartLineUpdateOutcome({ ok: false, reason: "UPDATE_FAILED" }).analytics, undefined);
});

/* ------------------------------------------------------------- remove outcomes */

test("a committed removal says nothing: the row it described is gone after the refresh", () => {
  const result: StorefrontCartRemoveResult = { ok: true, removedQuantity: 2, analytics };

  assert.deepEqual(resolveCartLineRemoveOutcome(result), {
    message: "",
    refreshes: true,
    analytics,
  });
});

test("every refused removal gets one message, and still refreshes", () => {
  for (const reason of ["INVALID_INPUT", "LINE_UNAVAILABLE", "REMOVE_FAILED"] as const) {
    assert.deepEqual(resolveCartLineRemoveOutcome({ ok: false, reason }), {
      message: "Không thể xóa sản phẩm lúc này.",
      refreshes: true,
      analytics: undefined,
    });
  }
});

/* --------------------------------------------------------------- thrown request */

test("a request that never settled does not refresh", () => {
  // Characterized, not designed: the baseline refreshes on every answer the server gave, including
  // a refusal, but not when the call threw. There is no committed state to re-read, and refreshing
  // on a dead network would replace the shopper's typed quantity with the old one.
  assert.deepEqual(resolveCartLineThrownOutcome("update"), {
    message: "Không thể cập nhật số lượng lúc này.",
    refreshes: false,
    analytics: undefined,
  });

  assert.deepEqual(resolveCartLineThrownOutcome("remove"), {
    message: "Không thể xóa sản phẩm lúc này.",
    refreshes: false,
    analytics: undefined,
  });
});
