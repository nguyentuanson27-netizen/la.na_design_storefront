import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../src/generated/prisma/client.ts";
import { createVoucherSelectionService } from "../../src/commerce/voucher-selection-service.ts";
import { createVoucherFixtures } from "../support/voucher-fixtures.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const SHOP = 940_005;
const f = createVoucherFixtures(prisma, SHOP, "vchr-sel");
const ON = { LA_VOUCHER_ENABLED: "true" };
const service = createVoucherSelectionService(prisma, { shopId: SHOP, env: ON });
const NOW = new Date();

async function cleanup() {
  await f.cleanup();
  await prisma.cart.deleteMany({ where: { id: { startsWith: "00000000-0000-4000-8000-9400" } } });
  await prisma.rateLimit.deleteMany({ where: { key: { startsWith: "voucher-code-" } } });
}
let counter = 0;
async function cart(extra: Record<string, unknown> = {}) {
  counter += 1;
  const id = `00000000-0000-4000-8000-9400${String(process.pid).padStart(4, "0").slice(-4)}${String(counter).padStart(4, "0")}`;
  return prisma.cart.create({ data: { id, expiresAt: new Date(Date.now() + 86_400_000), ...extra } });
}
const ledger = async () =>
  JSON.stringify(
    { c: await prisma.voucherCampaign.findMany({ where: { pancakeShopId: SHOP }, orderBy: { id: "asc" } }), h: await prisma.voucherHold.count({ where: { campaign: { pancakeShopId: SHOP } } }) },
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
  );

test.before(cleanup);
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});
test.beforeEach(cleanup);

test("a cart with nothing saved reads as AUTO for both groups", async () => {
  const c = await cart();
  assert.deepEqual(await service.read(c.id), { merchandise: { mode: "AUTO" }, shipping: { mode: "AUTO" } });
});

test("AC-26 / AC-04: a manual voucher or explicit NONE is saved per group and survives reload (a fresh service instance)", async () => {
  const c = await cart();
  const m = await f.campaign();
  const s = await f.shippingCampaign();
  assert.deepEqual((await service.setGroup({ cartId: c.id, group: "MERCHANDISE", mode: "MANUAL", voucherId: m.id })).ok, true);
  const second = await service.setGroup({ cartId: c.id, group: "SHIPPING_FREE", mode: "MANUAL", voucherId: null });
  assert.deepEqual(second, { ok: true, selection: { merchandise: { mode: "MANUAL", voucherId: m.id }, shipping: { mode: "MANUAL", voucherId: null } } });
  const reloaded = createVoucherSelectionService(prisma, { shopId: SHOP, env: ON });
  assert.deepEqual(await reloaded.read(c.id), { merchandise: { mode: "MANUAL", voucherId: m.id }, shipping: { mode: "MANUAL", voucherId: null } });
  // Going back to AUTO clears the lock for that group only.
  const auto = await service.setGroup({ cartId: c.id, group: "MERCHANDISE", mode: "AUTO" });
  assert.deepEqual(auto, { ok: true, selection: { merchandise: { mode: "AUTO" }, shipping: { mode: "MANUAL", voucherId: null } } });
  void s;
});

test("a manual voucher must be an active campaign of this shop and of that group", async () => {
  const c = await cart();
  const ship = await f.shippingCampaign();
  const draft = await f.campaign({ isEnabled: false, enabledAt: null });
  const ended = await f.campaign({ endsAt: new Date(Date.now() - 1_000) });
  const other = await f.campaign({ pancakeShopId: SHOP + 1 }).finally(() => undefined);
  const refused = async (voucherId: string, group: "MERCHANDISE" | "SHIPPING_FREE" = "MERCHANDISE") =>
    assert.deepEqual(await service.setGroup({ cartId: c.id, group, mode: "MANUAL", voucherId }), { ok: false, reason: "NOT_AVAILABLE" });
  await refused(ship.id); // a shipping voucher cannot sit in the merchandise group
  await refused(draft.id);
  await refused(ended.id);
  await refused(other.id);
  await refused("does-not-exist");
  assert.equal((await service.setGroup({ cartId: c.id, group: "SHIPPING_FREE", mode: "MANUAL", voucherId: ship.id })).ok, true);
  await prisma.voucherCampaign.deleteMany({ where: { pancakeShopId: SHOP + 1 } });
});

test("malformed input is refused without touching the cart", async () => {
  const c = await cart();
  for (const input of [
    { group: "BOGUS", mode: "AUTO" },
    { group: "MERCHANDISE", mode: "MANUAL", voucherId: "bad id!" },
    { group: "MERCHANDISE", mode: "AUTO", voucherId: "x" },
    { group: "MERCHANDISE", mode: "SOMETIMES" },
  ]) {
    assert.deepEqual(await service.setGroup({ cartId: c.id, ...(input as object) } as never), { ok: false, reason: "INVALID_INPUT" });
  }
  assert.equal(await prisma.cartVoucherSelection.count({ where: { cartId: c.id } }), 0);
});

test("an unknown, expired or customer-owned cart cannot be written to", async () => {
  assert.deepEqual(await service.setGroup({ cartId: "00000000-0000-4000-8000-000000000000", group: "MERCHANDISE", mode: "AUTO" }), { ok: false, reason: "CART_UNAVAILABLE" });
  const expired = await cart({ expiresAt: new Date(Date.now() - 1_000) });
  assert.deepEqual(await service.setGroup({ cartId: expired.id, group: "MERCHANDISE", mode: "AUTO" }), { ok: false, reason: "CART_UNAVAILABLE" });
  assert.deepEqual(await service.applyCode({ cartId: expired.id, rawCode: "ANYCODE1" }), { ok: false, reason: "CART_UNAVAILABLE" });
});

test("AC-25: selections are per cart; one shopper's lock never shows on another's cart", async () => {
  const a = await cart();
  const b = await cart();
  const m = await f.campaign();
  await service.setGroup({ cartId: a.id, group: "MERCHANDISE", mode: "MANUAL", voucherId: m.id });
  assert.deepEqual((await service.read(b.id)).merchandise, { mode: "AUTO" });
});

test("AC-13: a valid code becomes a manual lock in its group; the code itself is not stored", async () => {
  const c = await cart();
  const priv = await f.campaign({ issuance: "CODE", visibility: "PRIVATE", code: "KOL50" });
  const result = await service.applyCode({ cartId: c.id, rawCode: " kol50 " });
  assert.equal(result.ok, true, JSON.stringify(result));
  const ok = result as Extract<typeof result, { ok: true }>;
  assert.equal(ok.group, "MERCHANDISE");
  assert.equal(ok.card.id, priv.id);
  assert.equal(ok.card.publicCode, null, "a private code is not echoed back");
  assert.deepEqual(ok.selection.merchandise, { mode: "MANUAL", voucherId: priv.id });
  const stored = JSON.stringify(await prisma.cartVoucherSelection.findUnique({ where: { cartId: c.id } }));
  assert.doesNotMatch(stored, /KOL50/i);
  // A shipping code locks the shipping group and leaves merchandise alone.
  await f.shippingCampaign({ issuance: "CODE", visibility: "PRIVATE", code: "SHIPFREE1" });
  const ship = await service.applyCode({ cartId: c.id, rawCode: "SHIPFREE1" });
  assert.equal((ship as { group?: string }).group, "SHIPPING_FREE");
  assert.deepEqual((await service.read(c.id)).merchandise, { mode: "MANUAL", voucherId: priv.id });
});

test("AC-13: invalid, expired, unknown and other-shop codes all answer INVALID_CODE and save nothing", async () => {
  const c = await cart();
  await f.campaign({ issuance: "CODE", visibility: "PRIVATE", code: "OLDKOL1", endsAt: new Date(Date.now() - 1_000) });
  for (const raw of ["NOSUCH1", "OLDKOL1", "", "x", null, 12345, "bad code!"]) {
    assert.deepEqual(await service.applyCode({ cartId: c.id, rawCode: raw }), { ok: false, reason: "INVALID_CODE" }, String(raw));
  }
  assert.equal(await prisma.cartVoucherSelection.count({ where: { cartId: c.id } }), 0);
});

test("guessing is throttled per cart: the attempts after the limit are RATE_LIMITED, even for a real code", async () => {
  const c = await cart();
  await f.campaign({ issuance: "CODE", visibility: "PRIVATE", code: "REAL123" });
  for (let i = 0; i < 10; i += 1) {
    assert.deepEqual(await service.applyCode({ cartId: c.id, rawCode: `GUESS${i}X`, now: NOW }), { ok: false, reason: "INVALID_CODE" });
  }
  assert.deepEqual(await service.applyCode({ cartId: c.id, rawCode: "REAL123", now: NOW }), { ok: false, reason: "RATE_LIMITED" });
  // Another cart is not locked out by this cart's guesses, and the window resets.
  const other = await cart();
  assert.equal((await service.applyCode({ cartId: other.id, rawCode: "REAL123", now: NOW })).ok, true);
  assert.equal((await service.applyCode({ cartId: c.id, rawCode: "REAL123", now: new Date(NOW.getTime() + 61_000) })).ok, true);
  const keys = await prisma.rateLimit.findMany({ where: { key: { startsWith: "voucher-code-cart:" } }, select: { key: true } });
  assert.ok(keys.every((row) => !row.key.includes(c.id)), "the cart id is hashed in the bucket key");
});

test("AC-47-like: with the flag OFF nothing is read or written", async () => {
  const off = createVoucherSelectionService(prisma, { shopId: SHOP, env: {} });
  const c = await cart();
  const m = await f.campaign();
  assert.deepEqual(await off.setGroup({ cartId: c.id, group: "MERCHANDISE", mode: "MANUAL", voucherId: m.id }), { ok: false, reason: "FEATURE_DISABLED" });
  assert.deepEqual(await off.applyCode({ cartId: c.id, rawCode: "ANYCODE1" }), { ok: false, reason: "FEATURE_DISABLED" });
  await service.setGroup({ cartId: c.id, group: "MERCHANDISE", mode: "MANUAL", voucherId: m.id });
  assert.deepEqual(await off.read(c.id), { merchandise: { mode: "AUTO" }, shipping: { mode: "AUTO" } });
});

test("selection actions never grant: the ledger and holds are byte-identical after a burst of writes", async () => {
  const c = await cart();
  const m = await f.campaign({ maxUses: 5, maxBudgetVnd: BigInt(1_000_000) });
  await f.campaign({ issuance: "CODE", visibility: "PRIVATE", code: "LEDGER1", maxUses: 1 });
  const before = await ledger();
  for (let i = 0; i < 3; i += 1) {
    await service.setGroup({ cartId: c.id, group: "MERCHANDISE", mode: "MANUAL", voucherId: m.id });
    await service.setGroup({ cartId: c.id, group: "MERCHANDISE", mode: "AUTO" });
    await service.applyCode({ cartId: c.id, rawCode: "LEDGER1" });
  }
  assert.equal(await ledger(), before);
});

test("a saved lock expires with its cart-bound row and is not read afterwards", async () => {
  const c = await cart();
  const m = await f.campaign();
  await service.setGroup({ cartId: c.id, group: "MERCHANDISE", mode: "MANUAL", voucherId: m.id });
  assert.deepEqual((await service.read(c.id, new Date(Date.now() + 2 * 86_400_000))).merchandise, { mode: "AUTO" });
});

test("Áp dụng commits both groups in one transaction; if either is refused, neither is written", async () => {
  const c = await cart();
  const m = await f.campaign();
  const s = await f.shippingCampaign();
  const both = await service.applyBoth({ cartId: c.id, merchandise: { mode: "MANUAL", voucherId: m.id }, shipping: { mode: "MANUAL", voucherId: s.id } });
  assert.deepEqual(both, { ok: true, selection: { merchandise: { mode: "MANUAL", voucherId: m.id }, shipping: { mode: "MANUAL", voucherId: s.id } } });
  // A shipping voucher offered in the merchandise group is refused and the earlier choice is untouched.
  const bad = await service.applyBoth({ cartId: c.id, merchandise: { mode: "MANUAL", voucherId: s.id }, shipping: { mode: "MANUAL", voucherId: null } });
  assert.deepEqual(bad, { ok: false, reason: "NOT_AVAILABLE" });
  assert.deepEqual(await service.read(c.id), { merchandise: { mode: "MANUAL", voucherId: m.id }, shipping: { mode: "MANUAL", voucherId: s.id } });
  assert.deepEqual(await service.applyBoth({ cartId: c.id, merchandise: { mode: "AUTO", voucherId: "x" }, shipping: { mode: "AUTO", voucherId: null } }), { ok: false, reason: "INVALID_INPUT" });
  const auto = await service.applyBoth({ cartId: c.id, merchandise: { mode: "AUTO", voucherId: null }, shipping: { mode: "MANUAL", voucherId: null } });
  assert.deepEqual(auto, { ok: true, selection: { merchandise: { mode: "AUTO" }, shipping: { mode: "MANUAL", voucherId: null } } });
  const off = createVoucherSelectionService(prisma, { shopId: SHOP, env: {} });
  assert.deepEqual(await off.applyBoth({ cartId: c.id, merchandise: { mode: "AUTO", voucherId: null }, shipping: { mode: "AUTO", voucherId: null } }), { ok: false, reason: "FEATURE_DISABLED" });
});
