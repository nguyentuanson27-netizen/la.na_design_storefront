import assert from "node:assert/strict";
import test from "node:test";

import { consumeContactRateLimits } from "../../src/contact/contact-rate-limit.ts";
import { prisma } from "../../src/db/prisma.ts";

const WINDOW_MS = 15 * 60 * 1_000;
const baseNow = Date.parse("2026-09-18T00:00:00.000Z");
const buckets = ["contact-rate-limit-sequential-test", "contact-rate-limit-concurrent-test"];
const ids = buckets.flatMap((bucket) => [
  `contact:15m:${bucket}`,
  `contact:24h:${bucket}`,
]);

test.beforeEach(async () => {
  await prisma.rateLimit.deleteMany({ where: { id: { in: ids } } });
});

test.afterEach(async () => {
  await prisma.rateLimit.deleteMany({ where: { id: { in: ids } } });
});

test.after(async () => {
  await prisma.$disconnect();
});

test("contact limiter enforces 3/15m and 10/24h windows and then resets", async () => {
  const bucket = buckets[0]!;

  assert.equal(await consumeContactRateLimits(bucket, baseNow), true);
  assert.equal(await consumeContactRateLimits(bucket, baseNow), true);
  assert.equal(await consumeContactRateLimits(bucket, baseNow), true);
  assert.equal(await consumeContactRateLimits(bucket, baseNow), false);

  for (let window = 1; window <= 6; window += 1) {
    assert.equal(await consumeContactRateLimits(bucket, baseNow + window * WINDOW_MS + 1), true);
  }

  assert.equal(await consumeContactRateLimits(bucket, baseNow + 7 * WINDOW_MS + 1), false);
  assert.equal(await consumeContactRateLimits(bucket, baseNow + 24 * 60 * 60 * 1_000 + 1), true);
});

test("contact limiter increments atomically under concurrent attempts", async () => {
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      consumeContactRateLimits("contact-rate-limit-concurrent-test", baseNow),
    ),
  );

  assert.equal(results.filter(Boolean).length, 3);
  assert.equal(results.filter((allowed) => !allowed).length, 1);
});
