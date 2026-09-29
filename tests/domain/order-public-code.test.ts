import assert from "node:assert/strict";
import test from "node:test";

import {
  generateOrderPublicCode,
  isShortOrderPublicCode,
  normalizeOrderPublicCodeInput,
  normalizePhoneForMatch,
} from "../../src/commerce/order-public-code.ts";
import { parseGuestOrderTrackingInput } from "../../src/commerce/guest-order-tracking.ts";
import { parsePrefilledOrderCode } from "../../src/routes/track-order-model.ts";

test("new order codes are LA- plus eight unambiguous characters", () => {
  const seen = new Set<string>();
  for (let index = 0; index < 2_000; index += 1) {
    const code = generateOrderPublicCode();
    assert.match(code, /^LA-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/);
    assert.equal(code.length, 11);
    assert.ok(isShortOrderPublicCode(code));
    seen.add(code);
  }
  assert.equal(seen.size, 2_000, "codes are random, not sequential or repeated");
});

test("a typed order code is forgiving about case, spacing, dashes and the LA prefix", () => {
  for (const typed of [
    "LA-7K3M9QXD",
    "la-7k3m9qxd",
    "  LA-7K3M9QXD  ",
    "LA7K3M9QXD",
    "7K3M9QXD",
    "7k3m-9qxd",
    "la 7k3m 9qxd",
  ]) {
    assert.equal(normalizeOrderPublicCodeInput(typed), "LA-7K3M9QXD", typed);
  }
});

test("codes issued before the short format are left exactly as typed, apart from trimming", () => {
  const legacy = "LA-3f2b8c1e-5a4d-4e6f-9a0b-1c2d3e4f5a6b";
  assert.equal(normalizeOrderPublicCodeInput(`  ${legacy} `), legacy);
  assert.equal(normalizeOrderPublicCodeInput("LA-123"), "LA-123");
  // Look-alike characters are not in the alphabet, so they are not silently rewritten.
  assert.equal(normalizeOrderPublicCodeInput("LA-0O1IL234"), "LA-0O1IL234");
});

test("guest lookup input normalises the order code it will rate limit and query by", () => {
  assert.deepEqual(parseGuestOrderTrackingInput({ orderCode: "7k3m 9qxd", phone: "0901 234 567" }), {
    ok: true,
    value: { orderCode: "LA-7K3M9QXD", phone: "0901 234 567" },
  });
  assert.deepEqual(parseGuestOrderTrackingInput({ orderCode: "7K3M9QXD", phone: "---" }), {
    ok: false,
    reason: "NOT_FOUND",
  });
});

test("phones are matched on their national digits", () => {
  const stored = normalizePhoneForMatch("0901234567");
  for (const typed of ["0901234567", "0901 234 567", "090.123.4567", "+84 901 234 567", "84901234567"]) {
    assert.equal(normalizePhoneForMatch(typed), stored, typed);
  }
  assert.notEqual(normalizePhoneForMatch("0901234568"), stored);
});

test("the lookup page prefills only a recognisable short code", () => {
  assert.equal(parsePrefilledOrderCode("LA-7K3M9QXD"), "LA-7K3M9QXD");
  assert.equal(parsePrefilledOrderCode("la-7k3m9qxd"), "LA-7K3M9QXD");
  assert.equal(parsePrefilledOrderCode(undefined), null);
  assert.equal(parsePrefilledOrderCode(["LA-7K3M9QXD", "LA-7K3M9QXE"]), null);
  assert.equal(parsePrefilledOrderCode("<script>"), null);
  assert.equal(parsePrefilledOrderCode("LA-3f2b8c1e-5a4d-4e6f-9a0b-1c2d3e4f5a6b"), null);
});
