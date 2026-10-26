import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../src/generated/prisma/client.ts";
import { createVoucherAdminService } from "../../src/commerce/voucher-admin-service.ts";
import { createVoucherHoldService, voucherAttemptKey, type VoucherHoldGrant } from "../../src/commerce/voucher-hold-service.ts";
import { createVoucherFixtures } from "../support/voucher-fixtures.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const SHOP = 940_007;
const SECRET = "voucher-hold-test-secret-0123456789abcdef";
const f = createVoucherFixtures(prisma, SHOP, "vchr-hold");
const ENV = { LA_VOUCHER_ENABLED: "true", LA_PANCAKE_VOUCHER_VERIFIED_SHOP_IDS: String(SHOP) };
const holds = createVoucherHoldService(prisma, { attemptSecret: SECRET, env: ENV });
const admin = { user: { id: "voucher-hold-admin", role: "ADMIN" }, session: { id: "voucher-hold-session" } };
const adminService = createVoucherAdminService(prisma, SHOP);
const DIGEST_A = f.hex("quote-a");
const DIGEST_B = f.hex("quote-b");
const MIN = 60_000;
let cartCounter = 0;
const cartIds: string[] = [];

async function cart(paidRevision = 0) {
  const id = `vchr-hold-cart-${process.pid}-${(cartCounter += 1)}`;
  cartIds.push(id);
  await prisma.cart.create({ data: { id, expiresAt: new Date(Date.now() + 86_400_000), paidRevision: BigInt(paidRevision) } });
  return id;
}
const key = (cartId: string) => voucherAttemptKey(cartId, SECRET);
const merch = (c: { id: string; revision: number }, discountVnd = 30_000): VoucherHoldGrant => ({ kind: "MERCHANDISE", campaignId: c.id, campaignRevision: c.revision, discountVnd });
const ship = (c: { id: string; revision: number }, discountVnd = 30_000): VoucherHoldGrant => ({ kind: "SHIPPING_FREE", campaignId: c.id, campaignRevision: c.revision, discountVnd });
const request = (cartId: string, grants: VoucherHoldGrant[], extra: Record<string, unknown> = {}) => ({ shopId: SHOP, cartId, paidRevision: 0, quoteDigest: DIGEST_A, grants, ...extra });
const ledger = (id: string) => prisma.voucherCampaign.findUniqueOrThrow({ where: { id } });

async function cleanAll() {
  await f.cleanup();
  await prisma.cart.deleteMany({ where: { id: { in: cartIds } } });
}
test.before(cleanAll);
test.after(async () => {
  await cleanAll();
  await prisma.$disconnect();
});
test.beforeEach(cleanAll);

/** Counters must always equal what the live holds say; the strongest invariant of the whole service. */
async function assertLedgerConsistent(campaignId: string) {
  const c = await ledger(campaignId);
  const live = await prisma.voucherHold.findMany({ where: { campaignId, state: "HELD" } });
  assert.equal(c.reservedUses, live.length, "reservedUses == live holds");
  assert.equal(c.reservedVnd, live.reduce((sum, h) => sum + h.heldDiscountVnd, BigInt(0)), "reservedVnd == sum of live holds");
  if (c.maxUses !== null) assert.ok(c.redeemedUses + c.reservedUses <= c.maxUses);
  if (c.maxBudgetVnd !== null) assert.ok(c.redeemedVnd + c.reservedVnd <= c.maxBudgetVnd);
}

test("one call holds both groups atomically with a database-clock 10-minute expiry; the cart id is not stored", async () => {
  const m = await f.campaign();
  const s = await f.shippingCampaign();
  const cartId = await cart();
  const result = await holds.hold(request(cartId, [merch(m), ship(s)]));
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.deepEqual(result.holds.map((h) => [h.kind, h.reused, h.heldDiscountVnd]), [["MERCHANDISE", false, 30_000], ["SHIPPING_FREE", false, 30_000]]);
  for (const h of result.holds) assert.equal(h.expiresAt.getTime() - h.createdAt.getTime(), 10 * MIN);
  const rows = await prisma.voucherHold.findMany({ where: { campaignId: { in: [m.id, s.id] } } });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.attemptKey === key(cartId) && !JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? String(v) : v)).includes(cartId)));
  assert.equal((await ledger(m.id)).reservedUses, 1);
  assert.equal((await ledger(s.id)).reservedVnd, BigInt(30_000));
  assert.ok(Math.abs(rows[0]!.createdAt.getTime() - Date.now()) < 5_000, "created from the database clock, close to now");
});

test("AC-16/AC-33: reload and a second tab return the same hold and the SAME expiry; nothing is extended or double counted", async () => {
  const m = await f.campaign({ maxUses: 5 });
  const cartId = await cart();
  const first = await holds.hold(request(cartId, [merch(m)]));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const [again, parallel] = await Promise.all([holds.hold(request(cartId, [merch(m)])), holds.hold(request(cartId, [merch(m)]))]);
  assert.ok(first.ok && again.ok && parallel.ok);
  if (!first.ok || !again.ok || !parallel.ok) return;
  for (const r of [again, parallel]) {
    assert.equal(r.holds[0]!.holdId, first.holds[0]!.holdId);
    assert.equal(r.holds[0]!.expiresAt.getTime(), first.holds[0]!.expiresAt.getTime());
    assert.equal(r.holds[0]!.reused, true);
  }
  assert.equal((await ledger(m.id)).reservedUses, 1);
  assert.equal(await prisma.voucherHold.count({ where: { campaignId: m.id } }), 1);
  await assertLedgerConsistent(m.id);
});

test("AC-34: a changed quote swaps the hold (old RELEASED, new HELD, ledger net unchanged), with a fresh 10-minute window", async () => {
  const m = await f.campaign({ maxUses: 1 });
  const cartId = await cart();
  const first = await holds.hold(request(cartId, [merch(m)]));
  assert.ok(first.ok);
  if (!first.ok) return;
  await new Promise((resolve) => setTimeout(resolve, 30));
  // The same campaign is full (1/1), but the capacity is this attempt's own, so the swap is allowed.
  const swapped = await holds.hold(request(cartId, [merch(m, 25_000)], { quoteDigest: DIGEST_B }));
  assert.ok(swapped.ok, JSON.stringify(swapped));
  if (!swapped.ok) return;
  assert.notEqual(swapped.holds[0]!.holdId, first.holds[0]!.holdId);
  assert.equal(swapped.holds[0]!.heldDiscountVnd, 25_000);
  assert.deepEqual(swapped.released, ["MERCHANDISE"]);
  const states = await prisma.voucherHold.findMany({ where: { campaignId: m.id }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(states.map((h) => h.state), ["RELEASED", "HELD"]);
  assert.equal((await ledger(m.id)).reservedUses, 1);
  assert.equal((await ledger(m.id)).reservedVnd, BigInt(25_000));
  await assertLedgerConsistent(m.id);
});

test("AC-34: a swap whose new voucher is unavailable keeps the old hold, and the whole call changes nothing (both groups)", async () => {
  const m = await f.campaign({ maxUses: 5 });
  const s = await f.shippingCampaign({ maxUses: 5 });
  const full = await f.shippingCampaign({ maxUses: 1, reservedUses: 1, reservedVnd: BigInt(30_000) });
  await f.hold(full.id, { kind: "SHIPPING_FREE", heldDiscountVnd: BigInt(30_000) });
  const cartId = await cart();
  const first = await holds.hold(request(cartId, [merch(m), ship(s)]));
  assert.ok(first.ok);
  if (!first.ok) return;
  // New quote: merchandise would change to 20K (fine) but shipping moves to the FULL campaign (refused).
  const refused = await holds.hold(request(cartId, [merch(m, 20_000), ship(full)], { quoteDigest: DIGEST_B }));
  assert.deepEqual(refused, { ok: false, reason: "CAPACITY_EXHAUSTED", kind: "SHIPPING_FREE", campaignId: full.id });
  const live = await prisma.voucherHold.findMany({ where: { campaignId: { in: [m.id, s.id] }, state: "HELD" } });
  assert.deepEqual(live.map((h) => [h.kind, Number(h.heldDiscountVnd), h.quoteDigest]).sort(), [["MERCHANDISE", 30_000, DIGEST_A], ["SHIPPING_FREE", 30_000, DIGEST_A]]);
  assert.equal(await prisma.voucherHold.count({ where: { state: "RELEASED", campaign: { pancakeShopId: SHOP } } }), 0);
  await assertLedgerConsistent(m.id);
  await assertLedgerConsistent(s.id);
});

test("quota = 1 with simultaneous grants from different carts: exactly one wins and the ledger is exact", async () => {
  const m = await f.campaign({ maxUses: 1 });
  const carts = await Promise.all([cart(), cart(), cart(), cart(), cart(), cart()]);
  const results = await Promise.all(carts.map((cartId) => holds.hold(request(cartId, [merch(m)]))));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.ok(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "CAPACITY_EXHAUSTED"));
  assert.equal((await ledger(m.id)).reservedUses, 1);
  await assertLedgerConsistent(m.id);
});

test("budget exhaustion: the second grant that would pass the VND cap is refused, a smaller one still fits", async () => {
  const m = await f.campaign({ maxBudgetVnd: BigInt(50_000) });
  const [a, b, c] = await Promise.all([cart(), cart(), cart()]);
  assert.equal((await holds.hold(request(a, [merch(m, 30_000)]))).ok, true);
  const over = await holds.hold(request(b, [merch(m, 30_000)]));
  assert.deepEqual(over, { ok: false, reason: "CAPACITY_EXHAUSTED", kind: "MERCHANDISE", campaignId: m.id });
  assert.equal((await holds.hold(request(c, [merch(m, 20_000)]))).ok, true);
  await assertLedgerConsistent(m.id);
});

test("crossed pairs from two carts never deadlock and never oversubscribe (ascending lock order)", async () => {
  const m1 = await f.campaign({ maxUses: 1 });
  const m2 = await f.shippingCampaign({ maxUses: 1 });
  for (let round = 0; round < 6; round += 1) {
    const [a, b] = await Promise.all([cart(), cart()]);
    // Same pair, requested in opposite orders.
    const results = await Promise.all([holds.hold(request(a, [merch(m1), ship(m2)])), holds.hold(request(b, [ship(m2), merch(m1)]))]);
    assert.equal(results.filter((r) => r.ok).length, 1, `round ${round}`);
    await prisma.voucherHold.updateMany({ where: { campaignId: { in: [m1.id, m2.id] }, state: "HELD" }, data: { state: "RELEASED", releasedAt: new Date() } });
    await prisma.voucherCampaign.updateMany({ where: { id: { in: [m1.id, m2.id] } }, data: { reservedUses: 0, reservedVnd: BigInt(0) } });
  }
});

test("lazy expiry: a hold due at T+10 stops counting at the next grant, without any sweeper", async () => {
  const m = await f.campaign({ maxUses: 1, reservedUses: 1, reservedVnd: BigInt(30_000) });
  const created = new Date(Date.now() - 11 * MIN);
  const stale = await f.hold(m.id, { createdAt: created, expiresAt: new Date(created.getTime() + 10 * MIN) });
  const result = await holds.hold(request(await cart(), [merch(m)]));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((await prisma.voucherHold.findUniqueOrThrow({ where: { id: stale.id } })).state, "EXPIRED");
  assert.equal((await ledger(m.id)).reservedUses, 1, "the expired use went back; exactly one new use is held");
  await assertLedgerConsistent(m.id);
});

test("T+5: a 5-minute-old hold still counts and is not extended; T+10: it is gone", async () => {
  const m = await f.campaign({ maxUses: 1, reservedUses: 1, reservedVnd: BigInt(30_000) });
  const cartId = await cart();
  const fiveMinutes = new Date(Date.now() - 5 * MIN);
  await f.hold(m.id, { attemptKey: key(cartId), quoteDigest: DIGEST_A, paidRevision: BigInt(0), createdAt: fiveMinutes, expiresAt: new Date(fiveMinutes.getTime() + 10 * MIN) });
  const other = await holds.hold(request(await cart(), [merch(m)]));
  assert.deepEqual(other, { ok: false, reason: "CAPACITY_EXHAUSTED", kind: "MERCHANDISE", campaignId: m.id });
  const own = await holds.hold(request(cartId, [merch(m)]));
  assert.ok(own.ok && own.holds[0]!.reused && own.holds[0]!.expiresAt.getTime() === fiveMinutes.getTime() + 10 * MIN, "own hold reused with its ORIGINAL expiry");

  const tenMinutes = new Date(Date.now() - 10 * MIN - 1_000);
  const cartTwo = await cart();
  const n = await f.campaign({ maxUses: 1, reservedUses: 1, reservedVnd: BigInt(30_000) });
  await f.hold(n.id, { attemptKey: key(cartTwo), createdAt: tenMinutes, expiresAt: new Date(tenMinutes.getTime() + 10 * MIN) });
  const facts = { cartId: cartTwo, kind: "MERCHANDISE" as const, campaignId: n.id, campaignRevision: 1, discountVnd: 30_000, quoteDigest: f.hex("q"), paidRevision: 1 };
  assert.equal(await holds.findHonourableHold(facts), null, "T+10: expired by the database clock");
});

test("D-3 self-held precedence: a campaign that ended at T+3 still honours the held entitlement at T+5, but grants nothing new", async () => {
  const cartId = await cart();
  const m = await f.campaign({ endsAt: new Date(Date.now() - 2 * MIN), startsAt: new Date(Date.now() - 60 * MIN), maxUses: 1, reservedUses: 1, reservedVnd: BigInt(30_000) });
  const createdAt = new Date(Date.now() - 5 * MIN);
  await f.hold(m.id, { attemptKey: key(cartId), createdAt, expiresAt: new Date(createdAt.getTime() + 10 * MIN) });
  const facts = { cartId, kind: "MERCHANDISE" as const, campaignId: m.id, campaignRevision: 1, discountVnd: 30_000, quoteDigest: f.hex("q"), paidRevision: 1 };
  assert.ok(await holds.findHonourableHold(facts), "ended campaign, live hold: honoured");
  assert.equal(await holds.findHonourableHold({ ...facts, discountVnd: 29_999 }), null, "any changed fact is a re-quote");
  assert.equal(await holds.findHonourableHold({ ...facts, campaignRevision: 2 }), null);
  assert.equal(await holds.findHonourableHold({ ...facts, cartId: await cart() }), null, "another cart's hold is never honoured");
  const fresh = await holds.hold(request(await cart(), [merch(m)]));
  assert.deepEqual(fresh, { ok: false, reason: "CAMPAIGN_NOT_ACTIVE", kind: "MERCHANDISE", campaignId: m.id });
});

test("AC-45: cap edits racing hold grants never leave the ledger over a cap, never cut under live holds", async () => {
  for (let round = 0; round < 6; round += 1) {
    const m = await f.campaign({ maxUses: 6, maxBudgetVnd: BigInt(1_000_000) });
    const carts = await Promise.all([cart(), cart(), cart(), cart()]);
    const form = {
      name: "Race", kind: "MERCHANDISE", issuance: "AUTO", visibility: "PUBLIC", discount: { type: "FIXED_AMOUNT_VND", amountVnd: 30_000 },
      minEligibleSubtotalVnd: 600_000, scope: { mode: "ALL_SHOP", excludeProductIds: [] }, maxUses: 2, maxBudgetVnd: 1_000_000,
    };
    const [edit, ...grants] = await Promise.all([
      adminService.edit(admin, m.id, m.revision, form, new Date()),
      ...carts.map((cartId) => holds.hold(request(cartId, [merch(m)]))),
    ]);
    const row = await ledger(m.id);
    assert.ok(row.redeemedUses + row.reservedUses <= (row.maxUses ?? Infinity), `round ${round}: over cap`);
    await assertLedgerConsistent(m.id);
    const granted = grants.filter((g) => g.ok).length;
    assert.equal(row.reservedUses, granted);
    if (edit.ok) {
      assert.equal(row.maxUses, 2);
      assert.ok(granted <= 2, "an edit that applied before the grants capped them (the rest saw the new revision or the new cap)");
    } else {
      assert.equal(edit.reason, "CAP_BELOW_COMMITTED", "an edit that lost the race was refused at the committed floor");
      assert.equal(row.maxUses, 6);
      assert.ok(granted >= 3, "the floor that refused it is the live holds");
    }
    for (const g of grants) if (!g.ok) assert.ok(["CAPACITY_EXHAUSTED", "CAMPAIGN_CHANGED"].includes(g.reason), g.reason);
  }
});

test("releasing a group returns its use and VND; releasing something not held is a no-op", async () => {
  const m = await f.campaign({ maxUses: 5 });
  const s = await f.shippingCampaign({ maxUses: 5 });
  const cartId = await cart();
  assert.ok((await holds.hold(request(cartId, [merch(m), ship(s)]))).ok);
  const released = await holds.hold({ shopId: SHOP, cartId, paidRevision: 0, quoteDigest: DIGEST_A, grants: [], releaseKinds: ["SHIPPING_FREE"] });
  assert.deepEqual(released.ok && released.released, ["SHIPPING_FREE"]);
  assert.equal((await ledger(s.id)).reservedUses, 0);
  assert.equal((await ledger(m.id)).reservedUses, 1);
  const again = await holds.hold({ shopId: SHOP, cartId, paidRevision: 0, quoteDigest: DIGEST_A, grants: [], releaseKinds: ["SHIPPING_FREE"] });
  assert.deepEqual(again.ok && again.released, []);
  await assertLedgerConsistent(m.id);
  await assertLedgerConsistent(s.id);
});

test("refusals: changed cart revision, unknown/foreign/wrong-kind campaign, edited campaign, disabled campaign, bad input", async () => {
  const m = await f.campaign({ maxUses: 5 });
  const cartId = await cart(3);
  assert.deepEqual(await holds.hold(request(cartId, [merch(m)])), { ok: false, reason: "CART_CHANGED", kind: null, campaignId: null });
  const ok = (extra: Record<string, unknown> = {}) => ({ ...request(cartId, [merch(m)]), paidRevision: 3, ...extra });
  assert.deepEqual(await holds.hold(ok({ cartId: "no-such-cart" })), { ok: false, reason: "CART_NOT_FOUND", kind: null, campaignId: null });
  assert.equal((await holds.hold(ok({ grants: [{ ...merch(m), campaignId: "nope" }] }))).ok, false);
  assert.deepEqual(await holds.hold(ok({ grants: [{ ...merch(m), campaignRevision: 9 }] })), { ok: false, reason: "CAMPAIGN_CHANGED", kind: "MERCHANDISE", campaignId: m.id });
  assert.deepEqual(await holds.hold(ok({ grants: [{ ...merch(m), kind: "SHIPPING_FREE" }] })), { ok: false, reason: "CAMPAIGN_NOT_FOUND", kind: "SHIPPING_FREE", campaignId: m.id });
  await prisma.voucherCampaign.update({ where: { id: m.id }, data: { isEnabled: false, disabledAt: new Date() } });
  assert.deepEqual(await holds.hold(ok()), { ok: false, reason: "CAMPAIGN_NOT_ACTIVE", kind: "MERCHANDISE", campaignId: m.id });
  for (const bad of [{ quoteDigest: "short" }, { grants: [merch(m), merch(m)] }, { grants: [{ ...merch(m), discountVnd: 0 }] }, { grants: [{ ...merch(m), discountVnd: 1.5 }] }, { grants: [] }, { shopId: 0 }]) {
    assert.deepEqual(await holds.hold(ok(bad)), { ok: false, reason: "INVALID_REQUEST", kind: null, campaignId: null }, JSON.stringify(bad));
  }
  assert.equal(await prisma.voucherHold.count({ where: { campaign: { pancakeShopId: SHOP } } }), 0, "no refusal left a hold");
  assert.equal((await ledger(m.id)).reservedUses, 0);
});

test("D-6 gate: feature off or shop not verified grants nothing; release and the honour read still work with the feature off", async () => {
  const m = await f.campaign({ maxUses: 5 });
  const cartId = await cart();
  const off = createVoucherHoldService(prisma, { attemptSecret: SECRET, env: {} });
  assert.deepEqual(await off.hold(request(cartId, [merch(m)])), { ok: false, reason: "FEATURE_DISABLED", kind: null, campaignId: null });
  const unverified = createVoucherHoldService(prisma, { attemptSecret: SECRET, env: { LA_VOUCHER_ENABLED: "true" } });
  assert.deepEqual(await unverified.hold(request(cartId, [merch(m)])), { ok: false, reason: "SHOP_NOT_VERIFIED", kind: null, campaignId: null });
  const otherShop = createVoucherHoldService(prisma, { attemptSecret: SECRET, env: { LA_VOUCHER_ENABLED: "true", LA_PANCAKE_VOUCHER_VERIFIED_SHOP_IDS: "1,2" } });
  assert.equal((await otherShop.hold(request(cartId, [merch(m)]))).ok, false);
  assert.equal(await prisma.voucherHold.count({ where: { campaign: { pancakeShopId: SHOP } } }), 0);

  assert.ok((await holds.hold(request(cartId, [merch(m)]))).ok);
  const released = await off.hold({ shopId: SHOP, cartId, paidRevision: 0, quoteDigest: DIGEST_A, grants: [], releaseKinds: ["MERCHANDISE"] });
  assert.deepEqual(released.ok && released.released, ["MERCHANDISE"], "settling is not gated");
});

test("the sweeper expires only due holds, returns their uses once, and is idempotent", async () => {
  const m = await f.campaign({ maxUses: 5, reservedUses: 2, reservedVnd: BigInt(60_000) });
  const old = new Date(Date.now() - 12 * MIN);
  await f.hold(m.id, { createdAt: old, expiresAt: new Date(old.getTime() + 10 * MIN) });
  await f.hold(m.id);
  assert.equal(await holds.sweepExpired(), 1);
  assert.equal(await holds.sweepExpired(), 0);
  const row = await ledger(m.id);
  assert.equal(row.reservedUses, 1);
  assert.equal(row.reservedVnd, BigInt(30_000));
  await assertLedgerConsistent(m.id);
});
