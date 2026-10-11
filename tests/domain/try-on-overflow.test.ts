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

test("the daily cap counts every committed generation and refuses past it, whatever the outcome", () => {
  const time = clock();
  const gate = createTryOnOverflowGate({ dailyCap: 2, maxConcurrent: 5, now: time.now });
  for (let i = 0; i < 2; i += 1) {
    const slot = gate.startOverflow();
    assert.equal(slot.ok, true);
    if (slot.ok) {
      slot.commit();
      slot.commit(); // idempotent: one generation is spent once
      slot.release();
    }
  }
  assert.deepEqual(gate.startOverflow(), { ok: false, reason: "BUSY", cause: "daily_cap" });
});

test("a reservation released without a commit (Vertex never called) is handed back", () => {
  const gate = createTryOnOverflowGate({ dailyCap: 1, now: clock().now });
  const unused = gate.startOverflow();
  assert.equal(unused.ok, true);
  if (unused.ok) {
    unused.release();
    unused.release();
    unused.commit(); // too late: a released reservation can no longer be spent
  }
  const used = gate.startOverflow();
  assert.equal(used.ok, true);
  if (used.ok) {
    used.commit();
    used.release();
  }
  assert.deepEqual(gate.startOverflow(), { ok: false, reason: "BUSY", cause: "daily_cap" });
});

test("pending reservations count against the cap, so concurrent requests cannot overshoot it", () => {
  const gate = createTryOnOverflowGate({ dailyCap: 1, maxConcurrent: 5, now: clock().now });
  const first = gate.startOverflow();
  assert.equal(first.ok, true);
  assert.deepEqual(gate.startOverflow(), { ok: false, reason: "BUSY", cause: "daily_cap" });
});

test("the day turns over at midnight Vietnam time, not UTC", () => {
  const time = clock(Date.UTC(2026, 9, 11, 16, 59, 0)); // 23:59 in Vietnam
  const gate = createTryOnOverflowGate({ dailyCap: 1, maxConcurrent: 5, now: time.now });
  const slot = gate.startOverflow();
  if (slot.ok) {
    slot.commit();
    slot.release();
  }
  assert.equal(gate.startOverflow().ok, false);
  time.set(Date.UTC(2026, 9, 11, 17, 0, 0)); // 00:00 the next day in Vietnam
  const next = gate.startOverflow();
  assert.equal(next.ok, true);
});

test("a generation reserved before midnight and called after it counts on the day of the call", () => {
  const time = clock(Date.UTC(2026, 9, 11, 16, 59, 59)); // 23:59:59 in Vietnam
  const gate = createTryOnOverflowGate({ dailyCap: 1, maxConcurrent: 5, now: time.now });
  const late = gate.startOverflow();
  assert.equal(late.ok, true);

  time.set(Date.UTC(2026, 9, 11, 17, 0, 0)); // 00:00:00: the reservation still holds the new day's one
  assert.deepEqual(gate.startOverflow(), { ok: false, reason: "BUSY", cause: "daily_cap" });

  time.set(Date.UTC(2026, 9, 11, 17, 0, 1)); // 00:00:01: Vertex is called for it
  if (late.ok) {
    late.commit();
    late.release();
  }
  time.set(Date.UTC(2026, 9, 11, 17, 0, 2)); // 00:00:02: a second call the same day is refused
  assert.deepEqual(gate.startOverflow(), { ok: false, reason: "BUSY", cause: "daily_cap" });

  time.set(Date.UTC(2026, 9, 12, 17, 0, 0)); // the next midnight frees it again
  assert.equal(gate.startOverflow().ok, true);
});

test("a reservation from before midnight that is handed back frees the new day", () => {
  const time = clock(Date.UTC(2026, 9, 11, 16, 59, 59)); // 23:59:59 in Vietnam
  const gate = createTryOnOverflowGate({ dailyCap: 1, maxConcurrent: 5, now: time.now });
  const late = gate.startOverflow();
  time.set(Date.UTC(2026, 9, 11, 17, 0, 1));
  if (late.ok) late.release(); // its garment fetch failed: Vertex was never called
  assert.equal(gate.startOverflow().ok, true);
});

test("no calendar day ever sees more Vertex calls than the cap, across midnight and concurrency", () => {
  const time = clock(Date.UTC(2026, 9, 11, 16, 59, 0)); // 23:59 in Vietnam
  const cap = 2;
  const gate = createTryOnOverflowGate({ dailyCap: cap, maxConcurrent: 4, now: time.now });
  const callsByDay = new Map<number, number>();
  const open: Array<Extract<ReturnType<typeof gate.startOverflow>, { ok: true }>> = [];
  for (let step = 0; step < 240; step += 1) {
    time.advance(1_000);
    const slot = gate.startOverflow();
    if (slot.ok) open.push(slot);
    if (open.length > 0 && step % 3 === 0) {
      const settled = open.shift()!;
      if (step % 2 === 0) {
        settled.commit();
        const vnDay = Math.floor((time.now() + 7 * HOUR) / (24 * HOUR));
        callsByDay.set(vnDay, (callsByDay.get(vnDay) ?? 0) + 1);
      }
      settled.release();
    }
  }
  assert.ok(callsByDay.size >= 2, "the run crossed midnight");
  for (const [vnDay, calls] of callsByDay) assert.ok(calls <= cap, `day ${vnDay}: ${calls} calls`);
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

test("a held worker's BUSY says nothing about Flow's health; a quota BUSY marks it down for 10 minutes", () => {
  const time = clock();
  const gate = createTryOnOverflowGate({ dailyCap: 10, now: time.now });
  for (let i = 0; i < 5; i += 1) {
    assert.equal(gate.notePrimaryOutcome({ ok: false, reason: "BUSY" }), null);
    assert.equal(gate.notePrimaryOutcome({ ok: false, reason: "BUSY", quotaExhausted: false }), null);
  }
  assert.equal(gate.primaryDown(), false);
  assert.deepEqual(gate.notePrimaryOutcome({ ok: false, reason: "BUSY", quotaExhausted: true }), {
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
