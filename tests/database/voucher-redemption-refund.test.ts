import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../src/generated/prisma/client.ts";
import { createPancakeOrderReconciliationService } from "../../src/commerce/pancake-order-reconciliation.ts";
import { createPancakeOrderStatusReconciliationService } from "../../src/commerce/pancake-order-status-reconciliation.ts";
import { createPancakeOrderSubmissionService } from "../../src/commerce/pancake-order-submit.ts";
import { adminCancelVoucherOrder } from "../../src/commerce/voucher-admin-cancel.ts";
import { createVoucherRedemptionService } from "../../src/commerce/voucher-redemption-service.ts";
import { PancakeHttpError } from "../../src/integrations/pancake/client.ts";
import type { PancakeOrderStatus } from "../../src/integrations/pancake/order-status.ts";
import { createVoucherFixtures } from "../support/voucher-fixtures.ts";

/**
 * V14 against a real database: a redemption is refunded once, from a trusted signal only (ADR 0018 D-4; AC-18/19/27).
 * Orders here are in the ledger state acceptance leaves them in: ACCEPTED marker, CONSUMED holds, redemptions, counters
 * already moved reserved -> redeemed.
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const SHOP = 940_015;
const P = "vchr-refund";
const f = createVoucherFixtures(prisma, SHOP, P);
const refunds = createVoucherRedemptionService(prisma);
const checkout = { checkoutSnapshottedAt: new Date(), guestName: "Test", guestPhone: "0900000000", provinceRef: "p", communeRef: "c", addressDetail: "a" };

async function cleanup() {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    const orders = await tx.orderMirror.findMany({ where: { pancakeShopId: SHOP }, select: { id: true } });
    const ids = orders.map((order) => order.id);
    await tx.voucherRedemption.deleteMany({ where: { orderId: { in: ids } } });
    await tx.voucherHold.deleteMany({ where: { campaign: { pancakeShopId: SHOP } } });
    await tx.orderAcceptance.deleteMany({ where: { orderId: { in: ids } } });
    const snapshots = await tx.orderQuoteSnapshot.findMany({ where: { orderId: { in: ids } }, select: { id: true } });
    await tx.orderQuoteLine.deleteMany({ where: { snapshotId: { in: snapshots.map((s) => s.id) } } });
    await tx.orderQuoteSnapshot.deleteMany({ where: { orderId: { in: ids } } });
    await tx.orderMirror.deleteMany({ where: { id: { in: ids } } });
    await tx.voucherCampaign.deleteMany({ where: { pancakeShopId: SHOP } });
  });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP } });
}
test.before(cleanup);
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});
test.beforeEach(cleanup);

let sequence = 0;
/** A website-accepted order carrying one merchandise redemption (and optionally a shipping one), POS_SUBMITTING. */
async function acceptedOrder(options: Readonly<{ shipping?: boolean; campaignExtra?: Record<string, unknown> }> = {}) {
  sequence += 1;
  const m = await f.campaign({ maxUses: 5, maxBudgetVnd: BigInt(1_000_000), redeemedUses: 1, redeemedVnd: BigInt(50_000), ...options.campaignExtra });
  const s = options.shipping ? await f.shippingCampaign({ maxUses: 5, maxBudgetVnd: BigInt(1_000_000), redeemedUses: 1, redeemedVnd: BigInt(30_000) }) : null;
  const quoteDigest = f.hex(`quote-${sequence}-${f.token()}`);
  const order = await prisma.orderMirror.create({
    data: {
      publicCode: f.token(), state: "DRAFT", pancakeShopId: SHOP, ...checkout, merchandiseSubtotalVnd: BigInt(100), shippingFeeVnd: BigInt(0), totalVnd: BigInt(100),
      quoteSnapshot: {
        create: {
          quoteFormat: "laq3", quoteDigest, paidSubtotalVnd: BigInt(100), shippingFeeVnd: BigInt(0), totalVnd: BigInt(100), paidQuantity: 1, giftQuantity: 0, unclaimedSlots: 0, nonclaimAcknowledged: false,
          lines: { create: { lineId: "P:1", role: "PAID", variantId: "v", pancakeVariationId: "x", quantity: 1, unitPriceVnd: BigInt(100), lineTotalVnd: BigInt(100), fulfillmentState: "READY" } },
        },
      },
    },
  });
  await prisma.orderMirror.update({ where: { id: order.id }, data: { state: "VALIDATING" } });
  await prisma.orderMirror.update({ where: { id: order.id }, data: { state: "POS_SUBMITTING" } });
  const acceptedAt = new Date();
  await prisma.orderAcceptance.create({ data: { orderId: order.id, quoteDigest, acceptedAt } });
  const redeem = async (campaignId: string, kind: "MERCHANDISE" | "SHIPPING_FREE", amount: number) => {
    const createdAt = new Date(acceptedAt.getTime() - 1_000);
    const hold = await prisma.voucherHold.create({
      data: { campaignId, campaignRevision: 1, pancakeShopId: SHOP, kind, attemptKey: f.hex(f.token()), quoteDigest: f.hex("q"), paidRevision: BigInt(1), heldDiscountVnd: BigInt(amount), createdAt, expiresAt: new Date(createdAt.getTime() + 600_000) },
    });
    await prisma.voucherHold.update({ where: { id: hold.id }, data: { state: "CONSUMED", consumedAt: acceptedAt, orderId: order.id } });
    await prisma.voucherRedemption.create({ data: { campaignId, campaignRevision: 1, kind, orderId: order.id, holdId: hold.id, amountVnd: BigInt(amount), websiteAcceptedAt: acceptedAt } });
  };
  await redeem(m.id, "MERCHANDISE", 50_000);
  if (s) await redeem(s.id, "SHIPPING_FREE", 30_000);
  return { order, m, s };
}
const setState = (orderId: string, state: "REJECTED" | "SYNC_UNKNOWN" | "CONFIRMED", extra: Record<string, unknown> = {}) =>
  prisma.orderMirror.update({ where: { id: orderId }, data: { state, ...(state === "REJECTED" ? { syncErrorCode: "ORDER_REJECTED" } : {}), ...extra } as never });
const mirrorStatus = (orderId: string, status: number, pancakeOrderId = "8800123") =>
  prisma.orderMirror.update({ where: { id: orderId }, data: { pancakeOrderId, pancakeSystemId: "901", pancakeStatus: status, pancakeStatusUpdatedAt: "2026-10-26T10:00:00Z" } });
const counters = async (id: string) => {
  const row = await prisma.voucherCampaign.findUniqueOrThrow({ where: { id } });
  return [row.redeemedUses, row.redeemedVnd, row.reservedUses, row.reservedVnd] as const;
};
const redemptionsOf = (orderId: string) => prisma.voucherRedemption.findMany({ where: { orderId }, orderBy: { kind: "asc" } });

test("AC-18: a REJECTED order refunds each redemption once; the ledger is returned and the campaign state is untouched", async () => {
  const { order, m, s } = await acceptedOrder({ shipping: true });
  await setState(order.id, "REJECTED");
  const first = await refunds.refundOrder({ orderId: order.id, reason: "POS_REJECTED" });
  assert.deepEqual(first, { ok: true, refunded: 2, alreadyRefunded: 0 });
  assert.deepEqual(await counters(m.id), [0, BigInt(0), 0, BigInt(0)]);
  assert.deepEqual(await counters(s!.id), [0, BigInt(0), 0, BigInt(0)]);
  const rows = await redemptionsOf(order.id);
  assert.ok(rows.every((r) => r.refundedAt !== null && r.refundReason === "POS_REJECTED" && r.refundEvidence === "local-state:REJECTED"));

  // Duplicate / replayed signal: nothing changes.
  assert.deepEqual(await refunds.refundOrder({ orderId: order.id, reason: "POS_REJECTED" }), { ok: true, refunded: 0, alreadyRefunded: 2 });
  assert.deepEqual(await counters(m.id), [0, BigInt(0), 0, BigInt(0)]);
  // The refund is final (database trigger): it cannot be taken back or rewritten.
  await assert.rejects(() => prisma.voucherRedemption.update({ where: { id: rows[0]!.id }, data: { refundedAt: null, refundReason: null, refundEvidence: null } }), /refund is final/i);
});

test("AC-18: SYNC_UNKNOWN, CONFIRMED and in-flight orders are NOT a signal: nothing is refunded", async () => {
  for (const state of ["SYNC_UNKNOWN", "CONFIRMED", "POS_SUBMITTING"] as const) {
    await cleanup();
    const { order, m } = await acceptedOrder();
    if (state !== "POS_SUBMITTING") await setState(order.id, state);
    assert.deepEqual(await refunds.refundOrder({ orderId: order.id, reason: "POS_REJECTED" }), { ok: false, reason: "NOT_A_TRUSTED_SIGNAL" }, state);
    assert.deepEqual(await counters(m.id), [1, BigInt(50_000), 0, BigInt(0)]);
    assert.ok((await redemptionsOf(order.id)).every((r) => r.refundedAt === null));
  }
});

test("AC-19: only the cancelled status (7) on a complete, shop-verified mirror refunds; other statuses and half records never do; duplicates once", async () => {
  // Other Pancake status codes, including ones that look terminal, are not mapped.
  for (const status of [0, 1, 2, 3, 4, 5, 6, 8, 15, 16]) {
    await cleanup();
    const { order, m } = await acceptedOrder();
    await setState(order.id, "CONFIRMED", { pancakeShopId: SHOP });
    await mirrorStatus(order.id, status);
    assert.deepEqual(await refunds.refundOrder({ orderId: order.id, reason: "POS_CANCELLED" }), { ok: false, reason: "NOT_A_TRUSTED_SIGNAL" }, `status ${status}`);
    assert.deepEqual(await counters(m.id), [1, BigInt(50_000), 0, BigInt(0)]);
  }
  // A half record (no revision / system id) is not evidence, even at 7.
  await cleanup();
  const half = await acceptedOrder();
  await prisma.orderMirror.update({ where: { id: half.order.id }, data: { pancakeOrderId: "8800124", pancakeStatus: 7 } });
  assert.deepEqual(await refunds.refundOrder({ orderId: half.order.id, reason: "POS_CANCELLED" }), { ok: false, reason: "NOT_A_TRUSTED_SIGNAL" });

  // The cancel after the order was confirmed (shipped orders are cancelled the same way) refunds once, however often it repeats.
  await cleanup();
  const { order, m, s } = await acceptedOrder({ shipping: true });
  await setState(order.id, "CONFIRMED");
  await mirrorStatus(order.id, 7);
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => refunds.refundOrder({ orderId: order.id, reason: "POS_CANCELLED" })));
  assert.equal(results.reduce((sum, r) => sum + (r.ok ? r.refunded : 0), 0), 2, "two redemptions, each refunded exactly once across five parallel signals");
  assert.deepEqual(await counters(m.id), [0, BigInt(0), 0, BigInt(0)]);
  assert.deepEqual(await counters(s!.id), [0, BigInt(0), 0, BigInt(0)]);
  assert.match((await redemptionsOf(order.id))[0]!.refundEvidence!, /^pancake:shop=940015;order=8800123;status=7;updatedAt=/);
});

test("AC-27: refund after the campaign expired or was disabled returns the counters and does NOT reactivate it", async () => {
  const { order, m } = await acceptedOrder({ campaignExtra: { endsAt: new Date(Date.now() - 86_400_000), startsAt: new Date(Date.now() - 2 * 86_400_000) } });
  await prisma.voucherCampaign.update({ where: { id: m.id }, data: { isEnabled: false, disabledAt: new Date() } });
  const before = await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: m.id } });
  await setState(order.id, "REJECTED");
  assert.equal((await refunds.refundOrder({ orderId: order.id, reason: "POS_REJECTED" })).ok, true);
  const after = await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: m.id } });
  assert.deepEqual([after.redeemedUses, after.redeemedVnd], [0, BigInt(0)]);
  assert.deepEqual([after.isEnabled, after.enabledAt, after.disabledAt, after.startsAt, after.endsAt, after.revision], [before.isEnabled, before.enabledAt, before.disabledAt, before.startsAt, before.endsAt, before.revision]);
});

test("a refund needs an order that exists and has a redemption; an Admin cancel needs audit evidence", async () => {
  assert.deepEqual(await refunds.refundOrder({ orderId: "missing", reason: "POS_REJECTED" }), { ok: false, reason: "ORDER_NOT_FOUND" });
  const plain = await prisma.orderMirror.create({ data: { publicCode: f.token(), state: "REJECTED", pancakeShopId: SHOP } });
  assert.deepEqual(await refunds.refundOrder({ orderId: plain.id, reason: "POS_REJECTED" }), { ok: false, reason: "NO_REDEMPTION" });
  const { order, m } = await acceptedOrder();
  assert.deepEqual(await refunds.refundOrder({ orderId: order.id, reason: "ADMIN_CANCEL" }), { ok: false, reason: "INVALID_EVIDENCE" });
  assert.deepEqual(await refunds.refundOrder({ orderId: order.id, reason: "ADMIN_CANCEL", evidence: "   " }), { ok: false, reason: "INVALID_EVIDENCE" });
  assert.deepEqual(await refunds.refundOrder({ orderId: order.id, reason: "NOT_A_REASON" as never }), { ok: false, reason: "NOT_A_TRUSTED_SIGNAL" });
  assert.deepEqual(await counters(m.id), [1, BigInt(50_000), 0, BigInt(0)]);
  assert.deepEqual(await refunds.refundOrder({ orderId: order.id, reason: "ADMIN_CANCEL", evidence: "audit:42" }), { ok: true, refunded: 1, alreadyRefunded: 0 });
  assert.equal((await redemptionsOf(order.id))[0]!.refundEvidence, "admin:audit:42");
});

test("the sweep settles REJECTED orders whose hook was lost, once, and leaves every other state alone", async () => {
  const rejected = await acceptedOrder();
  await setState(rejected.order.id, "REJECTED");
  const unknown = await acceptedOrder();
  await setState(unknown.order.id, "SYNC_UNKNOWN");
  const confirmed = await acceptedOrder();
  await setState(confirmed.order.id, "CONFIRMED");
  assert.deepEqual(await refunds.sweepRejectedOrders(), { scanned: 1, refunded: 1 });
  assert.deepEqual(await refunds.sweepRejectedOrders(), { scanned: 0, refunded: 0 });
  assert.deepEqual(await counters(rejected.m.id), [0, BigInt(0), 0, BigInt(0)]);
  assert.deepEqual(await counters(unknown.m.id), [1, BigInt(50_000), 0, BigInt(0)]);
  assert.deepEqual(await counters(confirmed.m.id), [1, BigInt(50_000), 0, BigInt(0)]);
});

test("the sweep also settles an order whose cancelled status (7) was stored but whose refund hook was lost: once, with provenance, and nothing else", async () => {
  // Status 7 is persisted by the status reconciliation BEFORE the refund; a crash or a thrown hook leaves it unrefunded.
  const lost = await acceptedOrder({ shipping: true });
  await setState(lost.order.id, "CONFIRMED");
  await mirrorStatus(lost.order.id, 7);
  // Not signals: another code, a half record at 7, and SYNC_UNKNOWN with no status record at all.
  const other = await acceptedOrder();
  await setState(other.order.id, "CONFIRMED");
  await mirrorStatus(other.order.id, 3, "8800200");
  const half = await acceptedOrder();
  await setState(half.order.id, "CONFIRMED");
  await prisma.orderMirror.update({ where: { id: half.order.id }, data: { pancakeOrderId: "8800201", pancakeStatus: 7 } });
  const unknown = await acceptedOrder();
  await setState(unknown.order.id, "SYNC_UNKNOWN");

  const first = await refunds.sweepCancelledOrders();
  assert.equal(first.refunded, 2, "the two redemptions of the lost order");
  assert.deepEqual(await counters(lost.m.id), [0, BigInt(0), 0, BigInt(0)]);
  assert.deepEqual(await counters(lost.s!.id), [0, BigInt(0), 0, BigInt(0)]);
  assert.match((await redemptionsOf(lost.order.id))[0]!.refundEvidence!, /^pancake:shop=940015;order=8800123;status=7;/);
  assert.equal((await redemptionsOf(lost.order.id))[0]!.refundReason, "POS_CANCELLED");
  assert.deepEqual(await counters(unknown.m.id), [1, BigInt(50_000), 0, BigInt(0)], "SYNC_UNKNOWN is pending, never refunded");
  assert.deepEqual(await counters(other.m.id), [1, BigInt(50_000), 0, BigInt(0)], "status 3 is not a cancel");
  assert.deepEqual(await counters(half.m.id), [1, BigInt(50_000), 0, BigInt(0)], "a half record is not evidence");

  // Exactly once: a second run, and the plain sweep, change nothing more.
  assert.equal((await refunds.sweepCancelledOrders()).refunded, 0);
  const again = await refunds.sweep();
  assert.equal(again.cancelled.refunded, 0);
  assert.deepEqual(await counters(lost.m.id), [0, BigInt(0), 0, BigInt(0)]);
});

test("the cancelled-order sweep cannot be starved: 60 half records at status 7 never take the batch from one valid cancelled order", async () => {
  const valid = await acceptedOrder();
  await setState(valid.order.id, "CONFIRMED");
  await mirrorStatus(valid.order.id, 7, "8800500");
  // Sixty orders whose status 7 was stored without a complete record (no system id / revision): not evidence, and numerous
  // enough to fill a limit of 50 if the candidate query did not already exclude them.
  const halves = [];
  for (let n = 0; n < 60; n += 1) {
    const half = await acceptedOrder();
    await setState(half.order.id, "CONFIRMED");
    await prisma.orderMirror.update({ where: { id: half.order.id }, data: { pancakeOrderId: `88006${String(n).padStart(2, "0")}`, pancakeStatus: 7 } });
    halves.push(half);
  }
  const swept = await refunds.sweepCancelledOrders({ limit: 50 });
  assert.deepEqual(swept, { scanned: 1, refunded: 1 }, "only the valid order was a candidate, and it was settled in the first pass");
  assert.deepEqual(await counters(valid.m.id), [0, BigInt(0), 0, BigInt(0)]);
  assert.deepEqual(await counters(halves[0]!.m.id), [1, BigInt(50_000), 0, BigInt(0)], "a half record is never refunded");
});

// ---- the signals reach the refund through the real services ------------------------------------------------------

const upstream = (status: number, updatedAt: string): PancakeOrderStatus =>
  ({ orderId: "8800123", systemId: 901, shopId: SHOP, status, insertedAt: "2026-10-26T09:00:00Z", updatedAt }) as PancakeOrderStatus;

test("status reconciliation: a verified cancel refunds, a retry after a lost hook refunds, an older or other status never does", async () => {
  const { order, m } = await acceptedOrder();
  await setState(order.id, "CONFIRMED");
  await prisma.orderMirror.update({ where: { id: order.id }, data: { pancakeOrderId: "8800123" } });
  let hookFails = true;
  const calls: string[] = [];
  const service = (status: number, updatedAt: string) =>
    createPancakeOrderStatusReconciliationService(prisma, { async fetchOrderStatus() { return upstream(status, updatedAt); } }, {
      shopId: SHOP,
      async onTrustedCancel({ orderId }) {
        calls.push(orderId);
        if (hookFails) throw new Error("database blip");
        await refunds.refundOrder({ orderId, reason: "POS_CANCELLED" });
      },
    });

  // Status 0 first: the hook is not even called.
  assert.deepEqual(await service(0, "2026-10-26T09:30:00Z").reconcile({ orderId: order.id }), { ok: true, outcome: "UPDATED" });
  assert.deepEqual(calls, []);
  // Cancelled, but the hook fails: the status result stands and nothing is refunded yet.
  assert.deepEqual(await service(7, "2026-10-26T10:00:00Z").reconcile({ orderId: order.id }), { ok: true, outcome: "UPDATED" });
  assert.deepEqual(calls, [order.id]);
  assert.deepEqual(await counters(m.id), [1, BigInt(50_000), 0, BigInt(0)]);
  // The next status read is UNCHANGED, calls the hook again, and the refund lands.
  hookFails = false;
  assert.deepEqual(await service(7, "2026-10-26T10:00:00Z").reconcile({ orderId: order.id }), { ok: true, outcome: "UNCHANGED" });
  assert.deepEqual(await counters(m.id), [0, BigInt(0), 0, BigInt(0)]);
  // Replay and an out-of-order older answer change nothing and refund nothing more.
  assert.deepEqual(await service(0, "2026-10-26T09:00:00Z").reconcile({ orderId: order.id }), { ok: true, outcome: "STALE" });
  assert.deepEqual(await service(7, "2026-10-26T10:00:00Z").reconcile({ orderId: order.id }), { ok: true, outcome: "UNCHANGED" });
  assert.deepEqual(await counters(m.id), [0, BigInt(0), 0, BigInt(0)]);
  assert.equal((await redemptionsOf(order.id)).filter((r) => r.refundedAt !== null).length, 1);
});

test("status reconciliation: a status read that fails or is unusable is not a signal", async () => {
  const { order, m } = await acceptedOrder();
  await setState(order.id, "CONFIRMED");
  await prisma.orderMirror.update({ where: { id: order.id }, data: { pancakeOrderId: "8800123" } });
  let hook = 0;
  const failing = createPancakeOrderStatusReconciliationService(prisma, { async fetchOrderStatus() { throw new Error("timeout"); } }, { shopId: SHOP, async onTrustedCancel() { hook += 1; } });
  assert.deepEqual(await failing.reconcile({ orderId: order.id }), { ok: false, reason: "STATUS_UNAVAILABLE" });
  const otherShop = createPancakeOrderStatusReconciliationService(prisma, { async fetchOrderStatus() { return { ...upstream(7, "2026-10-26T10:00:00Z"), shopId: SHOP + 1 } as PancakeOrderStatus; } }, { shopId: SHOP, async onTrustedCancel() { hook += 1; } });
  assert.deepEqual(await otherShop.reconcile({ orderId: order.id }), { ok: false, reason: "STATUS_UNAVAILABLE" });
  assert.equal(hook, 0);
  assert.deepEqual(await counters(m.id), [1, BigInt(50_000), 0, BigInt(0)]);
});

test("the create-rejected path calls the refund hook after REJECTED; an ambiguous create (timeout) never does", async () => {
  // The submission service is driven for real; the order is a plain legacy draft, so the hook is observed rather than
  // run against the ledger (the refund itself is covered above).
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP, pancakeProductId: `${P}-p`, slug: `${P}-p`, name: "Refund hook", isPresent: true, isActive: true, syncedAt: new Date("2026-10-26T00:00:00Z"),
      variants: { create: { pancakeVariationId: `${P}-v`, color: "Black", size: "M", isPresent: true, isActive: true, pancakeRetailPrice: 500_000, pancakeRetailPriceAfterDiscount: 500_000, syncedAt: new Date("2026-10-26T00:00:00Z"),
        warehouseStocks: { create: { pancakeWarehouseId: `${P}-w`, quantity: 9, syncedAt: new Date("2026-10-26T00:00:00Z") } } } },
    },
    include: { variants: true },
  });
  const live = {
    id: `${P}-v`, productId: `${P}-p`, displayId: "d", barcode: "b", fields: [], imageUrls: [], isHidden: false, isLocked: false, retailPrice: 500_000, retailPriceAfterDiscount: 500_000,
    product: { id: `${P}-p`, name: "x" }, warehouseStocks: [{ warehouseId: `${P}-w`, remainQuantity: 9 }], sellableStock: 9,
  };
  async function drive(createOrder: () => Promise<unknown>) {
    const draft = await prisma.orderMirror.create({
      data: {
        publicCode: f.token(), state: "DRAFT", pancakeShopId: SHOP, ...checkout, districtRef: "d", merchandiseSubtotalVnd: BigInt(500_000), shippingFeeVnd: BigInt(30_000), totalVnd: BigInt(530_000),
        lines: { create: { variantId: product.variants[0]!.id, pancakeVariationId: `${P}-v`, productName: "Refund hook", size: "M", quantity: 1, unitPriceVnd: BigInt(500_000), lineTotalVnd: BigInt(500_000) } },
      },
    });
    const hooked: string[] = [];
    const result = await createPancakeOrderSubmissionService(
      prisma,
      { async fetchVariations() { return [live as never]; }, createOrder, async resolveTwoLevelAddressNames() { return { provinceName: "p", communeName: "c" }; } },
      { async onRejectedAfterAcceptance(o) { hooked.push(o.id); } },
    ).submit({ publicCode: draft.publicCode, shopId: SHOP });
    return { result, hooked, draft };
  }
  const rejected = await drive(async () => { throw new PancakeHttpError(422, "/orders"); });
  assert.deepEqual(rejected.result, { ok: false, state: "REJECTED", reason: "ORDER_REJECTED" });
  assert.deepEqual(rejected.hooked, [rejected.draft.id]);
  const unknown = await drive(async () => { throw new Error("socket hang up"); });
  assert.equal(unknown.result.ok === false && unknown.result.state, "SYNC_UNKNOWN");
  assert.deepEqual(unknown.hooked, [], "an unknown outcome is pending, never a refund");
});

test("SYNC_UNKNOWN reconciliation: confirmed absence calls the refund hook, an ambiguous answer does not", async () => {
  const absent = await prisma.orderMirror.create({ data: { publicCode: f.token(), state: "SYNC_UNKNOWN", pancakeShopId: SHOP, ...checkout, merchandiseSubtotalVnd: BigInt(1), shippingFeeVnd: BigInt(0), totalVnd: BigInt(1) } });
  const ambiguous = await prisma.orderMirror.create({ data: { publicCode: f.token(), state: "SYNC_UNKNOWN", pancakeShopId: SHOP, ...checkout, merchandiseSubtotalVnd: BigInt(1), shippingFeeVnd: BigInt(0), totalVnd: BigInt(1) } });
  const hooked: string[] = [];
  const service = (kind: "ABSENT" | "AMBIGUOUS") =>
    createPancakeOrderReconciliationService({
      client: prisma,
      gateway: { async searchOrderByMarker() { return kind === "ABSENT" ? ({ kind: "ABSENT" } as never) : ({ kind: "AMBIGUOUS", reason: "search unavailable" } as never); } },
      absenceConfirmationAttempts: 1,
      absenceConfirmationDelayMs: 0,
      async onConfirmed() {},
      async onRejected({ publicCode }) { hooked.push(publicCode); },
    });
  const rejected = await service("ABSENT").reconcileOrder(absent.publicCode);
  assert.equal(!rejected.ok && rejected.state, "REJECTED");
  const stillUnknown = await service("AMBIGUOUS").reconcileOrder(ambiguous.publicCode);
  assert.equal(!stillUnknown.ok && stillUnknown.state, "SYNC_UNKNOWN");
  assert.deepEqual(hooked, [absent.publicCode]);
});

test("the operator's admin-cancel: a dry run changes nothing, --apply returns the vouchers once with the evidence, a repeat is harmless, and unknown or voucher-less orders are refused", async () => {
  const { order, m, s } = await acceptedOrder({ shipping: true });
  const evidence = "staff cancelled order in Pancake UI, ticket 42";
  const dry = await adminCancelVoucherOrder(prisma, { order: order.publicCode, evidence, apply: false });
  assert.deepEqual(dry.ok && [dry.applied, dry.refunded, dry.redemptions.map((r) => [r.kind, r.amountVnd, r.alreadyRefunded])], [false, 0, [["MERCHANDISE", 50_000, false], ["SHIPPING_FREE", 30_000, false]]]);
  assert.deepEqual(await counters(m.id), [1, BigInt(50_000), 0, BigInt(0)], "a dry run touches nothing");

  const applied = await adminCancelVoucherOrder(prisma, { order: order.id, evidence, apply: true });
  assert.deepEqual(applied.ok && [applied.applied, applied.refunded], [true, 2]);
  assert.deepEqual(await counters(m.id), [0, BigInt(0), 0, BigInt(0)]);
  assert.deepEqual(await counters(s!.id), [0, BigInt(0), 0, BigInt(0)]);
  const rows = await redemptionsOf(order.id);
  assert.ok(rows.every((row) => row.refundReason === "ADMIN_CANCEL" && row.refundEvidence === `admin:${evidence}`));

  const again = await adminCancelVoucherOrder(prisma, { order: order.publicCode, evidence, apply: true });
  assert.deepEqual(again.ok && [again.refunded, again.redemptions.every((r) => r.alreadyRefunded)], [0, true]);
  assert.deepEqual(await counters(m.id), [0, BigInt(0), 0, BigInt(0)], "never refunded twice");

  assert.deepEqual(await adminCancelVoucherOrder(prisma, { order: "no-such-order", evidence, apply: true }), { ok: false, reason: "ORDER_NOT_FOUND" });
  const plain = await prisma.orderMirror.create({ data: { publicCode: f.token(), state: "REJECTED", pancakeShopId: SHOP } });
  assert.deepEqual(await adminCancelVoucherOrder(prisma, { order: plain.publicCode, evidence, apply: true }), { ok: false, reason: "NO_REDEMPTION" });
});
