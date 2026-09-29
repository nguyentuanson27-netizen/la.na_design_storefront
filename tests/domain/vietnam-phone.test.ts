import assert from "node:assert/strict";
import test from "node:test";

import {
  isVietnamPhone,
  normalizeVietnamPhone,
  VIETNAM_PHONE_ERROR,
} from "../../src/commerce/vietnam-phone.ts";

test("Vietnamese mobile numbers are accepted in the ways people type them", () => {
  for (const [typed, expected] of [
    ["0912345678", "0912345678"],
    ["0912 345 678", "0912345678"],
    ["091.234.5678", "0912345678"],
    ["091-234-5678", "0912345678"],
    ["(091) 234 5678", "0912345678"],
    ["+84912345678", "0912345678"],
    ["+84 912 345 678", "0912345678"],
    ["84912345678", "0912345678"],
    ["0386123456", "0386123456"],
    ["0523456789", "0523456789"],
    ["0701234567", "0701234567"],
    ["0812345678", "0812345678"],
  ] as const) {
    assert.equal(normalizeVietnamPhone(typed), expected, typed);
  }
});

test("Vietnamese landlines (02x, 11 digits) are accepted", () => {
  assert.equal(normalizeVietnamPhone("024 3825 1234"), "02438251234");
  assert.equal(normalizeVietnamPhone("+84 24 3825 1234"), "02438251234");
});

test("anything else is not a Vietnamese phone number", () => {
  for (const typed of [
    "",
    "   ",
    "12345",
    "091234567",
    "09123456789",
    "0112345678",
    "0212345678",
    "0412345678",
    "0612345678",
    "912345678",
    "+1 202 555 0100",
    "0912abc678",
    "0912 345 67a",
  ]) {
    assert.equal(normalizeVietnamPhone(typed), null, typed);
    assert.equal(isVietnamPhone(typed), false, typed);
  }
  assert.equal(normalizeVietnamPhone(912345678), null);
  assert.equal(normalizeVietnamPhone(null), null);
});

test("the warning tells the buyer what a valid number looks like", () => {
  assert.match(VIETNAM_PHONE_ERROR, /10 chữ số/);
});
