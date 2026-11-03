import assert from "node:assert/strict";
import test from "node:test";

import { createHash, createHmac } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";

import { submitGuestCheckoutPublicAction } from "../../src/commerce/guest-checkout-public-actions.ts";
import { createGuestCheckoutRateLimiter } from "../../src/commerce/guest-checkout-rate-limit.ts";
import { createGuestCheckoutSubmitService } from "../../src/commerce/guest-checkout-submit.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const clientKey = `v1:${"c".repeat(64)}`;
const phone = "0912345678";
const otherPhone = "0987654321";
const SECRET = "test-only-phone-limit-secret-0123456789abcdef";
const hmacKey = createHmac("sha256", SECRET).update("la-na:checkout-phone-limit:v2").digest();
const digest = (value: string) => createHmac("sha256", hmacKey).update(value).digest("hex");
const counterId = (value: string) => `checkout-phone-day:v2:${digest(value)}`;
const cart = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ids = [`checkout-client-hour:${clientKey}`];
const start = new Date("2026-11-02T03:00:00.000Z");

async function cleanup() {
  await prisma.rateLimit.deleteMany({
    where: { OR: [{ id: { in: ids } }, { id: { startsWith: "checkout-phone-" } }] },
  });
}

const limiterFor = (options: Parameters<typeof createGuestCheckoutRateLimiter>[1] = {}) =>
  createGuestCheckoutRateLimiter(prisma, { phoneKeySecret: SECRET, ...options });
const counterRow = (value: string) => prisma.rateLimit.findUnique({ where: { id: counterId(value) } });

test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("the hourly client bucket lets a burst-free client through and stops a slow flood", async () => {
  await cleanup();
  const limiter = createGuestCheckoutRateLimiter(prisma, { maxClientHourlyAttempts: 3, clientHourlyWindowMs: 3_600_000 });
  // Spread across the hour, so no per-minute bucket would ever have tripped.
  for (const minute of [0, 20, 40]) {
    assert.equal(await limiter.consumeClientHourly({ clientKey, now: new Date(start.getTime() + minute * 60_000) }), true);
  }
  assert.equal(await limiter.consumeClientHourly({ clientKey, now: new Date(start.getTime() + 50 * 60_000) }), false);
  // A new window starts afterwards.
  assert.equal(await limiter.consumeClientHourly({ clientKey, now: new Date(start.getTime() + 61 * 60_000) }), true);
});

test("carts racing on one phone at the ceiling cannot exceed it", async () => {
  await cleanup();
  const limiter = limiterFor({ maxPhoneDailyOrders: 5 });
  // Four orders already placed today, then eight different carts submit at the same moment.
  for (let n = 1; n <= 4; n += 1) assert.equal(await limiter.admitPhoneOrder({ phone, cartId: cart(n), now: start }), "ADMITTED");
  const racers = await Promise.all(
    Array.from({ length: 8 }, (_, i) => limiter.admitPhoneOrder({ phone, cartId: cart(100 + i), now: start })),
  );
  assert.equal(racers.filter((r) => r === "ADMITTED").length, 1);
  assert.equal(racers.filter((r) => r === "REFUSED").length, 7);
  assert.equal((await counterRow(phone))?.count, 5);
  // The refused carts left no claim behind that could later be released into someone else's slot.
  const claims = await prisma.rateLimit.count({ where: { id: { startsWith: "checkout-phone-claim:" } } });
  assert.equal(claims, 5);
});

test("from a cold start, exactly the ceiling is admitted out of many concurrent carts", async () => {
  await cleanup();
  const limiter = limiterFor({ maxPhoneDailyOrders: 5 });
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) => limiter.admitPhoneOrder({ phone, cartId: cart(200 + i), now: start })),
  );
  assert.equal(results.filter((r) => r === "ADMITTED").length, 5);
  assert.equal(results.filter((r) => r === "REFUSED").length, 7);
});

test("a retry from the same cart is not counted twice", async () => {
  await cleanup();
  const limiter = limiterFor({ maxPhoneDailyOrders: 2 });
  assert.equal(await limiter.admitPhoneOrder({ phone, cartId: cart(1), now: start }), "ADMITTED");
  assert.equal(await limiter.admitPhoneOrder({ phone, cartId: cart(1), now: start }), "ALREADY_ADMITTED");
  assert.equal(await limiter.admitPhoneOrder({ phone, cartId: cart(1), now: start }), "ALREADY_ADMITTED");
  assert.equal((await counterRow(phone))?.count, 1);
  assert.equal(await limiter.admitPhoneOrder({ phone, cartId: cart(2), now: start }), "ADMITTED");
  assert.equal(await limiter.admitPhoneOrder({ phone, cartId: cart(3), now: start }), "REFUSED");
});

test("releasing a reservation frees exactly one slot, once", async () => {
  await cleanup();
  const limiter = limiterFor({ maxPhoneDailyOrders: 2 });
  await limiter.admitPhoneOrder({ phone, cartId: cart(1), now: start });
  await limiter.admitPhoneOrder({ phone, cartId: cart(2), now: start });
  assert.equal(await limiter.admitPhoneOrder({ phone, cartId: cart(3), now: start }), "REFUSED");

  await limiter.releasePhoneOrder({ phone, cartId: cart(1), now: start });
  await limiter.releasePhoneOrder({ phone, cartId: cart(1), now: start });
  // A cart that never held a reservation frees nothing either.
  await limiter.releasePhoneOrder({ phone, cartId: cart(3), now: start });
  assert.equal((await counterRow(phone))?.count, 1);

  assert.equal(await limiter.admitPhoneOrder({ phone, cartId: cart(3), now: start }), "ADMITTED");
  assert.equal(await limiter.admitPhoneOrder({ phone, cartId: cart(4), now: start }), "REFUSED");
});

test("another number is untouched, and a number is free again after the day passes", async () => {
  await cleanup();
  const limiter = limiterFor({ maxPhoneDailyOrders: 1, phoneDailyWindowMs: 86_400_000 });
  assert.equal(await limiter.admitPhoneOrder({ phone, cartId: cart(1), now: start }), "ADMITTED");
  assert.equal(await limiter.admitPhoneOrder({ phone, cartId: cart(2), now: start }), "REFUSED");
  assert.equal(await limiter.admitPhoneOrder({ phone: otherPhone, cartId: cart(2), now: start }), "ADMITTED");
  const nextDay = new Date(start.getTime() + 86_400_001);
  assert.equal(await limiter.admitPhoneOrder({ phone, cartId: cart(2), now: nextDay }), "ADMITTED");
  assert.equal((await counterRow(phone))?.count, 1);
});

test("expired counters and claims are swept by later admissions", async () => {
  await cleanup();
  const limiter = limiterFor({ maxPhoneDailyOrders: 5, phoneDailyWindowMs: 86_400_000 });
  await limiter.admitPhoneOrder({ phone: otherPhone, cartId: cart(1), now: start });
  const later = new Date(start.getTime() + 2 * 86_400_000);
  await limiter.admitPhoneOrder({ phone, cartId: cart(2), now: later });
  assert.equal(await counterRow(otherPhone), null);
  const claims = await prisma.rateLimit.findMany({ where: { id: { startsWith: "checkout-phone-claim:" } } });
  assert.equal(claims.length, 1);
});

test("the stored key is a keyed HMAC of the phone: not the public SHA-256, and not recomputable without the secret", async () => {
  await cleanup();
  const limiter = limiterFor();
  await limiter.admitPhoneOrder({ phone, cartId: cart(1), now: start });
  const publicSha = createHash("sha256").update(phone).digest("hex");
  const rows = await prisma.rateLimit.findMany({ where: { id: { startsWith: "checkout-phone-" } } });
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.id.includes(phone), false);
    assert.equal(row.key.includes(phone), false);
    assert.equal(row.id.includes(publicSha), false, "an offline guess with plain SHA-256 must not match");
  }
  assert.ok(await counterRow(phone), "the counter is found with the keyed digest");

  // A different secret yields different keys, so a dump cannot be matched without it.
  const other = createGuestCheckoutRateLimiter(prisma, { phoneKeySecret: "a-different-server-secret-0123456789abcdef" });
  assert.equal(await other.admitPhoneOrder({ phone, cartId: cart(1), now: start }), "ADMITTED");
});

test("the limiter refuses to run without a real server secret, and only takes a normalized phone", async () => {
  const noSecret = createGuestCheckoutRateLimiter(prisma, { phoneKeySecret: "short" });
  await assert.rejects(() => noSecret.admitPhoneOrder({ phone, cartId: cart(1), now: start }), TypeError);
  const limiter = limiterFor();
  await assert.rejects(() => limiter.admitPhoneOrder({ phone: "+84912345678", cartId: cart(1), now: start }), TypeError);
  await assert.rejects(() => limiter.releasePhoneOrder({ phone: "abc", cartId: cart(1), now: start }), TypeError);
});

// --- the whole path: real limiter, real submit service, public action -----------------------------

type SubmissionOutcome = Parameters<typeof createGuestCheckoutSubmitService>[0]["orderSubmission"]["submit"];
const orderRow = (n: number) => ({
  id: `order-${n}`,
  publicCode: `LA-${n}`,
  state: "DRAFT" as const,
  merchandiseSubtotalVnd: BigInt(500_000),
  shippingFeeVnd: BigInt(30_000),
  totalVnd: BigInt(530_000),
  lines: [{ variantId: "variant-1", quantity: 1 }],
});

/** One shopper placing one order from cart `n`, through the limiter that is under test. */
function placeOrder(
  n: number,
  outcome: { capacityRefuses?: true; submission?: Awaited<ReturnType<SubmissionOutcome>> },
  limiter: ReturnType<typeof limiterFor>,
) {
  const service = createGuestCheckoutSubmitService({
    snapshot: {
      async create() {
        return { ok: true as const, order: orderRow(n), verifiedFulfillmentStateByVariantId: new Map() };
      },
    } as never,
    orderSubmission: {
      async submit() {
        if (!outcome.submission) throw new Error("must not be sent");
        return outcome.submission;
      },
    } as never,
    generatePublicCode: () => `LA-p${n}`,
    ...(outcome.capacityRefuses
      ? {
          capacity: {
            async reserveOrderCapacity() {
              return { ok: false as const, reason: "standard-would-go-negative" as const, refusedVariantId: "variant-1" };
            },
            async transitionReservation() {
              return true;
            },
          } as never,
        }
      : {}),
  });
  const form = new FormData();
  for (const [key, value] of Object.entries({ name: "Nguyễn Văn A", phone, provinceRef: "province-01", communeRef: "commune-0001", detail: "12 Đường A" })) form.set(key, value);
  const thisCart = cart(900 + n);
  return submitGuestCheckoutPublicAction(
    {
      cartSession: { read: () => thisCart, clear: () => undefined },
      consumeAttempt: async () => true,
      submitCheckout: (input) =>
        service.submit({ cartId: input.cartId, shopId: 920_007, checkoutInput: { name: "Nguyễn Văn A", phone, provinceRef: "province-01", communeRef: "commune-0001", detail: "12 Đường A", note: null } as never, now: start }),
      phoneOrderLimit: {
        admit: (p, c) => limiter.admitPhoneOrder({ phone: p, cartId: c, now: start }),
        release: (p, c) => limiter.releasePhoneOrder({ phone: p, cartId: c, now: start }),
      },
    },
    form,
  );
}

test("orders that certainly were never sent do not use up the number's daily orders", async () => {
  await cleanup();
  const limiter = limiterFor({ maxPhoneDailyOrders: 5 });

  // Five different carts, each refused at the capacity gate with a local order code and nothing sent.
  for (let n = 1; n <= 5; n += 1) {
    const refused = await placeOrder(n, { capacityRefuses: true }, limiter);
    assert.deepEqual(refused, { ok: false, status: "RETRYABLE", reason: "CART_CHANGED", orderCode: `LA-${n}` });
  }
  assert.equal((await counterRow(phone))?.count, 0, "none of them took a slot");

  // Five more, each rejected outright by Pancake (HTTP 4xx): also nothing to ship.
  for (let n = 6; n <= 10; n += 1) {
    await placeOrder(n, { submission: { ok: false, state: "REJECTED", reason: "ORDER_REJECTED" } as never }, limiter);
  }
  assert.equal((await counterRow(phone))?.count, 0);

  // So a sixth, real order still goes through, and only it is counted.
  const placed = await placeOrder(11, { submission: { ok: true, state: "CONFIRMED", pancakeOrderId: "700001" } as never }, limiter);
  assert.equal(placed.ok, true);
  assert.equal((await counterRow(phone))?.count, 1);
});

test("orders that may exist keep their slot, so unknown outcomes still reach the ceiling", async () => {
  await cleanup();
  const limiter = limiterFor({ maxPhoneDailyOrders: 5 });
  for (let n = 1; n <= 5; n += 1) {
    const unknown = await placeOrder(n, { submission: { ok: false, state: "SYNC_UNKNOWN", reason: "CREATE_OUTCOME_UNKNOWN" } as never }, limiter);
    assert.equal(unknown.ok === false && unknown.status, "SYNC_UNKNOWN");
  }
  assert.equal((await counterRow(phone))?.count, 5);
  const sixth = await placeOrder(6, { submission: { ok: true, state: "CONFIRMED", pancakeOrderId: "700002" } as never }, limiter);
  assert.deepEqual(sixth, { ok: false, status: "RETRYABLE", reason: "TOO_MANY_ORDERS" });
});
