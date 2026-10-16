import assert from "node:assert/strict";
import test from "node:test";
import { parseReminderAttempt, reminderSubmitDecision } from "../../src/components/headless/checkout-gift-reminder-model.ts";
import { checkoutAttemptKey } from "../../src/commerce/checkout-attempt-key.ts";

test("reminder decisions never turn open, invalid, or busy into submit", () => {
  assert.equal(reminderSubmitDecision({ state: "unseen", needsReminder: true, valid: true, busy: false }), "remind");
  assert.equal(reminderSubmitDecision({ state: "open", needsReminder: true, valid: true, busy: false }), "block");
  assert.equal(reminderSubmitDecision({ state: "seen", needsReminder: true, valid: true, busy: false }), "submit");
  assert.equal(reminderSubmitDecision({ state: "seen", needsReminder: true, valid: true, busy: true }), "block");
  assert.equal(reminderSubmitDecision({ state: "unseen", needsReminder: true, valid: false, busy: false }), "block");
  assert.equal(reminderSubmitDecision({ state: "unseen", needsReminder: false, valid: true, busy: false }), "submit");
});
test("tab metadata is bounded, key-bound and does not restore consent or form fields", () => {
  const key = checkoutAttemptKey("cart-a", "secret");
  assert.equal(key.length, 64);
  assert.notEqual(key, checkoutAttemptKey("cart-b", "secret"));
  assert.notEqual(key, checkoutAttemptKey("cart-a", "other-secret"));
  assert.equal(parseReminderAttempt(JSON.stringify({ version: 1, key, seen: true }), key), true);
  for (const raw of ["{", "null", JSON.stringify({version: 1, key: "other", seen: true}), JSON.stringify({version: 2, key, seen: true}), JSON.stringify({version: 1, key, seen: "yes"}), JSON.stringify({version: 1, key, seen: true, proof: "forged"})]) assert.equal(parseReminderAttempt(raw, key), false);
});
