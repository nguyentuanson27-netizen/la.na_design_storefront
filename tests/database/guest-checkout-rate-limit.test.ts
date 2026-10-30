import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createGuestCheckoutRateLimiter } from "../../src/commerce/guest-checkout-rate-limit.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const cartId = "22222222-2222-4222-8222-222222222222";
const otherCartId = "33333333-3333-4333-8333-333333333333";
const clientKey = `v1:${"a".repeat(64)}`;
const otherClientKey = `v1:${"b".repeat(64)}`;
const bucketIds = [
  `checkout:${cartId}`,
  `checkout:${otherCartId}`,
  `checkout-client:${clientKey}`,
  `checkout-client:${otherClientKey}`,
  `checkout-geo-client:${clientKey}`,
  `checkout-geo-client:${otherClientKey}`,
  `checkout-upsell-client:${clientKey}`,
  `checkout-upsell-client:${otherClientKey}`,
  `checkout-upsell-browse-client:${clientKey}`,
  `checkout-upsell-browse-client:${otherClientKey}`,
];
const start = new Date("2026-08-12T05:40:00.000Z");

async function cleanup() {
  await prisma.rateLimit.deleteMany({ where: { id: { in: bucketIds } } });
}

test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("guest checkout limiter atomically allows five attempts per cart and resets after the window", async () => {
  await cleanup();
  const limiter = createGuestCheckoutRateLimiter(prisma, {
    maxAttempts: 5,
    windowMs: 60_000,
  });

  const concurrent = await Promise.all(
    Array.from({ length: 6 }, () => limiter.consume({ cartId, now: start })),
  );
  assert.equal(concurrent.filter(Boolean).length, 5);
  assert.equal(concurrent.filter((allowed) => !allowed).length, 1);

  assert.equal(await limiter.consume({ cartId: otherCartId, now: start }), true);

  const saturated = await prisma.rateLimit.findUniqueOrThrow({
    where: { id: `checkout:${cartId}` },
  });
  assert.equal(saturated.key, `checkout:${cartId}`);
  assert.equal(saturated.count, 6);
  assert.equal(saturated.lastRequest, BigInt(start.getTime()));

  const resetAt = new Date(start.getTime() + 60_001);
  assert.equal(await limiter.consume({ cartId, now: resetAt }), true);

  const reset = await prisma.rateLimit.findUniqueOrThrow({
    where: { id: `checkout:${cartId}` },
  });
  assert.equal(reset.count, 1);
  assert.equal(reset.lastRequest, BigInt(resetAt.getTime()));
});

test("guest checkout limiter atomically caps one trusted client across cart rotations", async () => {
  await cleanup();
  const limiter = createGuestCheckoutRateLimiter(prisma, {
    maxClientAttempts: 3,
    clientWindowMs: 60_000,
  });

  const concurrent = await Promise.all(
    Array.from({ length: 4 }, () => limiter.consumeClient({ clientKey, now: start })),
  );
  assert.equal(concurrent.filter(Boolean).length, 3);
  assert.equal(concurrent.filter((allowed) => !allowed).length, 1);
  assert.equal(await limiter.consumeClient({ clientKey: otherClientKey, now: start }), true);

  const saturated = await prisma.rateLimit.findUniqueOrThrow({
    where: { id: `checkout-client:${clientKey}` },
  });
  assert.equal(saturated.key, `checkout-client:${clientKey}`);
  assert.equal(saturated.count, 4);
  assert.equal(saturated.lastRequest, BigInt(start.getTime()));
});

test("checkout geo reads use a separate trusted-client bucket from checkout submission", async () => {
  await cleanup();
  const limiter = createGuestCheckoutRateLimiter(prisma, {
    maxClientAttempts: 1,
    maxGeoClientAttempts: 3,
    geoClientWindowMs: 60_000,
  });

  assert.equal(await limiter.consumeClient({ clientKey, now: start }), true);
  assert.equal(await limiter.consumeClient({ clientKey, now: start }), false);

  const concurrent = await Promise.all(
    Array.from({ length: 4 }, () => limiter.consumeGeoClient({ clientKey, now: start })),
  );
  assert.equal(concurrent.filter(Boolean).length, 3);
  assert.equal(concurrent.filter((allowed) => !allowed).length, 1);
  assert.equal(await limiter.consumeGeoClient({ clientKey: otherClientKey, now: start }), true);

  const geoBucket = await prisma.rateLimit.findUniqueOrThrow({
    where: { id: `checkout-geo-client:${clientKey}` },
  });
  assert.equal(geoBucket.count, 4);
  assert.equal(geoBucket.lastRequest, BigInt(start.getTime()));
});

test("upsell recommendations have a separate limiter that cannot block checkout or geo reads", async () => {
  await cleanup();
  const limiter = createGuestCheckoutRateLimiter(prisma, {
    maxUpsellClientAttempts: 2,
    upsellClientWindowMs: 60_000,
    maxClientAttempts: 1,
    maxGeoClientAttempts: 1,
  });
  const attempts = await Promise.all(Array.from({ length: 4 }, () => limiter.consumeUpsellClient({ clientKey, now: start })));
  assert.equal(attempts.filter(Boolean).length, 2);
  assert.equal(await limiter.consumeUpsellClient({ clientKey: otherClientKey, now: start }), true);
  assert.equal(await limiter.consumeClient({ clientKey, now: start }), true);
  assert.equal(await limiter.consumeGeoClient({ clientKey, now: start }), true);
  assert.equal(await limiter.consumeUpsellClient({ clientKey, now: new Date(start.getTime() + 60_001) }), true);
});

test("GET browse probes have their own atomic DB bucket and do not exhaust POST upsell quota", async () => {
  await cleanup();
  const limiter = createGuestCheckoutRateLimiter(prisma, {
    maxUpsellBrowseClientAttempts: 2,
    upsellBrowseClientWindowMs: 60_000,
    maxUpsellClientAttempts: 2,
  });
  const probeAttempts = await Promise.all(
    Array.from({ length: 4 }, () => limiter.consumeUpsellBrowseClient({ clientKey, now: start })),
  );
  assert.equal(probeAttempts.filter(Boolean).length, 2);
  assert.equal(probeAttempts.filter((allowed) => !allowed).length, 2);
  assert.equal((await prisma.rateLimit.findUniqueOrThrow({
    where: { id: `checkout-upsell-browse-client:${clientKey}` },
  })).count, 3, "bounded counters cap at limit + 1");

  assert.equal(await limiter.consumeUpsellClient({ clientKey, now: start }), true);
  assert.equal(await limiter.consumeUpsellClient({ clientKey, now: start }), true);
  assert.equal(await limiter.consumeUpsellClient({ clientKey, now: start }), false);
  assert.equal(await limiter.consumeUpsellBrowseClient({ clientKey: otherClientKey, now: start }), true);
  assert.equal(await limiter.consumeUpsellBrowseClient({ clientKey, now: new Date(start.getTime() + 60_001) }), true);
});

test("guest checkout limiter rejects malformed local configuration before database access", async () => {
  assert.throws(
    () => createGuestCheckoutRateLimiter(prisma, { maxAttempts: 0 }),
    /Checkout max attempts must be a positive safe integer/,
  );
  assert.throws(
    () => createGuestCheckoutRateLimiter(prisma, { windowMs: 0 }),
    /Checkout rate-limit window must be a positive safe integer/,
  );
  assert.throws(
    () => createGuestCheckoutRateLimiter(prisma, { maxClientAttempts: 0 }),
    /Checkout client max attempts must be a positive safe integer/,
  );
  assert.throws(
    () => createGuestCheckoutRateLimiter(prisma, { clientWindowMs: 0 }),
    /Checkout client rate-limit window must be a positive safe integer/,
  );
  assert.throws(
    () => createGuestCheckoutRateLimiter(prisma, { maxGeoClientAttempts: 0 }),
    /Checkout geo client max attempts must be a positive safe integer/,
  );
  assert.throws(
    () => createGuestCheckoutRateLimiter(prisma, { geoClientWindowMs: 0 }),
    /Checkout geo client rate-limit window must be a positive safe integer/,
  );

  const limiter = createGuestCheckoutRateLimiter(prisma);
  await assert.rejects(
    () => limiter.consume({ cartId: "", now: start }),
    /Checkout cart id must be a bounded non-empty string/,
  );
  await assert.rejects(
    () => limiter.consume({ cartId, now: new Date(Number.NaN) }),
    /Checkout rate-limit time must be valid/,
  );
  await assert.rejects(
    () => limiter.consumeClient({ clientKey: "203.0.113.10", now: start }),
    /Checkout client key must be a pseudonymous v1 key/,
  );
  await assert.rejects(
    () => limiter.consumeGeoClient({ clientKey: "203.0.113.10", now: start }),
    /Checkout client key must be a pseudonymous v1 key/,
  );
});
