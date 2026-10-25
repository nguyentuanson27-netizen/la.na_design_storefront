import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../src/generated/prisma/client.ts";
import {
  MAX_VOUCHER_CANDIDATES,
  lookupVoucherCode,
  readOwnHeldVouchers,
  readPublicVoucherCandidates,
  readSelectedVouchers,
  toVoucherCard,
} from "../../src/commerce/voucher-candidate-repository.ts";
import { createVoucherFixtures } from "../support/voucher-fixtures.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const SHOP = 940_002;
const f = createVoucherFixtures(prisma, SHOP, "vchr-cand");
const ON = { LA_VOUCHER_ENABLED: "true" };
const NOW = new Date("2026-10-25T12:00:00Z");
const client = prisma;

test.before(f.cleanup);
test.after(async () => {
  await f.cleanup();
  await prisma.$disconnect();
});
test.beforeEach(f.cleanup);

test("with the flag OFF nothing is read and nothing is returned, even for a valid campaign", async () => {
  await f.campaign({ issuance: "CODE", code: "OFFTEST1" });
  assert.deepEqual(await readPublicVoucherCandidates({ client, shopId: SHOP, now: NOW, env: {} }), []);
  assert.deepEqual(await readPublicVoucherCandidates({ client, shopId: SHOP, now: NOW, env: { LA_VOUCHER_ENABLED: "false" } }), []);
  assert.deepEqual(await lookupVoucherCode({ client, shopId: SHOP, rawCode: "OFFTEST1", now: NOW, env: {} }), { ok: false, reason: "INVALID_CODE" });
});

test("only active PUBLIC campaigns of this shop are listed; PRIVATE, drafts, scheduled, ended and other shops are not", async () => {
  const shown = await f.campaign({ name: "shown" });
  await f.shippingCampaign({ name: "shown-ship" });
  await f.campaign({ issuance: "CODE", visibility: "PRIVATE", code: "HIDDEN1", name: "private" });
  await f.campaign({ isEnabled: false, enabledAt: null, name: "draft" });
  await f.campaign({ startsAt: new Date("2026-11-01T00:00:00Z"), name: "scheduled" });
  await f.campaign({ endsAt: new Date("2026-10-20T00:00:00Z"), name: "ended" });
  await f.campaign({ isEnabled: false, enabledAt: new Date("2026-10-01T00:00:00Z"), disabledAt: new Date("2026-10-10T00:00:00Z"), name: "disabled" });
  await f.campaign({ pancakeShopId: SHOP + 1, name: "other-shop" }).finally(() => prisma.voucherCampaign.deleteMany({ where: { pancakeShopId: SHOP + 1 } }));

  const list = await readPublicVoucherCandidates({ client, shopId: SHOP, now: NOW, env: ON });
  assert.deepEqual(list.map((c) => c.name), ["shown", "shown-ship"]);
  assert.equal(list[0]!.id, shown.id);
});

test("the [start, end) window is half-open at the clock", async () => {
  await f.campaign({ name: "starts-now", startsAt: NOW });
  await f.campaign({ name: "ends-now", endsAt: NOW });
  const list = await readPublicVoucherCandidates({ client, shopId: SHOP, now: NOW, env: ON });
  assert.deepEqual(list.map((c) => c.name), ["starts-now"]);
});

test("the shopper card never carries the ledger, the budget or a private code", async () => {
  await f.campaign({ issuance: "CODE", code: "PUBCODE1", name: "public-code", maxBudgetVnd: BigInt(1_000_000), reservedVnd: BigInt(5), redeemedVnd: BigInt(7) });
  const [campaign] = await readPublicVoucherCandidates({ client, shopId: SHOP, now: NOW, env: ON });
  const card = toVoucherCard(campaign!);
  assert.equal(card.publicCode, "PUBCODE1");
  const serialized = JSON.stringify(card, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  for (const leak of ["maxBudget", "reserved", "redeemed", "pancakeShopId"]) assert.doesNotMatch(serialized, new RegExp(leak, "i"));
  const lookup = async (rawCode: string) => {
    const result = await lookupVoucherCode({ client, shopId: SHOP, rawCode, now: NOW, env: ON });
    assert.equal(result.ok, true);
    return (result as Extract<typeof result, { ok: true }>).campaign;
  };
  assert.equal(toVoucherCard(await lookup("PUBCODE1")).publicCode, "PUBCODE1");
  await f.campaign({ issuance: "CODE", visibility: "PRIVATE", code: "KOLONLY1" });
  assert.equal(toVoucherCard(await lookup("kolonly1")).publicCode, null);
});

test("AC-13: every way a PRIVATE code can fail answers the same INVALID_CODE", async () => {
  await f.campaign({ issuance: "CODE", visibility: "PRIVATE", code: "KOL50", name: "ok" });
  await f.campaign({ issuance: "CODE", visibility: "PRIVATE", code: "KOLOLD", endsAt: new Date("2026-10-01T00:00:00Z") });
  await f.campaign({ issuance: "CODE", visibility: "PRIVATE", code: "KOLOFF", isEnabled: false, enabledAt: null });
  await f.campaign({ issuance: "CODE", visibility: "PRIVATE", code: "KOLSOON", startsAt: new Date("2026-12-01T00:00:00Z") });
  await f.campaign({ issuance: "CODE", visibility: "PRIVATE", code: "KOLFULL", maxUses: 1, redeemedUses: 1 });
  await f.campaign({ issuance: "CODE", visibility: "PRIVATE", code: "OTHERSHOP", pancakeShopId: SHOP + 1 }).finally(() => prisma.voucherCampaign.deleteMany({ where: { pancakeShopId: SHOP + 1 } }));

  const ok = await lookupVoucherCode({ client, shopId: SHOP, rawCode: " kol50 ", now: NOW, env: ON });
  assert.equal(ok.ok, true);
  for (const raw of ["KOLOLD", "KOLOFF", "KOLSOON", "KOLFULL", "OTHERSHOP", "NOPE123", "", "a", "bad code!", null, undefined, 42, "x".repeat(100)]) {
    assert.deepEqual(await lookupVoucherCode({ client, shopId: SHOP, rawCode: raw, now: NOW, env: ON }), { ok: false, reason: "INVALID_CODE" }, String(raw));
  }
});

test("a used-up PUBLIC code says so (its existence is already public); an AUTO voucher has no code to look up", async () => {
  await f.campaign({ issuance: "CODE", code: "PUBFULL1", maxUses: 1, redeemedUses: 1 });
  assert.deepEqual(await lookupVoucherCode({ client, shopId: SHOP, rawCode: "PUBFULL1", now: NOW, env: ON }), { ok: false, reason: "VOUCHER_UNAVAILABLE" });
  const list = await readPublicVoucherCandidates({ client, shopId: SHOP, now: NOW, env: ON });
  assert.equal(toVoucherCard(list[0]!).availability, "EXHAUSTED");
  assert.deepEqual(await lookupVoucherCode({ client, shopId: SHOP, rawCode: "AUTO", now: NOW, env: ON }), { ok: false, reason: "INVALID_CODE" });
});

test("a manual selection is revalidated against the live row; stale ids simply drop out", async () => {
  const live = await f.campaign({ issuance: "CODE", visibility: "PRIVATE", code: "SELKOL1" });
  const gone = await f.campaign({ isEnabled: false, enabledAt: null });
  const picked = await readSelectedVouchers({ client, shopId: SHOP, ids: [live.id, gone.id, "missing", live.id], now: NOW, env: ON });
  assert.deepEqual(picked.map((c) => c.id), [live.id]);
  assert.deepEqual(await readSelectedVouchers({ client, shopId: SHOP, ids: [], now: NOW, env: ON }), []);
  assert.deepEqual(await readSelectedVouchers({ client, shopId: SHOP, ids: [live.id], now: NOW, env: {} }), []);
  await assert.rejects(readSelectedVouchers({ client, shopId: SHOP, ids: ["a", "b", "c", "d", "e"], now: NOW, env: ON }), RangeError);
});

test("EX-08 / AC-31: the attempt's own live hold stays recognisable after the campaign expires, is disabled, or the flag goes OFF", async () => {
  const c = await f.campaign({ maxUses: 1, reservedUses: 1, endsAt: new Date("2026-10-25T12:03:00Z") });
  const attemptKey = f.hex("own-attempt");
  const created = new Date("2026-10-25T12:00:00Z");
  await f.hold(c.id, { attemptKey, createdAt: created, expiresAt: new Date(created.getTime() + 600_000) });
  await f.hold(c.id, { attemptKey: f.hex("someone-else"), createdAt: created, expiresAt: new Date(created.getTime() + 600_000) });

  const at = (minutes: number) => new Date(created.getTime() + minutes * 60_000);
  // Natural expiry at T+3: the campaign is no longer a candidate, the hold is still the attempt's.
  assert.deepEqual(await readPublicVoucherCandidates({ client, shopId: SHOP, now: at(5), env: ON }), []);
  const mine = await readOwnHeldVouchers({ client, shopId: SHOP, attemptKey, now: at(5) });
  assert.equal(mine.length, 1);
  assert.equal(mine[0]!.expiresAt.getTime(), at(10).getTime());
  assert.equal(mine[0]!.heldDiscountVnd, 30_000);
  // The hold does not depend on the feature flag at all.
  await prisma.voucherCampaign.update({ where: { id: c.id }, data: { isEnabled: false, disabledAt: at(4) } });
  assert.equal((await readOwnHeldVouchers({ client, shopId: SHOP, attemptKey, now: at(5) })).length, 1);
  // At and after T+10 it is gone; another attempt's hold is never returned.
  assert.equal((await readOwnHeldVouchers({ client, shopId: SHOP, attemptKey, now: at(10) })).length, 0);
  await assert.rejects(readOwnHeldVouchers({ client, shopId: SHOP, attemptKey: "short", now: at(5) }), RangeError);
});

test("the candidate read is bounded and fails closed instead of dropping a campaign", async () => {
  const rows = Array.from({ length: MAX_VOUCHER_CANDIDATES + 1 }, (_, i) => ({
    ...f.base, name: `bulk ${i}`, id: `bulk-${process.pid}-${i}`, updatedAt: new Date(),
  }));
  await prisma.voucherCampaign.createMany({ data: rows as never });
  await assert.rejects(readPublicVoucherCandidates({ client, shopId: SHOP, now: NOW, env: ON }), /exceeds its bound/);
  await prisma.voucherCampaign.deleteMany({ where: { id: { startsWith: `bulk-${process.pid}-0` } } });
  await prisma.voucherCampaign.deleteMany({ where: { id: `bulk-${process.pid}-1` } });
  assert.equal((await readPublicVoucherCandidates({ client, shopId: SHOP, now: NOW, env: ON })).length, MAX_VOUCHER_CANDIDATES - 1);
});

test("reads are idempotent: listing, lookup and own-hold reads never change a hold or the ledger", async () => {
  const c = await f.campaign({ issuance: "CODE", code: "IDEMP1", maxUses: 5, reservedUses: 1 });
  const attemptKey = f.hex("idem");
  await f.hold(c.id, { attemptKey });
  const before = JSON.stringify({ c: await prisma.voucherCampaign.findUnique({ where: { id: c.id } }), h: await prisma.voucherHold.findMany({ where: { campaignId: c.id } }) }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  for (let i = 0; i < 3; i += 1) {
    await readPublicVoucherCandidates({ client, shopId: SHOP, now: new Date(), env: ON });
    await lookupVoucherCode({ client, shopId: SHOP, rawCode: "IDEMP1", now: new Date(), env: ON });
    await readOwnHeldVouchers({ client, shopId: SHOP, attemptKey, now: new Date() });
  }
  const after = JSON.stringify({ c: await prisma.voucherCampaign.findUnique({ where: { id: c.id } }), h: await prisma.voucherHold.findMany({ where: { campaignId: c.id } }) }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  assert.equal(after, before);
});
