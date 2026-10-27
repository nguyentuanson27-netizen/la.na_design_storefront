import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const P = "vchr-schema";
const SHOP = 940_001;
const MIN = 60_000;

async function cleanup() {
  // The ledger is append-only by design, so fixture cleanup suspends triggers for this transaction only.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    const orders = await tx.orderMirror.findMany({ where: { publicCode: { startsWith: P } }, select: { id: true } });
    const ids = orders.map((order) => order.id);
    await tx.voucherRedemption.deleteMany({ where: { orderId: { in: ids } } });
    await tx.voucherHold.deleteMany({ where: { campaign: { pancakeShopId: SHOP } } });
    await tx.voucherCampaign.deleteMany({ where: { pancakeShopId: SHOP } });
    await tx.orderAcceptance.deleteMany({ where: { orderId: { in: ids } } });
    const snapshots = await tx.orderQuoteSnapshot.findMany({ where: { orderId: { in: ids } }, select: { id: true } });
    await tx.orderQuoteLine.deleteMany({ where: { snapshotId: { in: snapshots.map((s) => s.id) } } });
    await tx.orderQuoteSnapshot.deleteMany({ where: { orderId: { in: ids } } });
    await tx.orderLineSnapshot.deleteMany({ where: { orderId: { in: ids } } });
    await tx.orderMirror.deleteMany({ where: { id: { in: ids } } });
    await tx.cart.deleteMany({ where: { id: { startsWith: P } } });
  });
}

let counter = 0;
const token = () => `${P}-${process.pid}-${(counter += 1)}`;
const hex = (seed: string) => createHash("sha256").update(seed).digest("hex");

async function rejects(action: () => Promise<unknown>, pattern: RegExp) {
  await assert.rejects(action, (error: unknown) => {
    const text = `${error instanceof Error ? error.message : String(error)} ${(error as { cause?: { message?: string } })?.cause?.message ?? ""}`;
    assert.match(text, pattern);
    return true;
  });
}

const base = {
  pancakeShopId: SHOP,
  kind: "MERCHANDISE" as const,
  issuance: "AUTO" as const,
  visibility: "PUBLIC" as const,
  discountType: "FIXED_AMOUNT_VND" as const,
  fixedAmountVnd: BigInt(30_000),
  minEligibleSubtotalVnd: BigInt(600_000),
  scopeMode: "ALL_SHOP" as const,
};
function campaign(data: Record<string, unknown> = {}) {
  return prisma.voucherCampaign.create({ data: { name: `${P} ${token()}`, ...base, ...data } as never });
}

/** A checkout-complete order (the OrderMirror snapshot CHECK requires the whole guest block with any money). */
const checkout = { checkoutSnapshottedAt: new Date(), guestName: "Test", guestPhone: "0900000000", provinceRef: "p", communeRef: "c", addressDetail: "a" };
async function order(complete = false) {
  return prisma.orderMirror.create({
    data: { publicCode: token(), state: "DRAFT", ...(complete ? { ...checkout, merchandiseSubtotalVnd: BigInt(100), shippingFeeVnd: BigInt(0), totalVnd: BigInt(100) } : {}) },
  });
}

/** A consistent one-line 100d quote, so a statement on its own commits. */
async function orderWithSnapshot(digest = hex("quote")) {
  const target = await order(true);
  await prisma.orderQuoteSnapshot.create({
    data: {
      orderId: target.id, quoteFormat: "laq3", quoteDigest: digest, paidSubtotalVnd: BigInt(100), shippingFeeVnd: BigInt(0), totalVnd: BigInt(100),
      paidQuantity: 1, giftQuantity: 0, unclaimedSlots: 0, nonclaimAcknowledged: false,
      lines: { create: { lineId: "P:1", role: "PAID", variantId: "v", pancakeVariationId: "x", quantity: 1, unitPriceVnd: BigInt(100), lineTotalVnd: BigInt(100), fulfillmentState: "READY" } },
    } as never,
  });
  return { ...target, digest };
}

async function hold(campaignId: string, data: Record<string, unknown> = {}) {
  const createdAt = new Date();
  return prisma.voucherHold.create({
    data: {
      campaignId, campaignRevision: 1, pancakeShopId: SHOP, kind: "MERCHANDISE", attemptKey: hex(token()), quoteDigest: hex("q"), paidRevision: BigInt(1),
      heldDiscountVnd: BigInt(30_000), createdAt, expiresAt: new Date(createdAt.getTime() + 10 * MIN), ...data,
    } as never,
  });
}

test.before(cleanup);
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("campaign rows: shape rules are enforced by the database itself", async () => {
  const good = await campaign();
  assert.equal(good.isEnabled, false, "a new campaign is never active");
  assert.equal(good.revision, 1);

  const bad = (data: Record<string, unknown>) => rejects(() => campaign(data), /check constraint|violates/i);
  await bad({ minEligibleSubtotalVnd: BigInt(30_000) }); // fixed needs min > amount
  await bad({ minEligibleSubtotalVnd: null }); // fixed needs a minimum
  await bad({ visibility: "PRIVATE" }); // AUTO must be PUBLIC
  await bad({ issuance: "CODE", code: "ab" }); // code format
  await bad({ issuance: "CODE", code: "lower" });
  await bad({ code: "SAVE10" }); // AUTO carries no code
  await bad({ kind: "SHIPPING_FREE" }); // shipping voucher carries no merchandise discount
  await bad({ discountType: "PERCENTAGE", percent: 100, fixedAmountVnd: null, minEligibleSubtotalVnd: null });
  await bad({ discountType: "PERCENTAGE", percent: 10, fixedAmountVnd: BigInt(1) });
  await bad({ scopeMode: "TARGETED" }); // targeted needs a category or an include
  await bad({ scopeMode: "ALL_SHOP", categoryKeys: ["vayDam"] });
  await bad({ startsAt: new Date("2026-12-01T00:00:00Z"), endsAt: new Date("2026-11-01T00:00:00Z") });
  await bad({ isEnabled: true, enabledAt: null });
  await bad({ maxUses: 0 });
  await bad({ maxBudgetVnd: BigInt(0) });
  await bad({ revision: 0 });

  await campaign({ kind: "SHIPPING_FREE", discountType: null, fixedAmountVnd: null, minEligibleSubtotalVnd: null });
  await campaign({ discountType: "PERCENTAGE", percent: 10, fixedAmountVnd: null, maxDiscountVnd: BigInt(100_000), minEligibleSubtotalVnd: null });
  await campaign({ issuance: "CODE", visibility: "PRIVATE", code: "KOL50", scopeMode: "TARGETED", categoryKeys: ["vayDam"] });
});

test("a voucher code is unique per shop and free in another shop; AUTO campaigns never collide on null", async () => {
  await campaign({ issuance: "CODE", code: "UNIQ10" });
  await rejects(() => campaign({ issuance: "CODE", code: "UNIQ10" }), /unique|duplicate/i);
  await campaign({ issuance: "CODE", code: "UNIQ10", pancakeShopId: SHOP + 1 }).finally(() => prisma.voucherCampaign.deleteMany({ where: { pancakeShopId: SHOP + 1 } }));
  await campaign();
  await campaign();
});

test("AC-44: the database refuses a cap below redeemed + reserved, and accepts one equal to the committed floor", async () => {
  const c = await campaign({ maxUses: 5, redeemedUses: 1, reservedUses: 2, maxBudgetVnd: BigInt(500_000), redeemedVnd: BigInt(100_000), reservedVnd: BigInt(200_000) });
  await rejects(() => prisma.voucherCampaign.update({ where: { id: c.id }, data: { maxUses: 2 } }), /check constraint|violates/i);
  await rejects(() => prisma.voucherCampaign.update({ where: { id: c.id }, data: { maxBudgetVnd: BigInt(299_999) } }), /check constraint|violates/i);
  await prisma.voucherCampaign.update({ where: { id: c.id }, data: { maxUses: 3, maxBudgetVnd: BigInt(300_000) } });
  // The ledger can never be pushed over a cap either (a grant that would oversubscribe fails).
  await rejects(() => prisma.voucherCampaign.update({ where: { id: c.id }, data: { reservedUses: { increment: 1 } } }), /check constraint|violates/i);
  // Unlimited -> limited is checked the same way.
  const open = await campaign({ redeemedUses: 4 });
  await rejects(() => prisma.voucherCampaign.update({ where: { id: open.id }, data: { maxUses: 3 } }), /check constraint|violates/i);
});

test("hold: the TTL is an absolute 10 minutes, and only one hold per attempt and kind is live", async () => {
  const c = await campaign();
  const createdAt = new Date();
  await rejects(() => hold(c.id, { createdAt, expiresAt: new Date(createdAt.getTime() + 11 * MIN) }), /check constraint|violates/i);
  await rejects(() => hold(c.id, { createdAt, expiresAt: new Date(createdAt.getTime() + 9 * MIN) }), /check constraint|violates/i);
  await rejects(() => hold(c.id, { attemptKey: "short" }), /check constraint|violates/i);
  await rejects(() => hold(c.id, { heldDiscountVnd: BigInt(0) }), /check constraint|violates/i);

  const attemptKey = hex(token());
  const first = await hold(c.id, { attemptKey });
  await rejects(() => hold(c.id, { attemptKey }), /unique|duplicate/i);
  // Another kind for the same attempt is a different hold (two groups, spec §5.1).
  const shipping = await campaign({ kind: "SHIPPING_FREE", discountType: null, fixedAmountVnd: null, minEligibleSubtotalVnd: null });
  await hold(shipping.id, { attemptKey, kind: "SHIPPING_FREE" });
  // Once released the attempt can hold again.
  await prisma.voucherHold.update({ where: { id: first.id }, data: { state: "RELEASED", releasedAt: new Date() } });
  await hold(c.id, { attemptKey });
});

test("hold: identity, amount and expiry never change; a settled hold is final", async () => {
  const c = await campaign();
  const h = await hold(c.id);
  const change = (data: Record<string, unknown>) => rejects(() => prisma.voucherHold.update({ where: { id: h.id }, data: data as never }), /identity, amount and expiry|check constraint|violates/i);
  await change({ heldDiscountVnd: BigInt(1) });
  await change({ expiresAt: new Date(h.expiresAt.getTime() + MIN) }); // no rolling TTL
  await change({ campaignRevision: 2 });
  await change({ attemptKey: hex("other") });
  await prisma.voucherHold.update({ where: { id: h.id }, data: { state: "RELEASED", releasedAt: new Date() } });
  await rejects(() => prisma.voucherHold.update({ where: { id: h.id }, data: { state: "HELD", releasedAt: null } }), /settled voucher hold|check constraint|violates/i);
  await prisma.voucherHold.delete({ where: { id: h.id } }); // a released hold may be cleaned up
  const live = await hold(c.id);
  await rejects(() => prisma.voucherHold.delete({ where: { id: live.id } }), /cannot be deleted/i);
});

test("AC-32: a hold at or after its expiry cannot be consumed, by the database clock, whatever the app says", async () => {
  const c = await campaign();
  const createdAt = new Date(Date.now() - 11 * MIN);
  const stale = await hold(c.id, { createdAt, expiresAt: new Date(createdAt.getTime() + 10 * MIN) });
  const target = await orderWithSnapshot();
  await rejects(
    () => prisma.voucherHold.update({ where: { id: stale.id }, data: { state: "CONSUMED", consumedAt: new Date(createdAt.getTime() + MIN), orderId: target.id } }),
    /expired voucher hold cannot be consumed/i,
  );
  // It can be marked expired, and a live hold cannot be marked expired early.
  await prisma.voucherHold.update({ where: { id: stale.id }, data: { state: "EXPIRED", releasedAt: new Date() } });
  const live = await hold(c.id);
  await rejects(() => prisma.voucherHold.update({ where: { id: live.id }, data: { state: "EXPIRED", releasedAt: new Date() } }), /cannot expire before/i);
});

test("acceptance: insert-only, and only with the digest of the order's own quote snapshot", async () => {
  const plain = await order(true);
  await rejects(() => prisma.orderAcceptance.create({ data: { orderId: plain.id, quoteDigest: hex("none"), acceptedAt: new Date() } }), /own quote snapshot/i);
  const target = await orderWithSnapshot();
  await rejects(() => prisma.orderAcceptance.create({ data: { orderId: target.id, quoteDigest: hex("other"), acceptedAt: new Date() } }), /own quote snapshot/i);
  await rejects(() => prisma.orderAcceptance.create({ data: { orderId: target.id, quoteDigest: "NOT-HEX", acceptedAt: new Date() } }), /own quote snapshot|check constraint|violates/i);
  const accepted = await prisma.orderAcceptance.create({ data: { orderId: target.id, quoteDigest: target.digest, acceptedAt: new Date() } });
  await rejects(() => prisma.orderAcceptance.create({ data: { orderId: target.id, quoteDigest: target.digest, acceptedAt: new Date() } }), /unique|duplicate/i);
  await rejects(() => prisma.orderAcceptance.update({ where: { id: accepted.id }, data: { acceptedAt: new Date() } }), /insert-only/i);
  await rejects(() => prisma.orderAcceptance.delete({ where: { id: accepted.id } }), /insert-only/i);
});

test("AC-38: before acceptance a DRAFT is repriced as today; after it money and quote rows are frozen, state still moves", async () => {
  const target = await orderWithSnapshot();
  const line = await prisma.orderLineSnapshot.create({
    data: { orderId: target.id, variantId: "v", pancakeVariationId: "x", productName: "Dress", size: "M", quantity: 1, unitPriceVnd: BigInt(100), lineTotalVnd: BigInt(100) },
  });
  // Not accepted yet: a reprice is ordinary.
  await prisma.orderMirror.update({ where: { id: target.id }, data: { totalVnd: BigInt(100), guestName: "Reprice" } });
  await prisma.orderLineSnapshot.update({ where: { id: line.id }, data: { unitPriceVnd: BigInt(100) } });

  await prisma.orderAcceptance.create({ data: { orderId: target.id, quoteDigest: target.digest, acceptedAt: new Date() } });

  const frozen = /immutable/i;
  await rejects(() => prisma.orderMirror.update({ where: { id: target.id }, data: { totalVnd: BigInt(90) } }), frozen);
  await rejects(() => prisma.orderMirror.update({ where: { id: target.id }, data: { shippingFeeVnd: BigInt(5) } }), frozen);
  await rejects(() => prisma.orderMirror.update({ where: { id: target.id }, data: { shippingPromotionCampaignId: "c", shippingPromotionRevision: 1 } }), frozen);
  await rejects(() => prisma.orderLineSnapshot.update({ where: { id: line.id }, data: { unitPriceVnd: BigInt(1) } }), frozen);
  await rejects(() => prisma.orderLineSnapshot.create({ data: { orderId: target.id, variantId: "v2", pancakeVariationId: "y", productName: "Bag", size: "M", quantity: 1, unitPriceVnd: BigInt(1), lineTotalVnd: BigInt(1) } }), frozen);
  await rejects(() => prisma.orderLineSnapshot.delete({ where: { id: line.id } }), frozen);
  const snapshot = await prisma.orderQuoteSnapshot.findUniqueOrThrow({ where: { orderId: target.id } });
  await rejects(() => prisma.orderQuoteSnapshot.update({ where: { id: snapshot.id }, data: { totalVnd: BigInt(90) } }), frozen);
  await rejects(() => prisma.orderQuoteLine.deleteMany({ where: { snapshotId: snapshot.id } }), frozen);

  // The order still has to move through POS: state, Pancake identity and sync fields are writable.
  await prisma.orderMirror.update({ where: { id: target.id }, data: { state: "VALIDATING", syncErrorCode: null } });
  await prisma.orderMirror.update({ where: { id: target.id }, data: { state: "POS_SUBMITTING", pancakeOrderId: `${P}-pos-${token()}`, pancakeStatus: 0 } });
});

async function consumedFixture() {
  const c = await campaign({ maxUses: 10, maxBudgetVnd: BigInt(1_000_000) });
  const target = await orderWithSnapshot();
  const h = await hold(c.id);
  await prisma.orderAcceptance.create({ data: { orderId: target.id, quoteDigest: target.digest, acceptedAt: new Date() } });
  const consumedAt = new Date();
  await prisma.voucherHold.update({ where: { id: h.id }, data: { state: "CONSUMED", consumedAt, orderId: target.id } });
  const redemption = (data: Record<string, unknown> = {}) =>
    prisma.voucherRedemption.create({
      data: { campaignId: c.id, campaignRevision: 1, kind: "MERCHANDISE", orderId: target.id, holdId: h.id, amountVnd: BigInt(30_000), websiteAcceptedAt: consumedAt, ...data } as never,
    });
  return { c, target, h, redemption, consumedAt };
}

test("redemption: needs a consumed hold, an accepted order and a matching amount; one per order and kind", async () => {
  const { c, h, redemption } = await consumedFixture();
  await rejects(() => redemption({ amountVnd: BigInt(29_999) }), /must match a consumed hold/i);
  await rejects(() => redemption({ kind: "SHIPPING_FREE" }), /must match a consumed hold/i);
  await rejects(() => redemption({ campaignRevision: 2 }), /must match a consumed hold/i);
  await rejects(() => redemption({ refundedAt: new Date(), refundReason: "x", refundEvidence: "y" }), /already refunded/i);

  // A hold that is still HELD cannot back a redemption, and neither can an unaccepted order.
  const open = await hold(c.id);
  const unaccepted = await orderWithSnapshot();
  await rejects(() => prisma.voucherRedemption.create({ data: { campaignId: c.id, campaignRevision: 1, kind: "MERCHANDISE", orderId: unaccepted.id, holdId: open.id, amountVnd: BigInt(30_000), websiteAcceptedAt: new Date() } }), /must match a consumed hold/i);

  const created = await redemption();
  assert.equal(created.refundedAt, null);
  await rejects(() => redemption(), /unique|duplicate/i); // a retry cannot consume twice
  assert.equal(h.id, created.holdId);
});

test("AC-19: a refund is a one-way compare-and-set; identity and the ledger row are frozen", async () => {
  const { redemption } = await consumedFixture();
  const created = await redemption();
  await rejects(() => prisma.voucherRedemption.delete({ where: { id: created.id } }), /cannot be deleted/i);
  await rejects(() => prisma.voucherRedemption.update({ where: { id: created.id }, data: { amountVnd: BigInt(1) } }), /keeps its identity/i);
  await rejects(() => prisma.voucherRedemption.update({ where: { id: created.id }, data: { refundedAt: new Date() } }), /check constraint|violates/i); // reason + evidence required

  const first = await prisma.voucherRedemption.updateMany({ where: { id: created.id, refundedAt: null }, data: { refundedAt: new Date(), refundReason: "CANCELLED", refundEvidence: "pancake-status:6" } });
  assert.equal(first.count, 1);
  // A duplicate or out-of-order cancel event matches zero rows and changes nothing.
  const second = await prisma.voucherRedemption.updateMany({ where: { id: created.id, refundedAt: null }, data: { refundedAt: new Date(), refundReason: "CANCELLED", refundEvidence: "again" } });
  assert.equal(second.count, 0);
  await rejects(() => prisma.voucherRedemption.update({ where: { id: created.id }, data: { refundReason: "OTHER" } }), /refund is final/i);
  await rejects(() => prisma.voucherRedemption.update({ where: { id: created.id }, data: { refundedAt: null, refundReason: null, refundEvidence: null } }), /refund is final/i);
});

test("cart selection: intent only, AUTO carries no id, and it disappears with its cart", async () => {
  const cartId = `${P}-cart-${token()}`;
  await prisma.cart.create({ data: { id: cartId, expiresAt: new Date(Date.now() + 86_400_000) } });
  const expiresAt = new Date(Date.now() + 86_400_000);
  await rejects(() => prisma.cartVoucherSelection.create({ data: { cartId, merchandiseMode: "AUTO", merchandiseVoucherId: "m1", expiresAt } }), /check constraint|violates/i);
  await rejects(() => prisma.cartVoucherSelection.create({ data: { cartId, merchandiseMode: "MANUAL", merchandiseVoucherId: "x".repeat(65), expiresAt } }), /check constraint|violates/i);
  await prisma.cartVoucherSelection.create({ data: { cartId, merchandiseMode: "MANUAL", merchandiseVoucherId: null, shippingMode: "MANUAL", shippingVoucherId: "s1", expiresAt } }); // manual NONE + a shipping lock
  await prisma.cart.delete({ where: { id: cartId } });
  assert.equal(await prisma.cartVoucherSelection.count({ where: { cartId } }), 0);
});

test("existing orders are untouched: a historical order with no acceptance row stays editable", async () => {
  const historical = await order(true);
  await prisma.orderMirror.update({ where: { id: historical.id }, data: { totalVnd: BigInt(1), merchandiseSubtotalVnd: BigInt(1) } });
  await prisma.orderMirror.update({ where: { id: historical.id }, data: { totalVnd: BigInt(2), merchandiseSubtotalVnd: BigInt(2) } });
});
