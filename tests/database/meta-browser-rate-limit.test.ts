import assert from "node:assert/strict";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client.ts";
import { consumeMetaBrowserRateLimit } from "../../src/commerce/meta-browser-rate-limit.ts";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const key = `v1:${"a".repeat(64)}`;
const now = new Date("2026-10-07T06:00:00Z");
const cleanup = () => prisma.rateLimit.deleteMany({ where: { id: { startsWith: "meta-signal:" } } });
test.beforeEach(cleanup);
test.after(async () => { await cleanup(); await prisma.$disconnect(); });

test("atomic per-client budget bounds parallel signals and resets at the window boundary", async () => {
  const results = await Promise.all(Array.from({ length: 65 }, () => consumeMetaBrowserRateLimit(prisma, key, now)));
  assert.equal(results.filter(Boolean).length, 60);
  assert.equal((await prisma.rateLimit.findUnique({ where: { id: "meta-signal:global" } }))?.count, 60, "denied clients do not consume the shared budget");
  assert.equal(await consumeMetaBrowserRateLimit(prisma, key, new Date(now.getTime() + 59_999)), false);
  assert.equal(await consumeMetaBrowserRateLimit(prisma, key, new Date(now.getTime() + 60_000)), true);
  assert.equal(await consumeMetaBrowserRateLimit(prisma, "203.0.113.9", now), false);
});

test("global budget denies new client buckets; bounded cleanup removes stale Meta keys only", async () => {
  await prisma.rateLimit.create({ data: { id: "meta-signal:global", key: "meta-signal:global", count: 600, lastRequest: BigInt(now.getTime()) } });
  assert.equal(await consumeMetaBrowserRateLimit(prisma, key, now), false);
  assert.equal((await prisma.rateLimit.findUnique({ where: { id: `meta-signal:${key}` } }))?.count, 1);
  await cleanup();
  await prisma.rateLimit.createMany({ data: Array.from({ length: 25 }, (_, i) => ({
    id: `meta-signal:old-${i}`, key: `meta-signal:old-${i}`, count: 1, lastRequest: BigInt(now.getTime() - 2 * 86400_000),
  })) });
  assert.equal(await consumeMetaBrowserRateLimit(prisma, key, now), true);
  assert.equal(await prisma.rateLimit.count({ where: { id: { startsWith: "meta-signal:old-" } } }), 5);
  assert.equal(await consumeMetaBrowserRateLimit(prisma, key, now), true);
  assert.equal(await prisma.rateLimit.count({ where: { id: { startsWith: "meta-signal:old-" } } }), 0);
});
