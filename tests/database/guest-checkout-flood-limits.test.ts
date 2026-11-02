import assert from "node:assert/strict";
import test from "node:test";

import { createHash } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";

import { createGuestCheckoutRateLimiter } from "../../src/commerce/guest-checkout-rate-limit.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const clientKey = `v1:${"c".repeat(64)}`;
const phone = "0912345678";
const otherPhone = "0987654321";
const phoneId = (value: string) => `checkout-phone-day:v1:${createHash("sha256").update(value).digest("hex")}`;
const ids = [`checkout-client-hour:${clientKey}`, phoneId(phone), phoneId(otherPhone)];
const start = new Date("2026-11-02T03:00:00.000Z");

async function cleanup() {
  await prisma.rateLimit.deleteMany({ where: { id: { in: ids } } });
}

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

test("a phone number is allowed until it has placed its daily orders, then refused until the day passes", async () => {
  await cleanup();
  const limiter = createGuestCheckoutRateLimiter(prisma, { maxPhoneDailyOrders: 2, phoneDailyWindowMs: 86_400_000 });
  assert.equal(await limiter.isPhoneAllowed({ phone, now: start }), true);
  // Checking spends nothing.
  for (let i = 0; i < 5; i += 1) assert.equal(await limiter.isPhoneAllowed({ phone, now: start }), true);

  await limiter.recordPhoneOrder({ phone, now: start });
  assert.equal(await limiter.isPhoneAllowed({ phone, now: start }), true);
  await limiter.recordPhoneOrder({ phone, now: new Date(start.getTime() + 3_600_000) });
  assert.equal(await limiter.isPhoneAllowed({ phone, now: new Date(start.getTime() + 7_200_000) }), false);

  // Another number is untouched, and the first one is free again after the window.
  assert.equal(await limiter.isPhoneAllowed({ phone: otherPhone, now: start }), true);
  assert.equal(await limiter.isPhoneAllowed({ phone, now: new Date(start.getTime() + 86_400_001) }), true);
});

test("the table stores a hash of the phone, never the number", async () => {
  await cleanup();
  const limiter = createGuestCheckoutRateLimiter(prisma);
  await limiter.recordPhoneOrder({ phone, now: start });
  const rows = await prisma.rateLimit.findMany({ where: { id: { contains: "checkout-phone-day" } } });
  const mine = rows.find((row) => row.id === phoneId(phone));
  assert.ok(mine);
  assert.equal(mine.id.includes(phone), false);
  assert.equal(mine.key.includes(phone), false);
});

test("only a normalized national phone number is accepted as a key", async () => {
  const limiter = createGuestCheckoutRateLimiter(prisma);
  await assert.rejects(() => limiter.isPhoneAllowed({ phone: "+84912345678", now: start }), TypeError);
  await assert.rejects(() => limiter.recordPhoneOrder({ phone: "abc", now: start }), TypeError);
});
