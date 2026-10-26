import assert from "node:assert/strict";
import test from "node:test";

import { voucherAttemptKey } from "../../src/commerce/voucher-hold-service.ts";

const SECRET = "voucher-attempt-test-secret-0123456789ab";

test("the attempt key is a stable 64-hex HMAC of the cart id and never contains it", () => {
  const key = voucherAttemptKey("cart-123", SECRET);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(key, voucherAttemptKey("cart-123", SECRET));
  assert.equal(key.includes("cart-123"), false);
  assert.notEqual(key, voucherAttemptKey("cart-124", SECRET));
  assert.notEqual(key, voucherAttemptKey("cart-123", `${SECRET}x`));
});

test("a weak secret or an unusable cart id fails closed", () => {
  assert.throws(() => voucherAttemptKey("cart-123", "short"), TypeError);
  assert.throws(() => voucherAttemptKey("", SECRET), TypeError);
  assert.throws(() => voucherAttemptKey("x".repeat(65), SECRET), TypeError);
});

test("the voucher attempt key is domain-separated from the gift-reminder attempt key", async () => {
  const { checkoutAttemptKey } = await import("../../src/commerce/checkout-attempt-key.ts");
  assert.notEqual(voucherAttemptKey("cart-123", SECRET), checkoutAttemptKey("cart-123", SECRET));
});
