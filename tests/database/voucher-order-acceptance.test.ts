import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../src/generated/prisma/client.ts";
import { createVoucherOrderAcceptance, recordVoucherOrderSnapshot, type VoucherAcceptanceResult } from "../../src/commerce/voucher-order-acceptance.ts";
import { buildVoucherOrderSnapshot } from "../../src/commerce/voucher-order-snapshot.ts";
import { createVoucherHoldFlow } from "../../src/commerce/voucher-hold-flow.ts";
import { createVoucherHoldService, voucherAttemptKey } from "../../src/commerce/voucher-hold-service.ts";
import { readVoucherPreview } from "../../src/commerce/voucher-preview.ts";
import { GIFT_SLOTS_VARIATION } from "../../src/commerce/voucher-quote-facts.ts";
import { voucherQuoteDigest, type VoucherProofLine } from "../../src/commerce/voucher-quote-proof.ts";
import { createVoucherFixtures } from "../support/voucher-fixtures.ts";

/**
 * V13 against a real database: the website accepts the order and consumes its vouchers in ONE transaction.
 * Holds come from the real V12 flow wherever a quote is needed, so the digest compared at acceptance is the one the
 * buyer actually agreed to (ADR 0018 D-3, ADR 0019). The order side is what the checkout snapshot (V18) will write:
 * a DRAFT order with its frozen quote rows and its voucher declaration.
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const SHOP = 940_013;
const P = "vchr-accept";
const SECRET = "voucher-accept-test-secret-0123456789abcdef";
const f = createVoucherFixtures(prisma, SHOP, P);
const PAST = new Date("2026-10-01T00:00:00.000Z");
// A hold is only granted where checkout can honour it: the gift/quantity gate and a line-level-verified shop are part of readiness.
const ENV = { LA_VOUCHER_ENABLED: "true", LA_PANCAKE_VOUCHER_VERIFIED_SHOP_IDS: String(SHOP), LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true", LA_PANCAKE_LINE_LEVEL_PRICING_VERIFIED_SHOP_IDS: String(SHOP) } as const;
const flow = createVoucherHoldFlow(prisma, { shopId: SHOP, attemptSecret: SECRET, proofSecret: SECRET, env: ENV });
const service = createVoucherHoldService(prisma, { attemptSecret: SECRET, env: ENV });
const acceptance = createVoucherOrderAcceptance({ readAttemptSecret: () => SECRET });
const accept = (orderId: string): Promise<VoucherAcceptanceResult> => prisma.$transaction((tx) => acceptance.acceptWithin(tx, { orderId }));

const stripSegment = (lineId: string) => lineId.replace(/\|v\d+$/, "");
const checkout = { checkoutSnapshottedAt: new Date(), guestName: "Test", guestPhone: "0900000000", provinceRef: "p", communeRef: "c", addressDetail: "a" };

async function cleanup() {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    const orders = await tx.orderMirror.findMany({ where: { pancakeShopId: SHOP }, select: { id: true } });
    const ids = orders.map((order) => order.id);
    await tx.voucherRedemption.deleteMany({ where: { orderId: { in: ids } } });
    await tx.voucherHold.deleteMany({ where: { campaign: { pancakeShopId: SHOP } } });
    await tx.orderAcceptance.deleteMany({ where: { orderId: { in: ids } } });
    await tx.orderVoucherSnapshot.deleteMany({ where: { orderId: { in: ids } } });
    const snapshots = await tx.orderQuoteSnapshot.findMany({ where: { orderId: { in: ids } }, select: { id: true } });
    await tx.orderQuoteLine.deleteMany({ where: { snapshotId: { in: snapshots.map((s) => s.id) } } });
    await tx.orderQuoteSnapshot.deleteMany({ where: { orderId: { in: ids } } });
    await tx.orderMirror.deleteMany({ where: { id: { in: ids } } });
    await tx.voucherCampaign.deleteMany({ where: { pancakeShopId: SHOP } });
  });
  await prisma.cart.deleteMany({ where: { items: { some: { variant: { product: { pancakeShopId: SHOP } } } } } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP } });
}
test.before(cleanup);
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});
test.beforeEach(cleanup);

let sequence = 0;
async function product(price: number, stock = 50) {
  sequence += 1;
  const created = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP, pancakeProductId: `${P}-${sequence}`, slug: `${P}-${sequence}`, name: `Voucher accept ${sequence}`, isActive: true, isPresent: true, syncedAt: PAST,
      variants: { create: { pancakeVariationId: `${P}-${sequence}-var`, color: "Black", size: "M", isActive: true, isPresent: true, pancakeRetailPrice: price, pancakeRetailPriceAfterDiscount: price, syncedAt: PAST,
        warehouseStocks: { create: { pancakeWarehouseId: `${P}-wh-${sequence}`, quantity: stock, syncedAt: PAST } } } },
    },
    include: { variants: true },
  });
  return created.variants[0]!.id;
}
const cart = (items: ReadonlyArray<{ variantId: string; quantity: number }>) =>
  prisma.cart.create({ data: { expiresAt: new Date(Date.now() + 86_400_000), items: { create: items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })) } } });

async function shown(cartId: string) {
  const preview = await readVoucherPreview({ client: prisma, cartId, shopId: SHOP, now: new Date(), env: ENV, ownHolds: await service.readOwnLiveHolds(cartId) });
  if (!preview.enabled || !preview.ok) throw new Error(`preview unavailable: ${JSON.stringify(preview, (_k, v) => (typeof v === "bigint" ? String(v) : v))}`);
  return preview;
}

/**
 * What the real checkout snapshot (V18) freezes for this cart: the held quote's segments and money as quote rows,
 * plus the voucher declaration, all on a DRAFT order that then moves on like a real submission.
 */
type OrderShape = Readonly<{ gift?: ReadonlyArray<{ variation: string; quantity: number }>; mutateShipping?: number; mutateUnit?: number; ignoreVoucher?: boolean; declare?: boolean }>;
async function orderFor(cartId: string, shape: OrderShape = {}, state: "POS_SUBMITTING" | "DRAFT" = "POS_SUBMITTING") {
  const preview = await shown(cartId);
  const paid = shape.ignoreVoucher ? preview.lines : preview.quote.linesAfter;
  const unit = (line: { unitPriceVnd: number }) => line.unitPriceVnd + (shape.mutateUnit ?? 0);
  const lines = paid.map((line, index) => ({
    lineId: `P:${index}`, role: "PAID" as const, variantId: stripSegment(line.lineId), pancakeVariationId: preview.variationOfLine.get(stripSegment(line.lineId))!,
    quantity: line.quantity, unitPriceVnd: BigInt(unit(line)), lineTotalVnd: BigInt(unit(line) * line.quantity), fulfillmentState: "READY" as const,
  }));
  const gifts = (shape.gift ?? []).map((gift, index) => ({
    lineId: `G:${index}`, role: "GIFT" as const, variantId: `gift-${index}`, pancakeVariationId: gift.variation, quantity: gift.quantity, unitPriceVnd: BigInt(0), lineTotalVnd: BigInt(0),
    fulfillmentState: "READY" as const, campaignId: "gift-campaign", campaignRevision: 1,
  }));
  const giftUnits = gifts.reduce((sum, gift) => sum + gift.quantity, 0);
  const paidSubtotal = lines.reduce((sum, line) => sum + line.lineTotalVnd, BigInt(0));
  const shipping = BigInt(shape.mutateShipping ?? (shape.ignoreVoucher ? preview.quote.shippingFeeBeforeVoucherVnd : preview.quote.shippingFeeVnd));
  const total = paidSubtotal + shipping;
  const quoteDigest = f.hex(`quote-${f.token()}`);
  const created = await prisma.orderMirror.create({
    data: {
      publicCode: f.token(), state: "DRAFT", sourceCartId: cartId, pancakeShopId: SHOP, ...checkout,
      merchandiseSubtotalVnd: paidSubtotal, shippingFeeVnd: shipping, totalVnd: total,
      quoteSnapshot: {
        create: {
          quoteFormat: "laq3", quoteDigest, paidSubtotalVnd: paidSubtotal, shippingFeeVnd: shipping, totalVnd: total,
          paidQuantity: lines.reduce((sum, line) => sum + line.quantity, 0), giftQuantity: gifts.reduce((sum, gift) => sum + gift.quantity, 0), unclaimedSlots: 0, nonclaimAcknowledged: false,
          lines: { create: [...lines, ...gifts] },
          ...(gifts.length === 0 ? {} : { entitlements: { create: { campaignId: "gift-campaign", campaignRevision: 1, entitled: giftUnits, selected: giftUnits, unclaimed: 0, skippedWhileAvailable: 0, contendedForSharedStock: 0, shortForStock: 0 } } }),
        },
      },
    },
  });
  const campaigns = await prisma.voucherCampaign.findMany({ where: { pancakeShopId: SHOP }, select: { id: true, revision: true } });
  const snapshot = buildVoucherOrderSnapshot({ quote: preview.quote, revisions: new Map(campaigns.map((c) => [c.id, c.revision])) });
  if (shape.declare !== false) await prisma.$transaction((tx) => recordVoucherOrderSnapshot(tx, { orderId: created.id, snapshot }));
  if (state === "POS_SUBMITTING") await advance(created.id);
  return { ...created, quoteDigest, preview, snapshot };
}
async function advance(orderId: string) {
  await prisma.orderMirror.update({ where: { id: orderId }, data: { state: "VALIDATING" } });
  await prisma.orderMirror.update({ where: { id: orderId }, data: { state: "POS_SUBMITTING" } });
}

const fixed = (amountVnd: number, min: number, extra: Record<string, unknown> = {}) => f.campaign({ fixedAmountVnd: BigInt(amountVnd), minEligibleSubtotalVnd: BigInt(min), ...extra });
const campaignRow = (id: string) => prisma.voucherCampaign.findUniqueOrThrow({ where: { id } });
const marker = (orderId: string) => prisma.orderAcceptance.findUnique({ where: { orderId } });
const holdsOf = (cartId: string) => prisma.voucherHold.findMany({ where: { attemptKey: voucherAttemptKey(cartId, SECRET) }, orderBy: { kind: "asc" } });
const states = async (cartId: string) => (await holdsOf(cartId)).map((h) => h.state);

/** A cart with both vouchers held through the real V12 flow, and an order frozen from the held quote. */
async function heldOrder(extra: OrderShape = {}) {
  const c = await cart([{ variantId: await product(450_000), quantity: 2 }]);
  const m = await fixed(50_000, 600_000, { maxUses: 5, maxBudgetVnd: BigInt(1_000_000) });
  const s = await f.shippingCampaign({ minEligibleSubtotalVnd: BigInt(600_000), maxUses: 5, maxBudgetVnd: BigInt(1_000_000) });
  const held = await flow.hold({ cartId: c.id, expectedQuoteDigest: (await shown(c.id)).quoteDigest! });
  assert.equal(held.ok && held.state === "HELD", true, JSON.stringify(held));
  const order = await orderFor(c.id, extra);
  return { c, m, s, order };
}

test("EX-01 / AC-17: accepting consumes both holds, writes the marker and redemptions, and moves reserved to redeemed in one transaction", async () => {
  const { c, m, s, order } = await heldOrder();
  const result = await accept(order.id);
  assert.ok(result.ok && result.applied && !result.replayed, JSON.stringify(result));
  assert.deepEqual(result.vouchers.map((v) => [v.kind, v.campaignId, v.amountVnd]), [["MERCHANDISE", m.id, 50_000], ["SHIPPING_FREE", s.id, 30_000]]);

  assert.equal((await marker(order.id))?.quoteDigest, order.quoteDigest, "the marker carries the digest of the order's own frozen quote");
  const holds = await holdsOf(c.id);
  assert.deepEqual(holds.map((h) => [h.state, h.orderId]), [["CONSUMED", order.id], ["CONSUMED", order.id]]);
  assert.ok(holds.every((h) => h.consumedAt !== null));
  const redemptions = await prisma.voucherRedemption.findMany({ where: { orderId: order.id }, orderBy: { kind: "asc" } });
  assert.deepEqual(redemptions.map((r) => [r.kind, r.amountVnd, r.refundedAt]), [["MERCHANDISE", BigInt(50_000), null], ["SHIPPING_FREE", BigInt(30_000), null]]);
  assert.equal(redemptions[0]!.websiteAcceptedAt.getTime(), (await marker(order.id))!.acceptedAt.getTime());
  for (const [campaign, vnd] of [[m, 50_000], [s, 30_000]] as const) {
    const row = await campaignRow(campaign.id);
    assert.deepEqual([row.reservedUses, row.reservedVnd, row.redeemedUses, row.redeemedVnd], [0, BigInt(0), 1, BigInt(vnd)]);
  }

  // The order is now frozen (ADR 0018 D-2) but can still move through POS.
  await assert.rejects(() => prisma.orderMirror.update({ where: { id: order.id }, data: { totalVnd: BigInt(1) } }), /immutable/i);
  await assert.rejects(() => prisma.orderVoucherSnapshot.delete({ where: { orderId: order.id } }), /cannot change once the order has left DRAFT/i);
  await prisma.orderMirror.update({ where: { id: order.id }, data: { state: "SYNC_UNKNOWN", syncErrorCode: "CREATE_OUTCOME_UNKNOWN" } });
});

test("AC-18: replay, double click and two tabs consume exactly once and the loser reads the winner's result", async () => {
  const { m, order } = await heldOrder();
  const results = await Promise.all([accept(order.id), accept(order.id), accept(order.id), accept(order.id)]);
  assert.ok(results.every((r) => r.ok && r.applied), JSON.stringify(results));
  assert.equal(results.filter((r) => r.ok && r.applied && !r.replayed).length, 1, "exactly one winner");
  assert.equal(await prisma.orderAcceptance.count({ where: { orderId: order.id } }), 1);
  assert.equal(await prisma.voucherRedemption.count({ where: { orderId: order.id } }), 2);
  const row = await campaignRow(m.id);
  assert.deepEqual([row.reservedUses, row.redeemedUses, row.redeemedVnd], [0, 1, BigInt(50_000)]);
  const later = await accept(order.id);
  assert.ok(later.ok && later.applied && later.replayed);
});

test("a plain order (no declaration) is untouched: nothing is written, the secret is not even read", async () => {
  const c = await cart([{ variantId: await product(450_000), quantity: 2 }]);
  const plain = await orderFor(c.id, { ignoreVoucher: true, declare: false });
  const noSecret = createVoucherOrderAcceptance({ readAttemptSecret: () => { throw new Error("must not be read"); } });
  assert.deepEqual(await prisma.$transaction((tx) => noSecret.acceptWithin(tx, { orderId: plain.id })), { ok: true, applied: false });
  assert.equal(await marker(plain.id), null);
  assert.deepEqual(await accept("missing-order"), { ok: false, reason: "ORDER_NOT_FOUND" });
});

test("a voucher order whose holds were released is refused, never accepted as a plain order", async () => {
  const { c, order } = await heldOrder();
  const revision = (await prisma.cart.findUniqueOrThrow({ where: { id: c.id } })).paidRevision;
  const released = await service.hold({ shopId: SHOP, cartId: c.id, paidRevision: Number(revision), quoteDigest: f.hex("none"), grants: [], releaseUnlisted: true });
  assert.equal(released.ok, true, JSON.stringify(released));
  assert.deepEqual(await states(c.id), ["RELEASED", "RELEASED"]);
  assert.deepEqual(await accept(order.id), { ok: false, reason: "HOLD_UNAVAILABLE" });
  assert.equal(await marker(order.id), null);
});

test("AC-32: a hold that reached its expiry by the database clock is refused; nothing is accepted or consumed", async () => {
  const c = await cart([{ variantId: await product(450_000), quantity: 2 }]);
  const m = await fixed(50_000, 600_000, { maxUses: 2, reservedUses: 1, reservedVnd: BigInt(50_000) });
  const order = await orderFor(c.id);
  const createdAt = new Date(Date.now() - 11 * 60_000);
  await f.hold(m.id, { attemptKey: voucherAttemptKey(c.id, SECRET), heldDiscountVnd: BigInt(50_000), createdAt, expiresAt: new Date(createdAt.getTime() + 600_000) });
  assert.deepEqual(await accept(order.id), { ok: false, reason: "HOLD_UNAVAILABLE" });
  assert.equal(await marker(order.id), null);
  const row = await campaignRow(m.id);
  assert.deepEqual([row.reservedUses, row.redeemedUses], [1, 0]);
  assert.deepEqual(await states(c.id), ["HELD"], "the refusal leaves the hold for its own expiry");
});

test("crash inside the acceptance transaction: everything rolls back, the holds are still HELD and the counters unchanged", async () => {
  const { c, m, order } = await heldOrder();
  await assert.rejects(
    () => prisma.$transaction(async (tx) => {
      const result = await acceptance.acceptWithin(tx, { orderId: order.id });
      assert.ok(result.ok && result.applied);
      throw new Error("process died before commit");
    }),
    /process died/,
  );
  assert.equal(await marker(order.id), null);
  assert.equal(await prisma.voucherRedemption.count({ where: { orderId: order.id } }), 0);
  assert.deepEqual(await states(c.id), ["HELD", "HELD"]);
  const row = await campaignRow(m.id);
  assert.deepEqual([row.reservedUses, row.redeemedUses], [1, 0]);
  const retry = await accept(order.id);
  assert.ok(retry.ok && retry.applied && !retry.replayed, "a retry after the crash accepts normally");
});

test("AC-38 ABA: the cart moved after the hold (even if it moved back) is CART_CHANGED, never a silent accept", async () => {
  const { c, order } = await heldOrder();
  await prisma.$executeRaw`UPDATE "Cart" SET "paidRevision" = "paidRevision" + 1 WHERE "id" = ${c.id}`;
  assert.deepEqual(await accept(order.id), { ok: false, reason: "CART_CHANGED" });
  assert.equal(await marker(order.id), null);
  assert.deepEqual(await states(c.id), ["HELD", "HELD"]);
});

test("AC-38: an order whose frozen quote is not the one the holds promised is QUOTE_MISMATCH (price, shipping, voucher not applied)", async () => {
  for (const shape of [{ mutateUnit: 1 }, { mutateShipping: 1 }, { ignoreVoucher: true }] as const) {
    await cleanup();
    const { c, order } = await heldOrder(shape);
    assert.deepEqual(await accept(order.id), { ok: false, reason: "QUOTE_MISMATCH" }, JSON.stringify(shape));
    assert.equal(await marker(order.id), null);
    assert.deepEqual(await states(c.id), ["HELD", "HELD"]);
  }
});

test("a declaration that names another campaign, revision or amount than the live hold is refused", async () => {
  for (const change of [
    (m: Record<string, unknown>) => ({ ...m, campaignId: "other-campaign" }),
    (m: Record<string, unknown>) => ({ ...m, campaignRevision: 2 }),
  ]) {
    await cleanup();
    const c = await cart([{ variantId: await product(450_000), quantity: 2 }]);
    await fixed(50_000, 600_000, { maxUses: 5 });
    await flow.hold({ cartId: c.id, expectedQuoteDigest: (await shown(c.id)).quoteDigest! });
    const order = await orderFor(c.id, { declare: false }, "DRAFT");
    const forged = { ...order.snapshot, merchandise: order.snapshot.merchandise.map((entry) => change(entry as unknown as Record<string, unknown>)) };
    await prisma.$executeRaw`INSERT INTO "OrderVoucherSnapshot" ("id", "orderId", "snapshot") VALUES (${`ovs_${f.token()}`}, ${order.id}, ${JSON.stringify(forged)}::jsonb)`;
    await advance(order.id);
    assert.deepEqual(await accept(order.id), { ok: false, reason: "HOLD_UNAVAILABLE" });
    assert.deepEqual(await states(c.id), ["HELD"]);
  }
});

test("declaration rules: insert-only, DRAFT-only, at least one voucher", async () => {
  const c = await cart([{ variantId: await product(450_000), quantity: 2 }]);
  await fixed(50_000, 600_000);
  const draft = await orderFor(c.id, {}, "DRAFT");
  const row = await prisma.orderVoucherSnapshot.findUniqueOrThrow({ where: { orderId: draft.id } });
  await assert.rejects(() => prisma.orderVoucherSnapshot.update({ where: { id: row.id }, data: { snapshot: { v: 1 } } }), /insert-only/i);
  await assert.rejects(
    () => prisma.$transaction((tx) => recordVoucherOrderSnapshot(tx, { orderId: draft.id, snapshot: { v: 2, merchandise: [], shipping: null, paidBeforeVnd: 1, paidAfterVnd: 1, shippingFeeBeforeVoucherVnd: 0, shippingFeeVnd: 0, totalVnd: 1 } })),
    /at least one voucher/i,
  );
  await prisma.orderVoucherSnapshot.delete({ where: { id: row.id } }); // still a DRAFT and unaccepted
  await advance(draft.id);
  await assert.rejects(() => prisma.$transaction((tx) => recordVoucherOrderSnapshot(tx, { orderId: draft.id, snapshot: draft.snapshot })), /left DRAFT/i);
});

test("V13 gate: the voucher proof binds the gift SLOT COUNT; gift A -> B at the same count is accepted, a different count is not", async () => {
  async function scenario(orderGift: ReadonlyArray<{ variation: string; quantity: number }>, promisedSlots: number) {
    await cleanup();
    const c = await cart([{ variantId: await product(450_000), quantity: 2 }]);
    const m = await fixed(50_000, 600_000);
    const preview = await shown(c.id);
    const cartRow = await prisma.cart.findUniqueOrThrow({ where: { id: c.id } });
    const lines: VoucherProofLine[] = preview.quote.linesAfter.map((l) => ({
      pancakeVariationId: preview.variationOfLine.get(stripSegment(l.lineId))!, quantity: l.quantity, unitPriceVnd: l.unitPriceVnd, role: "PAID",
    }));
    if (promisedSlots > 0) lines.push({ pancakeVariationId: GIFT_SLOTS_VARIATION, quantity: promisedSlots, unitPriceVnd: 0, role: "GIFT" });
    // The digest V12 stores for a quote with exactly `promisedSlots` retained gift slots.
    const quoteDigest = voucherQuoteDigest({
      state: "PREVIEW", paidRevision: cartRow.paidRevision, lines, paidSubtotalVnd: Number(preview.quote.paidAfterVnd), shippingFeeVnd: preview.quote.shippingFeeVnd, totalVnd: preview.quote.totalPayableVnd,
      merchandise: [{ campaignId: m.id, campaignRevision: m.revision, amountVnd: 50_000, hold: null }], shipping: null,
    });
    await prisma.voucherCampaign.update({ where: { id: m.id }, data: { reservedUses: 1, reservedVnd: BigInt(50_000) } });
    await f.hold(m.id, { attemptKey: voucherAttemptKey(c.id, SECRET), heldDiscountVnd: BigInt(50_000), quoteDigest, paidRevision: cartRow.paidRevision, campaignRevision: m.revision });
    return accept((await orderFor(c.id, { gift: orderGift })).id);
  }
  for (const variation of ["gift-variation-A", "gift-variation-B"]) {
    const result = await scenario([{ variation, quantity: 1 }], 1);
    assert.ok(result.ok && result.applied, `${variation} at the same count must be accepted: ${JSON.stringify(result)}`);
  }
  assert.deepEqual(await scenario([{ variation: "gift-variation-A", quantity: 2 }], 1), { ok: false, reason: "QUOTE_MISMATCH" }, "two gift slots is not the quote with one");
  assert.deepEqual(await scenario([], 1), { ok: false, reason: "QUOTE_MISMATCH" }, "no gift is not the quote with one");
  assert.deepEqual(await scenario([{ variation: "gift-variation-A", quantity: 1 }], 0), { ok: false, reason: "QUOTE_MISMATCH" }, "a gift the voucher quote never promised");
});

test("a hold of another cart's attempt cannot be consumed by this order", async () => {
  const { order } = await heldOrder();
  const other = await cart([{ variantId: await product(450_000), quantity: 2 }]);
  await prisma.$executeRaw`UPDATE "OrderMirror" SET "sourceCartId" = ${other.id} WHERE "id" = ${order.id}`;
  assert.deepEqual(await accept(order.id), { ok: false, reason: "HOLD_UNAVAILABLE" });
  assert.equal(await marker(order.id), null);
});

test("POS SYNC_UNKNOWN after acceptance keeps the redemption: no refund, no counter change (refund is V14's trusted-signal path only)", async () => {
  const { m, order } = await heldOrder();
  assert.ok((await accept(order.id)).ok);
  await prisma.orderMirror.update({ where: { id: order.id }, data: { state: "SYNC_UNKNOWN", syncErrorCode: "CREATE_OUTCOME_UNKNOWN" } });
  const redemptions = await prisma.voucherRedemption.findMany({ where: { orderId: order.id } });
  assert.ok(redemptions.length === 2 && redemptions.every((r) => r.refundedAt === null && r.refundReason === null));
  const row = await campaignRow(m.id);
  assert.deepEqual([row.redeemedUses, row.reservedUses], [1, 0]);
  const again = await accept(order.id);
  assert.ok(again.ok && again.applied && again.replayed, "a retry of the same order still answers with the winner's result");
});
