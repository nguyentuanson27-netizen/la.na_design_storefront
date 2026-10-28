import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../src/generated/prisma/client.ts";
import { createVoucherHoldService, voucherAttemptKey, type VoucherHoldGrant } from "../../src/commerce/voucher-hold-service.ts";
import { readTypeTiers } from "../../src/commerce/voucher-candidate-repository.ts";
import { createVoucherSelectionService } from "../../src/commerce/voucher-selection-service.ts";
import { selectionVersionOf } from "../../src/commerce/voucher-selection-version.ts";
import { createVoucherFixtures } from "../support/voucher-fixtures.ts";

/**
 * ADR 0020 against a real database: the type/tier schema and its triggers, the slot as the unit of "only one" for holds
 * and redemptions, the hold service over several slots, and the cart-bound selection of types (including a type code).
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const SHOP = 940_032;
const P = "vchr-types";
const SECRET = "voucher-types-test-secret-0123456789abcdef";
const ON = { LA_VOUCHER_ENABLED: "true", LA_PANCAKE_VOUCHER_VERIFIED_SHOP_IDS: String(SHOP) } as const;
const f = createVoucherFixtures(prisma, SHOP, P);
const holds = createVoucherHoldService(prisma, { attemptSecret: SECRET, env: ON });
const selection = createVoucherSelectionService(prisma, { shopId: SHOP, env: ON, rateLimiter: { consume: async () => true } as never });
const DIGEST = f.hex("digest");
const NOW = new Date();

async function cleanup() {
  await f.cleanup();
  // The accepted order of the redemption test is append-only by design, so its fixture rows go with triggers suspended.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    const orders = (await tx.orderMirror.findMany({ where: { pancakeShopId: SHOP }, select: { id: true } })).map((order) => order.id);
    await tx.orderAcceptance.deleteMany({ where: { orderId: { in: orders } } });
    const snapshots = (await tx.orderQuoteSnapshot.findMany({ where: { orderId: { in: orders } }, select: { id: true } })).map((snapshot) => snapshot.id);
    await tx.orderQuoteLine.deleteMany({ where: { snapshotId: { in: snapshots } } });
    await tx.orderQuoteSnapshot.deleteMany({ where: { orderId: { in: orders } } });
    await tx.orderMirror.deleteMany({ where: { id: { in: orders } } });
  });
  await prisma.cart.deleteMany({ where: { id: { startsWith: P } } });
}
test.before(cleanup);
test.beforeEach(cleanup);
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

async function cart() {
  return prisma.cart.create({ data: { id: `${P}-${f.token()}`, expiresAt: new Date(Date.now() + 86_400_000) } });
}
async function rejects(action: () => Promise<unknown>, pattern: RegExp) {
  await assert.rejects(action, (error: Error) => pattern.test(String(error.message)) || pattern.test(String((error as { cause?: { message?: string } }).cause?.message)));
}
const tierData = (extra: Record<string, unknown> = {}) => ({ fixedAmountVnd: BigInt(30_000), minEligibleSubtotalVnd: BigInt(500_000), maxUses: 5, maxBudgetVnd: BigInt(1_000_000), ...extra });
const grant = (slot: string, c: { id: string; revision: number }, discountVnd = 30_000): VoucherHoldGrant => ({ kind: slot === "SHIPPING_FREE" ? "SHIPPING_FREE" : "MERCHANDISE", slot, campaignId: c.id, campaignRevision: c.revision, discountVnd });
const request = (cartId: string, grants: readonly VoucherHoldGrant[], extra: Record<string, unknown> = {}) => ({ shopId: SHOP, cartId, paidRevision: 0, quoteDigest: DIGEST, grants, ...extra });

// --- schema and triggers ---------------------------------------------------------------------------------------------------

test("a tier belongs to a type of its own shop and copies the type's issuance and visibility", async () => {
  const type = await f.type({ issuance: "CODE", visibility: "PRIVATE", code: "LADDER1" });
  const tier = await f.tier(type.id, tierData({ issuance: "CODE", visibility: "PRIVATE" }));
  assert.equal(tier.code, null, "the type owns the code");
  // Disagreeing with the type, or carrying its own code, is refused by the database.
  await rejects(() => f.tier(type.id, tierData({ issuance: "AUTO", visibility: "PUBLIC" })), /issuance and visibility of its type|issuance_check/i);
  await rejects(() => f.tier(type.id, tierData({ issuance: "CODE", visibility: "PRIVATE", code: "OWNCODE1" })), /issuance_check|violates check/i);
  const autoType = await f.type();
  await rejects(() => f.tier(autoType.id, tierData({ issuance: "CODE", visibility: "PUBLIC" })), /issuance and visibility of its type/i);
  // A type of another shop cannot be used, and shipping has no type.
  const foreign = await prisma.voucherType.create({ data: { pancakeShopId: SHOP + 1, name: "foreign", priority: 1, issuance: "AUTO", visibility: "PUBLIC" } });
  try {
    await rejects(() => f.tier(foreign.id, tierData()), /same shop/i);
  } finally {
    await prisma.voucherType.delete({ where: { id: foreign.id } });
  }
  await rejects(() => f.shippingCampaign({ typeId: autoType.id }), /issuance_check|violates check/i);
});

test("a tier never changes type and a type with tiers keeps its distribution", async () => {
  const a = await f.type();
  const b = await f.type({ priority: 2 });
  const tier = await f.tier(a.id, tierData());
  await rejects(() => prisma.voucherCampaign.update({ where: { id: tier.id }, data: { typeId: b.id } }), /cannot change type/i);
  await rejects(() => prisma.voucherCampaign.update({ where: { id: tier.id }, data: { typeId: null } }), /cannot change type|issuance_check/i);
  await rejects(() => prisma.voucherType.update({ where: { id: a.id }, data: { issuance: "CODE", visibility: "PRIVATE", code: "NEWCODE1" } }), /keeps its shop, issuance and visibility/i);
  // The name and the priority are free to change.
  await prisma.voucherType.update({ where: { id: a.id }, data: { name: "Renamed", priority: 7 } });
  // A type without tiers can still change its distribution.
  await prisma.voucherType.update({ where: { id: b.id }, data: { issuance: "CODE", visibility: "PRIVATE", code: "FREECODE1" } });
});

test("one code namespace per shop: a code is a campaign's or a type's, never both", async () => {
  await f.campaign({ issuance: "CODE", visibility: "PRIVATE", code: "TAKEN001" });
  await rejects(() => f.type({ issuance: "CODE", visibility: "PRIVATE", code: "TAKEN001" }), /already used by a campaign/i);
  await f.type({ issuance: "CODE", visibility: "PRIVATE", code: "TYPECODE1" });
  await rejects(() => f.campaign({ issuance: "CODE", visibility: "PRIVATE", code: "TYPECODE1" }), /already used by a type/i);
  await rejects(() => f.type({ issuance: "CODE", visibility: "PRIVATE", code: "TYPECODE1" }), /unique|already used/i);
  // The same code in another shop is another namespace.
  const other = await prisma.voucherType.create({ data: { pancakeShopId: SHOP + 1, name: "other", priority: 1, issuance: "CODE", visibility: "PRIVATE", code: "TYPECODE1" } });
  await prisma.voucherType.delete({ where: { id: other.id } });
});

test("a type's own values are bounded: priority 1..1000, a CODE type needs a canonical code, AUTO is public with no code", async () => {
  await rejects(() => f.type({ priority: 0 }), /values_check|violates check/i);
  await rejects(() => f.type({ priority: 1001 }), /values_check|violates check/i);
  await rejects(() => f.type({ issuance: "CODE", visibility: "PRIVATE", code: "no" }), /issuance_check|violates check/i);
  await rejects(() => f.type({ issuance: "AUTO", visibility: "PRIVATE" }), /issuance_check|violates check/i);
  await rejects(() => f.type({ issuance: "AUTO", code: "SHOULDNOT" }), /issuance_check|violates check/i);
});

// --- slots -----------------------------------------------------------------------------------------------------------------

test("a hold's slot defaults to its campaign's slot; a wrong slot is refused", async () => {
  const type = await f.type();
  const typed = await f.tier(type.id, tierData());
  const untyped = await f.campaign();
  const ship = await f.shippingCampaign();
  assert.equal((await f.hold(typed.id)).slot, `MERCHANDISE:${type.id}`);
  assert.equal((await f.hold(untyped.id)).slot, "MERCHANDISE");
  assert.equal((await f.hold(ship.id, { kind: "SHIPPING_FREE" })).slot, "SHIPPING_FREE");
  await rejects(() => f.hold(typed.id, { slot: "MERCHANDISE" }), /slot of its campaign/i);
  await rejects(() => f.hold(typed.id, { slot: "SHIPPING_FREE" }), /slot_check|slot of its campaign/i);
});

test("one live hold per attempt and slot: two types hold side by side, a second tier of one type cannot", async () => {
  const a = await f.type();
  const b = await f.type({ priority: 2 });
  const a1 = await f.tier(a.id, tierData());
  const a2 = await f.tier(a.id, tierData({ fixedAmountVnd: BigInt(80_000), minEligibleSubtotalVnd: BigInt(1_000_000) }));
  const b1 = await f.tier(b.id, tierData());
  const attemptKey = f.hex("attempt-1");
  await f.hold(a1.id, { attemptKey });
  await f.hold(b1.id, { attemptKey });
  await rejects(() => f.hold(a2.id, { attemptKey }), /unique|live_attempt_slot/i);
  // Another attempt is not affected, and a released hold frees the slot.
  await f.hold(a2.id, { attemptKey: f.hex("attempt-2") });
  await prisma.voucherHold.updateMany({ where: { campaignId: a1.id, attemptKey }, data: { state: "RELEASED", releasedAt: new Date() } });
  await f.hold(a2.id, { attemptKey });
});

test("a redemption takes the slot of its hold, and an order holds at most one per slot", async () => {
  const a = await f.type();
  const b = await f.type({ priority: 2 });
  const a1 = await f.tier(a.id, tierData());
  const b1 = await f.tier(b.id, tierData());
  const quoteDigest = f.hex("q");
  const order = await prisma.orderMirror.create({
    data: { publicCode: f.token(), state: "DRAFT", pancakeShopId: SHOP, checkoutSnapshottedAt: NOW, guestName: "T", guestPhone: "0900000000", provinceRef: "p", communeRef: "c", addressDetail: "a", merchandiseSubtotalVnd: BigInt(100), shippingFeeVnd: BigInt(0), totalVnd: BigInt(100) },
  });
  await prisma.orderQuoteSnapshot.create({
    data: {
      orderId: order.id, quoteFormat: "laq3", quoteDigest, paidSubtotalVnd: BigInt(100), shippingFeeVnd: BigInt(0), totalVnd: BigInt(100), paidQuantity: 1, giftQuantity: 0, unclaimedSlots: 0, nonclaimAcknowledged: false,
      lines: { create: { lineId: "P:1", role: "PAID", variantId: "v", pancakeVariationId: "x", quantity: 1, unitPriceVnd: BigInt(100), lineTotalVnd: BigInt(100), fulfillmentState: "READY" } },
    } as never,
  });
  await prisma.orderAcceptance.create({ data: { orderId: order.id, quoteDigest, acceptedAt: NOW } });
  const consumed = async (campaignId: string) => {
    const h = await f.hold(campaignId, { attemptKey: f.hex(`k-${campaignId}`) });
    await prisma.voucherHold.update({ where: { id: h.id }, data: { state: "CONSUMED", consumedAt: new Date(), orderId: order.id } });
    return h;
  };
  const ha = await consumed(a1.id);
  const hb = await consumed(b1.id);
  const redeem = (holdId: string, campaignId: string, data: Record<string, unknown> = {}) =>
    prisma.voucherRedemption.create({ data: { campaignId, campaignRevision: 1, kind: "MERCHANDISE", orderId: order.id, holdId, amountVnd: BigInt(30_000), websiteAcceptedAt: NOW, ...data } as never });
  assert.equal((await redeem(ha.id, a1.id)).slot, `MERCHANDISE:${a.id}`);
  assert.equal((await redeem(hb.id, b1.id)).slot, `MERCHANDISE:${b.id}`, "a second merchandise redemption of the same order is fine in another slot");
  const a2 = await f.tier(a.id, tierData({ fixedAmountVnd: BigInt(80_000), minEligibleSubtotalVnd: BigInt(1_000_000) }));
  const hc = await consumed(a2.id);
  await rejects(() => redeem(hc.id, a2.id), /unique|orderId_slot/i);
  await rejects(() => redeem(hc.id, a2.id, { slot: "MERCHANDISE" }), /slot of its hold/i);
});

// --- the hold service over several slots -----------------------------------------------------------------------------------

test("holds for several slots are granted together, swapped inside a slot, and released when unlisted", async () => {
  const a = await f.type();
  const b = await f.type({ priority: 2 });
  const a1 = await f.tier(a.id, tierData());
  const a2 = await f.tier(a.id, tierData({ fixedAmountVnd: BigInt(80_000), minEligibleSubtotalVnd: BigInt(1_000_000) }));
  const b1 = await f.tier(b.id, tierData());
  const ship = await f.shippingCampaign({ maxUses: 5, maxBudgetVnd: BigInt(1_000_000) });
  const c = await cart();
  const slotA = `MERCHANDISE:${a.id}`;
  const slotB = `MERCHANDISE:${b.id}`;

  const first = await holds.hold(request(c.id, [grant(slotA, a1), grant(slotB, b1), grant("SHIPPING_FREE", ship)]));
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(first.ok && first.holds.map((h) => h.slot).sort(), [slotA, slotB, "SHIPPING_FREE"].sort());
  assert.deepEqual((await holds.readOwnLiveHolds(c.id)).map((h) => h.slot).sort(), [slotA, slotB, "SHIPPING_FREE"].sort());

  // The same request is idempotent: nothing is extended or double counted.
  const again = await holds.hold(request(c.id, [grant(slotA, a1), grant(slotB, b1), grant("SHIPPING_FREE", ship)]));
  assert.deepEqual(again.ok && again.holds.map((h) => h.reused), [true, true, true]);
  assert.equal((await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: a1.id } })).reservedUses, 1);

  // Swapping the A rung releases the old A hold and gives its use and VND back; B is untouched.
  const swapped = await holds.hold(request(c.id, [grant(slotA, a2, 80_000), grant(slotB, b1)]));
  assert.equal(swapped.ok, true, JSON.stringify(swapped));
  assert.deepEqual(swapped.ok && swapped.released, [slotA]);
  assert.deepEqual(await Promise.all([a1, a2, b1].map(async (x) => (await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: x.id } })).reservedUses)), [0, 1, 1]);
  assert.equal((await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: a2.id } })).reservedVnd, BigInt(80_000));

  // `releaseUnlisted` drops every slot the request no longer names (here shipping and B); an explicit slot release drops only that one.
  const onlyA = await holds.hold(request(c.id, [grant(slotA, a2, 80_000)], { releaseUnlisted: true }));
  assert.deepEqual(onlyA.ok && [...onlyA.released].sort(), [slotB, "SHIPPING_FREE"].sort());
  assert.deepEqual((await holds.readOwnLiveHolds(c.id)).map((h) => h.slot), [slotA]);
  const none = await holds.hold(request(c.id, [], { releaseSlots: [slotA] }));
  assert.deepEqual(none.ok && none.released, [slotA]);
  assert.deepEqual(await holds.readOwnLiveHolds(c.id), []);
  for (const x of [a1, a2, b1, ship]) assert.deepEqual((await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: x.id } })).reservedUses, 0);
});

test("all or nothing across slots: a slot that cannot be granted leaves the others, and the old holds, untouched", async () => {
  const a = await f.type();
  const b = await f.type({ priority: 2 });
  const a1 = await f.tier(a.id, tierData());
  const full = await f.tier(b.id, tierData({ maxUses: 1, redeemedUses: 1 }));
  const b1 = await f.tier(b.id, tierData());
  const c = await cart();
  const slotA = `MERCHANDISE:${a.id}`;
  const slotB = `MERCHANDISE:${b.id}`;
  const refused = await holds.hold(request(c.id, [grant(slotA, a1), grant(slotB, full)]));
  assert.deepEqual(refused, { ok: false, reason: "CAPACITY_EXHAUSTED", kind: "MERCHANDISE", campaignId: full.id });
  assert.deepEqual(await holds.readOwnLiveHolds(c.id), [], "A was not granted either");
  assert.equal((await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: a1.id } })).reservedUses, 0);

  assert.equal((await holds.hold(request(c.id, [grant(slotA, a1), grant(slotB, b1)]))).ok, true);
  const swapFails = await holds.hold(request(c.id, [grant(slotA, a1, 25_000), grant(slotB, full)]));
  assert.equal(swapFails.ok, false);
  assert.deepEqual((await holds.readOwnLiveHolds(c.id)).map((h) => [h.slot, h.heldDiscountVnd]).sort(), [[slotA, 30_000], [slotB, 30_000]].sort(), "the old holds are exactly as they were");
});

test("a grant must name its campaign's own slot and kind", async () => {
  const a = await f.type();
  const b = await f.type({ priority: 2 });
  const a1 = await f.tier(a.id, tierData());
  const c = await cart();
  assert.deepEqual(await holds.hold(request(c.id, [grant(`MERCHANDISE:${b.id}`, a1)])), { ok: false, reason: "CAMPAIGN_NOT_FOUND", kind: "MERCHANDISE", campaignId: a1.id });
  assert.deepEqual(await holds.hold(request(c.id, [grant("MERCHANDISE", a1)])), { ok: false, reason: "CAMPAIGN_NOT_FOUND", kind: "MERCHANDISE", campaignId: a1.id });
  for (const bad of [
    [grant(`MERCHANDISE:${a.id}`, a1), grant(`MERCHANDISE:${a.id}`, a1)],
    [{ ...grant(`MERCHANDISE:${a.id}`, a1), kind: "SHIPPING_FREE" as const }],
    [{ ...grant("SHIPPING_FREE", a1), kind: "MERCHANDISE" as const }],
    [{ ...grant("OTHER", a1) }],
  ]) assert.deepEqual(await holds.hold(request(c.id, bad)), { ok: false, reason: "INVALID_REQUEST", kind: null, campaignId: null });
  assert.deepEqual(await holds.hold(request(c.id, [grant(`MERCHANDISE:${a.id}`, a1)], { releaseSlots: [`MERCHANDISE:${a.id}`] })), { ok: false, reason: "INVALID_REQUEST", kind: null, campaignId: null }, "a slot is granted or released, not both");
  assert.equal(voucherAttemptKey(c.id, SECRET).length, 64);
});

test("the sweeper expires due holds of every slot and gives each campaign's use back", async () => {
  const a = await f.type();
  const b = await f.type({ priority: 2 });
  const a1 = await f.tier(a.id, tierData());
  const b1 = await f.tier(b.id, tierData());
  const c = await cart();
  assert.equal((await holds.hold(request(c.id, [grant(`MERCHANDISE:${a.id}`, a1), grant(`MERCHANDISE:${b.id}`, b1)]))).ok, true);
  await prisma.$executeRaw`SET LOCAL session_replication_role = replica`.catch(() => undefined);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    await tx.$executeRaw`UPDATE "VoucherHold" SET "createdAt" = "createdAt" - interval '11 minutes', "expiresAt" = "expiresAt" - interval '11 minutes' WHERE "campaignId" IN (${a1.id}, ${b1.id})`;
  });
  assert.equal(await holds.sweepExpired(), 2);
  for (const x of [a1, b1]) assert.deepEqual((await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: x.id } })).reservedUses, 0);
  assert.deepEqual(await holds.readOwnLiveHolds(c.id), []);
});

// --- selection of types ----------------------------------------------------------------------------------------------------

test("a typed slot is selected per cart; a tier only fits its own slot", async () => {
  const a = await f.type();
  const b = await f.type({ priority: 2 });
  const a1 = await f.tier(a.id, tierData());
  const b1 = await f.tier(b.id, tierData());
  const c = await cart();
  const slotA = `MERCHANDISE:${a.id}`;
  const slotB = `MERCHANDISE:${b.id}`;
  assert.deepEqual(await selection.setSlot({ cartId: c.id, slot: slotB, mode: "MANUAL", voucherId: a1.id }), { ok: false, reason: "NOT_AVAILABLE" }, "A's tier cannot sit in B's slot");
  assert.deepEqual(await selection.setSlot({ cartId: c.id, slot: "MERCHANDISE", mode: "MANUAL", voucherId: a1.id }), { ok: false, reason: "NOT_AVAILABLE" }, "nor in the untyped slot");
  assert.equal((await selection.setSlot({ cartId: c.id, slot: slotA, mode: "MANUAL", voucherId: a1.id })).ok, true);
  assert.equal((await selection.setSlot({ cartId: c.id, slot: slotB, mode: "MANUAL", voucherId: null })).ok, true);
  assert.deepEqual((await selection.read(c.id)).merchandise, { [slotA]: { mode: "MANUAL", voucherId: a1.id }, [slotB]: { mode: "MANUAL", voucherId: null } });
  void b1;
  // AUTO clears a slot; an AUTO slot that unlocks nothing leaves no entry behind.
  await selection.setSlot({ cartId: c.id, slot: slotA, mode: "AUTO" });
  await selection.setSlot({ cartId: c.id, slot: slotB, mode: "AUTO" });
  assert.deepEqual((await selection.read(c.id)).merchandise, {});
  assert.deepEqual((await prisma.cartVoucherSelection.findUniqueOrThrow({ where: { cartId: c.id } })).typeSelections, {});
});

test("applyAll writes several slots in one transaction and refuses the whole commit if one voucher is not available", async () => {
  const a = await f.type();
  const b = await f.type({ priority: 2 });
  const a1 = await f.tier(a.id, tierData());
  const b1 = await f.tier(b.id, tierData());
  const c = await cart();
  const slotA = `MERCHANDISE:${a.id}`;
  const slotB = `MERCHANDISE:${b.id}`;
  const both = await selection.applyAll({ cartId: c.id, merchandise: { [slotA]: { mode: "MANUAL", voucherId: a1.id }, [slotB]: { mode: "MANUAL", voucherId: b1.id } }, shipping: null });
  assert.equal(both.ok, true, JSON.stringify(both));
  // One bad voucher leaves what was saved untouched (nothing half-written).
  const bad = await selection.applyAll({ cartId: c.id, merchandise: { [slotA]: { mode: "AUTO", voucherId: null }, [slotB]: { mode: "MANUAL", voucherId: a1.id } }, shipping: null });
  assert.deepEqual(bad, { ok: false, reason: "NOT_AVAILABLE" });
  assert.deepEqual((await selection.read(c.id)).merchandise, { [slotA]: { mode: "MANUAL", voucherId: a1.id }, [slotB]: { mode: "MANUAL", voucherId: b1.id } });
  // A slot left out of the request is kept as saved.
  const kept = await selection.applyAll({ cartId: c.id, merchandise: { [slotA]: { mode: "AUTO", voucherId: null } }, shipping: null });
  assert.equal(kept.ok, true);
  assert.deepEqual((await selection.read(c.id)).merchandise, { [slotB]: { mode: "MANUAL", voucherId: b1.id } });
});

test("a type code unlocks the whole ladder of a PRIVATE type for that cart only, leaves its slot to AUTO and is not stored", async () => {
  const type = await f.type({ issuance: "CODE", visibility: "PRIVATE", code: "KOLLADDER" });
  const t1 = await f.tier(type.id, tierData({ issuance: "CODE", visibility: "PRIVATE" }));
  const t2 = await f.tier(type.id, tierData({ issuance: "CODE", visibility: "PRIVATE", fixedAmountVnd: BigInt(80_000), minEligibleSubtotalVnd: BigInt(1_000_000) }));
  const slot = `MERCHANDISE:${type.id}`;
  const a = await cart();
  const b = await cart();

  // Without the code a PRIVATE tier is not selectable by id (it answers like an id that does not exist), and its tiers are not read.
  assert.deepEqual(await selection.setSlot({ cartId: a.id, slot, mode: "MANUAL", voucherId: t1.id }), { ok: false, reason: "NOT_AVAILABLE" });
  assert.deepEqual(await readTypeTiers({ client: prisma, shopId: SHOP, typeIds: [], now: NOW, env: ON }), []);

  const applied = await selection.applyCode({ cartId: a.id, rawCode: " kolladder " });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const ok = applied as Extract<typeof applied, { ok: true }>;
  assert.deepEqual([ok.group, ok.slot, ok.card, ok.typeName], ["MERCHANDISE", slot, null, type.name]);
  assert.deepEqual(ok.selection.unlockedTypeIds, [type.id]);
  assert.deepEqual(ok.selection.merchandise, {}, "the ladder chooses the rung: the slot stays AUTO");
  assert.doesNotMatch(JSON.stringify(await prisma.cartVoucherSelection.findUnique({ where: { cartId: a.id } })), /KOLLADDER/i, "the code is not stored");

  // Unlocked, the cart can lock a rung by id (and drop back to AUTO without losing the unlock); another cart still cannot.
  assert.equal((await selection.setSlot({ cartId: a.id, slot, mode: "MANUAL", voucherId: t1.id })).ok, true);
  assert.deepEqual((await selection.read(a.id)).unlockedTypeIds, [type.id]);
  assert.equal((await selection.setSlot({ cartId: a.id, slot, mode: "AUTO" })).ok, true);
  assert.deepEqual((await selection.read(a.id)).unlockedTypeIds, [type.id], "AUTO keeps the unlock");
  assert.deepEqual(await selection.setSlot({ cartId: b.id, slot, mode: "MANUAL", voucherId: t2.id }), { ok: false, reason: "NOT_AVAILABLE" });
  assert.deepEqual((await selection.read(b.id)).unlockedTypeIds, undefined);

  // The unlock is part of the saved choice's version, and the unlocked tiers can be read for the cart.
  assert.notEqual(selectionVersionOf(await selection.read(a.id)), selectionVersionOf(await selection.read(b.id)));
  assert.deepEqual((await readTypeTiers({ client: prisma, shopId: SHOP, typeIds: [type.id], now: NOW, env: ON })).map((tier) => tier.id).sort(), [t1.id, t2.id].sort());
});

test("every way a type code can fail answers the same INVALID_CODE (PRIVATE); a used-up PUBLIC type says so", async () => {
  const priv = await f.type({ issuance: "CODE", visibility: "PRIVATE", code: "PRIVLAD1" });
  await f.tier(priv.id, tierData({ issuance: "CODE", visibility: "PRIVATE", maxUses: 1, redeemedUses: 1 }));
  const pub = await f.type({ issuance: "CODE", visibility: "PUBLIC", code: "PUBLAD1" });
  await f.tier(pub.id, tierData({ issuance: "CODE", visibility: "PUBLIC", maxUses: 1, redeemedUses: 1 }));
  const idle = await f.type({ issuance: "CODE", visibility: "PRIVATE", code: "NOTIERS1" });
  void idle;
  const ended = await f.type({ issuance: "CODE", visibility: "PRIVATE", code: "ENDED001" });
  await f.tier(ended.id, tierData({ issuance: "CODE", visibility: "PRIVATE", endsAt: new Date(Date.now() - 1_000) }));
  const draft = await f.type({ issuance: "CODE", visibility: "PRIVATE", code: "DRAFT001" });
  await f.tier(draft.id, tierData({ issuance: "CODE", visibility: "PRIVATE", isEnabled: false, enabledAt: null }));
  const c = await cart();
  const answer = async (rawCode: unknown) => {
    const result = await selection.applyCode({ cartId: c.id, rawCode });
    return result.ok ? "OK" : result.reason;
  };
  for (const code of ["PRIVLAD1", "NOTIERS1", "ENDED001", "DRAFT001", "NOSUCH001", "x", "", null, 5]) assert.equal(await answer(code), "INVALID_CODE", String(code));
  assert.equal(await answer("PUBLAD1"), "VOUCHER_UNAVAILABLE");
  assert.deepEqual((await selection.read(c.id)).unlockedTypeIds, undefined, "nothing was unlocked by a failed code");
});

test("a malformed or oversized saved typed selection reads as nothing, never as an error", async () => {
  const c = await cart();
  await selection.setSlot({ cartId: c.id, slot: "SHIPPING_FREE", mode: "MANUAL", voucherId: null });
  for (const junk of [[], "x", 5, { "bad id": { mode: "MANUAL", voucherId: "x" } }, { ok_1: "nope" }, Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`t${i}`, { mode: "AUTO", voucherId: null, unlocked: true }]))]) {
    await prisma.$executeRaw`UPDATE "CartVoucherSelection" SET "typeSelections" = ${JSON.stringify(junk)}::jsonb WHERE "cartId" = ${c.id}`.catch(() => undefined);
    const intent = await selection.read(c.id);
    assert.deepEqual(intent.merchandise, {}, JSON.stringify(junk));
    assert.deepEqual(intent.unlockedTypeIds, undefined, JSON.stringify(junk));
    assert.deepEqual(intent.shipping, { mode: "MANUAL", voucherId: null });
  }
});

test("an expired saved choice does not come back to life when the cart's expiry is renewed by a new write", async () => {
  const type = await f.type();
  const t1 = await f.tier(type.id, tierData());
  const c = await cart();
  const slot = `MERCHANDISE:${type.id}`;
  await selection.setSlot({ cartId: c.id, slot, mode: "MANUAL", voucherId: t1.id });
  await selection.setSlot({ cartId: c.id, slot: "SHIPPING_FREE", mode: "MANUAL", voucherId: null });
  await prisma.$executeRaw`UPDATE "CartVoucherSelection" SET "createdAt" = now() - interval '3 days', "expiresAt" = now() - interval '1 day' WHERE "cartId" = ${c.id}`;
  assert.deepEqual((await selection.read(c.id)).merchandise, {}, "an expired row reads as AUTO");
  // A new write on a still-live cart renews the row; the OLD choices must not return with it.
  await selection.setSlot({ cartId: c.id, slot: "MERCHANDISE", mode: "MANUAL", voucherId: null });
  const intent = await selection.read(c.id);
  assert.deepEqual(intent.merchandise, { MERCHANDISE: { mode: "MANUAL", voucherId: null } });
  assert.deepEqual(intent.shipping, { mode: "AUTO" });
});
