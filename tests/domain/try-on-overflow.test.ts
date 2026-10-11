import assert from "node:assert/strict";
import test from "node:test";

import {
  OVERFLOW_MAX_CONCURRENT,
  PRIMARY_DOWN_AFTER_AUTH_FAILURE_MS,
  PRIMARY_DOWN_AFTER_FAILURES_MS,
  PRIMARY_DOWN_AFTER_PROVIDER_BUSY_MS,
  PRIMARY_FAILURES_BEFORE_DOWN,
  createTryOnOverflowGate,
} from "../../src/commerce/try-on-overflow.ts";

/** 2026-10-11 09:00 in Vietnam (UTC+7). */
const MORNING = Date.UTC(2026, 9, 11, 2, 0, 0);
const HOUR = 3_600_000;

function clock(start = MORNING) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms), set: (ms: number) => (t = ms) };
}

test("the daily cap counts every overflow slot taken and refuses past it, whatever the outcome", () => {
  const time = clock();
  const gate = createTryOnOverflowGate({ dailyCap: 2, maxConcurrent: 5, now: time.now });
  const first = gate.startOverflow();
  const second = gate.startOverflow();
  assert.equal(first.ok && second.ok, true);
  if (first.ok) first.release();
  if (second.ok) second.release();
  assert.deepEqual(gate.startOverflow(), { ok: false, reason: "BUSY", cause: "daily_cap" });
});

test("the day turns over at midnight Vietnam time, not UTC", () => {
  const time = clock(Date.UTC(2026, 9, 11, 16, 59, 0)); // 23:59 in Vietnam
  const gate = createTryOnOverflowGate({ dailyCap: 1, now: time.now });
  const slot = gate.startOverflow();
  if (slot.ok) slot.release();
  assert.equal(gate.startOverflow().ok, false);
  time.set(Date.UTC(2026, 9, 11, 17, 0, 0)); // 00:00 the next day in Vietnam
  assert.equal(gate.startOverflow().ok, true);
});

test("overflow slots are bounded in flight and freed exactly once", () => {
  const gate = createTryOnOverflowGate({ dailyCap: 100, now: clock().now });
  const slots = Array.from({ length: OVERFLOW_MAX_CONCURRENT }, () => gate.startOverflow());
  assert.ok(slots.every((slot) => slot.ok));
  assert.deepEqual(gate.startOverflow(), { ok: false, reason: "BUSY", cause: "concurrency" });
  const first = slots[0]!;
  if (first.ok) {
    first.release();
    first.release(); // a double release must not open a second slot
  }
  assert.equal(gate.startOverflow().ok, true);
  assert.deepEqual(gate.startOverflow(), { ok: false, reason: "BUSY", cause: "concurrency" });
});

test("an auth failure marks Flow down for 30 minutes, then it is tried again", () => {
  const time = clock();
  const gate = createTryOnOverflowGate({ dailyCap: 10, now: time.now });
  assert.equal(gate.primaryDown(), false);
  assert.deepEqual(gate.notePrimaryOutcome({ ok: false, reason: "AUTH_FAILED" }), {
    cause: "auth_failed",
    forMs: PRIMARY_DOWN_AFTER_AUTH_FAILURE_MS,
  });
  assert.equal(gate.primaryDown(), true);
  time.advance(PRIMARY_DOWN_AFTER_AUTH_FAILURE_MS - 1);
  assert.equal(gate.primaryDown(), true);
  time.advance(1);
  assert.equal(gate.primaryDown(), false);
});

test("a BUSY from Flow itself marks it down for 10 minutes", () => {
  const time = clock();
  const gate = createTryOnOverflowGate({ dailyCap: 10, now: time.now });
  assert.deepEqual(gate.notePrimaryOutcome({ ok: false, reason: "BUSY" }), {
    cause: "provider_busy",
    forMs: PRIMARY_DOWN_AFTER_PROVIDER_BUSY_MS,
  });
  time.advance(PRIMARY_DOWN_AFTER_PROVIDER_BUSY_MS);
  assert.equal(gate.primaryDown(), false);
});

test("only failures in a row mark Flow down; a success or a safety refusal resets the run", () => {
  const time = clock();
  const gate = createTryOnOverflowGate({ dailyCap: 10, now: time.now });
  for (let i = 1; i < PRIMARY_FAILURES_BEFORE_DOWN; i += 1) {
    assert.equal(gate.notePrimaryOutcome({ ok: false, reason: i % 2 ? "TIMEOUT" : "GENERATION_FAILED" }), null);
  }
  gate.notePrimaryOutcome({ ok: true });
  for (let i = 1; i < PRIMARY_FAILURES_BEFORE_DOWN; i += 1) {
    assert.equal(gate.notePrimaryOutcome({ ok: false, reason: "GENERATION_FAILED" }), null);
  }
  gate.notePrimaryOutcome({ ok: false, reason: "SAFETY_BLOCKED" });
  assert.equal(gate.primaryDown(), false);

  for (let i = 1; i < PRIMARY_FAILURES_BEFORE_DOWN; i += 1) {
    gate.notePrimaryOutcome({ ok: false, reason: "TIMEOUT" });
  }
  assert.deepEqual(gate.notePrimaryOutcome({ ok: false, reason: "TIMEOUT" }), {
    cause: "repeated_failures",
    forMs: PRIMARY_DOWN_AFTER_FAILURES_MS,
  });
  assert.equal(gate.primaryDown(), true);
  time.advance(PRIMARY_DOWN_AFTER_FAILURES_MS + HOUR);
  assert.equal(gate.primaryDown(), false);
});

test("a cap or concurrency that is not a positive integer is a configuration error", () => {
  for (const dailyCap of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => createTryOnOverflowGate({ dailyCap }), TypeError);
  }
  assert.throws(() => createTryOnOverflowGate({ dailyCap: 1, maxConcurrent: 0 }), TypeError);
});
