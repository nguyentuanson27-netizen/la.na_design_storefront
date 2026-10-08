import assert from "node:assert/strict";
import test from "node:test";

import { createTryOnRateLimiter } from "../../src/commerce/try-on-rate-limit.ts";

const A = "v1:" + "a".repeat(64);
const B = "v1:" + "b".repeat(64);

const guest = (key = A) => ({ kind: "guest", key }) as const;
const member = (key = "member:user-1") => ({ kind: "member", key }) as const;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

test("the default quotas are the owner-approved ones: guest 1/min and 5 total, member 2/min and 10/day", () => {
  const limiter = createTryOnRateLimiter();

  // Guest: one per minute.
  assert.deepEqual(limiter.consumeAttempt(guest(), 0), { ok: true });
  assert.deepEqual(limiter.consumeAttempt(guest(), 30_000), { ok: false, reason: "RATE_LIMITED" });
  assert.deepEqual(limiter.consumeAttempt(guest(), MINUTE), { ok: true });

  // Member: two per minute.
  assert.deepEqual(limiter.consumeAttempt(member(), 0), { ok: true });
  assert.deepEqual(limiter.consumeAttempt(member(), 1), { ok: true });
  assert.deepEqual(limiter.consumeAttempt(member(), 2), { ok: false, reason: "RATE_LIMITED" });
  assert.deepEqual(limiter.consumeAttempt(member(), MINUTE), { ok: true });
});

test("a guest gets five attempts, one a minute; from the sixth, login is required", () => {
  const limiter = createTryOnRateLimiter();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.deepEqual(limiter.consumeAttempt(guest(), attempt * MINUTE), { ok: true }, `attempt ${attempt + 1}`);
  }
  assert.deepEqual(limiter.consumeAttempt(guest(), 5 * MINUTE), { ok: false, reason: "LOGIN_REQUIRED" });
  // Still login-required later the same day, and a mere wait does not turn it into a retry-in-a-minute.
  assert.deepEqual(limiter.consumeAttempt(guest(), 6 * MINUTE), { ok: false, reason: "LOGIN_REQUIRED" });
  assert.deepEqual(limiter.consumeAttempt(guest(), 5 * MINUTE + 1), { ok: false, reason: "LOGIN_REQUIRED" });
});

test("login-required outranks the per-minute limit once a guest is out of attempts", () => {
  const limiter = createTryOnRateLimiter({ guest: { perMinute: 1, perDay: 1 } });
  assert.deepEqual(limiter.consumeAttempt(guest(), 0), { ok: true });
  assert.deepEqual(limiter.consumeAttempt(guest(), 1), { ok: false, reason: "LOGIN_REQUIRED" });
});

test("a guest's allowance renews after a day", () => {
  const limiter = createTryOnRateLimiter();
  for (let attempt = 0; attempt < 5; attempt += 1) limiter.consumeAttempt(guest(), attempt * MINUTE);
  assert.equal(limiter.consumeAttempt(guest(), 10 * MINUTE).ok, false);
  assert.deepEqual(limiter.consumeAttempt(guest(), DAY), { ok: true });
});

test("a member gets ten attempts a day, then must wait for the next day (never login-required)", () => {
  const limiter = createTryOnRateLimiter();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    // Two per minute, so five minutes cover ten attempts.
    assert.deepEqual(limiter.consumeAttempt(member(), Math.floor(attempt / 2) * MINUTE + (attempt % 2)), { ok: true });
  }
  assert.deepEqual(limiter.consumeAttempt(member(), 6 * MINUTE), { ok: false, reason: "DAILY_LIMIT_REACHED" });
  assert.deepEqual(limiter.consumeAttempt(member(), DAY - 1), { ok: false, reason: "DAILY_LIMIT_REACHED" });
  assert.deepEqual(limiter.consumeAttempt(member(), DAY), { ok: true });
});

test("a rejected attempt is not counted against the allowance", () => {
  const limiter = createTryOnRateLimiter();
  assert.deepEqual(limiter.consumeAttempt(guest(), 0), { ok: true });
  // Hammering inside the minute must not eat the remaining four.
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    assert.deepEqual(limiter.consumeAttempt(guest(), attempt), { ok: false, reason: "RATE_LIMITED" });
  }
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    assert.deepEqual(limiter.consumeAttempt(guest(), attempt * MINUTE), { ok: true }, `attempt ${attempt + 1}`);
  }
  assert.deepEqual(limiter.consumeAttempt(guest(), 5 * MINUTE), { ok: false, reason: "LOGIN_REQUIRED" });
});

test("guests and members are tracked separately, and clients do not share allowances", () => {
  const limiter = createTryOnRateLimiter();
  assert.deepEqual(limiter.consumeAttempt(guest(A), 0), { ok: true });
  assert.deepEqual(limiter.consumeAttempt(guest(B), 0), { ok: true });
  assert.deepEqual(limiter.consumeAttempt(member("member:user-1"), 0), { ok: true });
  assert.deepEqual(limiter.consumeAttempt(member("member:user-2"), 0), { ok: true });
  // The same string as a guest key and a member key is two different identities.
  assert.deepEqual(limiter.consumeAttempt(guest("member:user-1"), 0), { ok: true });
  assert.deepEqual(limiter.consumeAttempt(guest(A), 1), { ok: false, reason: "RATE_LIMITED" });
});

test("concurrent generations are bounded and a released slot frees capacity", () => {
  const limiter = createTryOnRateLimiter({ maxConcurrent: 1 });
  const first = limiter.startGeneration();
  assert.equal(first.ok, true);
  assert.deepEqual(limiter.startGeneration(), { ok: false, reason: "BUSY" });
  if (first.ok) {
    first.release();
    first.release(); // idempotent: a double release must not free a second slot
  }
  const second = limiter.startGeneration();
  assert.equal(second.ok, true);
  assert.deepEqual(limiter.startGeneration(), { ok: false, reason: "BUSY" });
});

test("uploads in flight are capped separately from generations, and a released slot frees capacity", () => {
  const limiter = createTryOnRateLimiter({ maxConcurrentUploads: 2, maxConcurrent: 1 });
  const first = limiter.startUpload();
  const second = limiter.startUpload();
  assert.equal(first.ok && second.ok, true);
  assert.deepEqual(limiter.startUpload(), { ok: false, reason: "BUSY" });
  // Uploads never occupy a generation slot, so slow uploads cannot starve Vertex capacity.
  const generation = limiter.startGeneration();
  assert.equal(generation.ok, true);
  assert.deepEqual(limiter.startGeneration(), { ok: false, reason: "BUSY" });
  if (first.ok) {
    first.release();
    first.release(); // idempotent
  }
  assert.equal(limiter.startUpload().ok, true);
  assert.deepEqual(limiter.startUpload(), { ok: false, reason: "BUSY" });
});

test("tracking is bounded: when the table is full of live identities, new ones fail closed", () => {
  const limiter = createTryOnRateLimiter({ maxTrackedClients: 2 });
  assert.deepEqual(limiter.consumeAttempt(guest(A), 0), { ok: true });
  assert.deepEqual(limiter.consumeAttempt(guest(B), 0), { ok: true });
  const C = "v1:" + "c".repeat(64);
  assert.deepEqual(limiter.consumeAttempt(guest(C), 1), { ok: false, reason: "RATE_LIMITED" });
  // A tracked identity still gets its own decisions.
  assert.deepEqual(limiter.consumeAttempt(guest(A), MINUTE), { ok: true });
  // Expired entries are reclaimed, so the table recovers by itself.
  assert.deepEqual(limiter.consumeAttempt(guest(C), DAY + MINUTE), { ok: true });
});

test("invalid configuration is rejected", () => {
  assert.throws(() => createTryOnRateLimiter({ guest: { perMinute: 0, perDay: 5 } }), TypeError);
  assert.throws(() => createTryOnRateLimiter({ member: { perMinute: 2, perDay: -1 } }), TypeError);
  assert.throws(() => createTryOnRateLimiter({ maxConcurrent: 1.5 }), TypeError);
  assert.throws(() => createTryOnRateLimiter({ maxConcurrentUploads: 0 }), TypeError);
});

test("peekQuota reports what is left today without spending anything", () => {
  const limiter = createTryOnRateLimiter();
  assert.deepEqual(limiter.peekQuota(guest(), 0), { audience: "guest", limit: 5, remaining: 5 });
  assert.deepEqual(limiter.peekQuota(guest(), 0), { audience: "guest", limit: 5, remaining: 5 });

  limiter.consumeAttempt(guest(), 0);
  limiter.consumeAttempt(guest(), MINUTE);
  assert.deepEqual(limiter.peekQuota(guest(), MINUTE), { audience: "guest", limit: 5, remaining: 3 });
  // A refused attempt does not count, so it does not lower the number either.
  limiter.consumeAttempt(guest(), MINUTE + 1);
  assert.equal(limiter.peekQuota(guest(), MINUTE + 1).remaining, 3);

  // Another visitor, and a member of the same address, are metered separately.
  assert.equal(limiter.peekQuota(guest(B), MINUTE).remaining, 5);
  assert.deepEqual(limiter.peekQuota(member(), MINUTE), { audience: "member", limit: 10, remaining: 10 });

  // The window renews after a day.
  assert.equal(limiter.peekQuota(guest(), DAY).remaining, 5);
});

test("peekQuota never goes below zero for an identity that is out of attempts", () => {
  const limiter = createTryOnRateLimiter();
  for (let attempt = 0; attempt < 5; attempt += 1) limiter.consumeAttempt(guest(), attempt * MINUTE);
  assert.equal(limiter.peekQuota(guest(), 5 * MINUTE).remaining, 0);
});
