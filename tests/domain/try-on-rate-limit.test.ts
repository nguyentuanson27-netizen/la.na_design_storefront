import assert from "node:assert/strict";
import test from "node:test";

import { createTryOnRateLimiter } from "../../src/commerce/try-on-rate-limit.ts";

const A = "v1:" + "a".repeat(64);
const B = "v1:" + "b".repeat(64);

test("a client may make maxPerWindow attempts per window, then is rejected", () => {
  const limiter = createTryOnRateLimiter({ maxPerWindow: 2, windowMs: 1_000 });
  assert.equal(limiter.consumeAttempt(A, 0), true);
  assert.equal(limiter.consumeAttempt(A, 1), true);
  assert.equal(limiter.consumeAttempt(A, 500), false);
});

test("the window resets and other clients are unaffected", () => {
  const limiter = createTryOnRateLimiter({ maxPerWindow: 1, windowMs: 1_000 });
  assert.equal(limiter.consumeAttempt(A, 0), true);
  assert.equal(limiter.consumeAttempt(A, 999), false);
  assert.equal(limiter.consumeAttempt(B, 999), true);
  assert.equal(limiter.consumeAttempt(A, 1_000), true);
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

test("tracking is bounded: when the table is full of live clients, new ones fail closed", () => {
  const limiter = createTryOnRateLimiter({ maxPerWindow: 5, windowMs: 60_000, maxTrackedClients: 2 });
  assert.equal(limiter.consumeAttempt(A, 0), true);
  assert.equal(limiter.consumeAttempt(B, 0), true);
  const C = "v1:" + "c".repeat(64);
  assert.equal(limiter.consumeAttempt(C, 1), false);
  // A tracked client still gets its own quota.
  assert.equal(limiter.consumeAttempt(A, 1), true);
  // Expired entries are reclaimed, so the table recovers by itself.
  assert.equal(limiter.consumeAttempt(C, 60_001), true);
});

test("invalid configuration is rejected", () => {
  assert.throws(() => createTryOnRateLimiter({ maxPerWindow: 0 }), TypeError);
  assert.throws(() => createTryOnRateLimiter({ windowMs: -1 }), TypeError);
  assert.throws(() => createTryOnRateLimiter({ maxConcurrent: 1.5 }), TypeError);
  assert.throws(() => createTryOnRateLimiter({ maxConcurrentUploads: 0 }), TypeError);
});
