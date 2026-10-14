import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { replaceOrderQuoteSnapshot, readOrderQuoteSnapshot } from "../../src/commerce/order-quote-snapshot.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

// The pixel id is read when the reporting module first loads (the CSP is built from the same value),
// so it is set before that module is imported.
process.env.LA_BUILD_FACEBOOK_PIXEL_ID = "123456789012345";
const { readMetaPurchaseSnapshot } = await import("../../src/commerce/meta-purchase-snapshot.ts");
const { reportMetaPurchase } = await import("../../src/commerce/meta-purchase-reporting.ts");

/**
 * GQ22 -- what analytics says about an order that carries gifts. The Purchase event is revenue: it must
 * describe the money the buyer paid (gifts are 0đ and contribute nothing), list only paid segments, be
 * sent once however often reporting is retried, and leave the gift's identity in the order audit.
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const P = "gq22";
const CODE = `${P.toUpperCase()}-ORDER-1`;
const NOW = new Date("2026-10-14T12:00:00.000Z");

async function cleanup() {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw`DELETE FROM "OrderQuoteDiscountStep" WHERE "lineRowId" IN (SELECT l."id" FROM "OrderQuoteLine" l JOIN "OrderQuoteSnapshot" s ON s."id" = l."snapshotId" JOIN "OrderMirror" o ON o."id" = s."orderId" WHERE o."publicCode" = ${CODE})`;
    await tx.$executeRaw`DELETE FROM "OrderQuoteLine" WHERE "snapshotId" IN (SELECT s."id" FROM "OrderQuoteSnapshot" s JOIN "OrderMirror" o ON o."id" = s."orderId" WHERE o."publicCode" = ${CODE})`;
    await tx.$executeRaw`DELETE FROM "OrderQuoteEntitlement" WHERE "snapshotId" IN (SELECT s."id" FROM "OrderQuoteSnapshot" s JOIN "OrderMirror" o ON o."id" = s."orderId" WHERE o."publicCode" = ${CODE})`;
    await tx.$executeRaw`DELETE FROM "OrderQuoteSnapshot" WHERE "orderId" IN (SELECT "id" FROM "OrderMirror" WHERE "publicCode" = ${CODE})`;
    await tx.$executeRaw`DELETE FROM "OrderLineSnapshot" WHERE "orderId" IN (SELECT "id" FROM "OrderMirror" WHERE "publicCode" = ${CODE})`;
    await tx.$executeRaw`DELETE FROM "OrderMirror" WHERE "publicCode" = ${CODE}`;
  });
}

/** A CONFIRMED benefit order: 2 x 100.001đ + 1 x 90.001đ paid (one variation), 1 gift of that same variation, shipping 30.000đ. */
async function confirmedBenefitOrder() {
  const order = await prisma.orderMirror.create({
    data: {
      publicCode: CODE, state: "DRAFT", pancakeShopId: 910_220, guestName: "Nguyễn Văn A", guestPhone: "0901234567", checkoutSnapshottedAt: NOW, provinceRef: "p", communeRef: "c", addressDetail: "a",
      merchandiseSubtotalVnd: BigInt(290_003), shippingFeeVnd: BigInt(30_000), totalVnd: BigInt(320_003),
    },
  });
  for (const [quantity, unit] of [[2, 100_001], [1, 90_001]] as const) {
    await prisma.orderLineSnapshot.create({
      data: { orderId: order.id, variantId: "variant-p", pancakeVariationId: "var-p", metaContentId: "content-p", productName: "P", size: "M", quantity, unitPriceVnd: BigInt(unit), lineTotalVnd: BigInt(unit * quantity) },
    });
  }
  const written = await prisma.$transaction((tx) => replaceOrderQuoteSnapshot(tx, order.id, {
    quoteFormat: "laq3", quoteDigest: "c".repeat(64), paidSubtotalVnd: 290_003, shippingFeeVnd: 30_000, totalVnd: 320_003,
    lines: [
      { lineId: "P:var-p:0", role: "PAID", variantId: "variant-p", pancakeVariationId: "var-p", quantity: 2, unitPriceVnd: 100_001, lineTotalVnd: 200_002, baseUnitPriceVnd: null, fulfillmentState: "READY", campaign: null, discountSteps: [] },
      { lineId: "P:var-p:1", role: "PAID", variantId: "variant-p", pancakeVariationId: "var-p", quantity: 1, unitPriceVnd: 90_001, lineTotalVnd: 90_001, baseUnitPriceVnd: 100_001, fulfillmentState: "READY", campaign: null, discountSteps: [{ campaignId: "tier-1", source: "QUANTITY_TIER", campaignKind: "QUANTITY_TIER", priority: 1, inputPriceVnd: 100_001, outputPriceVnd: 90_001, appliedQuantity: 1 }] },
      { lineId: "G:camp-1:var-p", role: "GIFT", variantId: "variant-p", pancakeVariationId: "var-p", quantity: 1, unitPriceVnd: 0, lineTotalVnd: 0, baseUnitPriceVnd: null, fulfillmentState: "READY", campaign: { id: "camp-1", revision: 2 }, discountSteps: [] },
    ],
    entitlements: [{ campaignId: "camp-1", campaignRevision: 2, entitled: 1, selected: 1, skippedWhileAvailable: 0, contendedForSharedStock: 0, shortForStock: 0 }],
    acknowledgedAt: null,
  }));
  assert.deepEqual(written, { ok: true });
  await prisma.orderMirror.update({ where: { id: order.id }, data: { state: "CONFIRMED", pancakeOrderId: "910220001", purchaseOccurredAt: NOW } });
  return order;
}

test.beforeEach(cleanup);
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("GQ22: the Purchase facts are the money paid: paid segments only, total = paid + shipping, no gift revenue", async () => {
  await confirmedBenefitOrder();
  const facts = await readMetaPurchaseSnapshot(prisma, CODE);
  assert.ok(facts);
  assert.equal(facts.valueVnd, 320_003);
  assert.deepEqual(facts.contents.map((content) => [content.id, content.quantity, content.itemPrice]), [["content-p", 2, 100_001], ["content-p", 1, 90_001]]);
  const reported = facts.contents.reduce((sum, content) => sum + content.quantity * content.itemPrice, 0);
  assert.equal(reported + 30_000, facts.valueVnd, "the item list agrees with its own total");
  assert.equal(facts.contents.some((content) => content.itemPrice === 0), false, "a 0đ gift is not a purchased item");
});

test("GQ22: the gift keeps its own identity in the order audit, apart from the paid units of the same variation", async () => {
  const order = await confirmedBenefitOrder();
  const audit = (await readOrderQuoteSnapshot(prisma, order.id))!;
  const gift = audit.lines.find((line) => line.role === "GIFT")!;
  assert.deepEqual([gift.pancakeVariationId, gift.quantity, gift.unitPriceVnd, gift.campaign], ["var-p", 1, 0, { id: "camp-1", revision: 2 }]);
  assert.equal(audit.paidQuantity, 3);
  assert.equal(audit.giftQuantity, 1);
  assert.equal(audit.lines.filter((line) => line.role === "PAID").length, 2);
});

test("GQ22: retries and replays send one Purchase with the same event id and facts", async () => {
  await confirmedBenefitOrder();
  process.env.FACEBOOK_CAPI_ACCESS_TOKEN = "test-token";
  process.env.LA_META_FIRST_PARTY_COOKIES_ENABLED = "true";
  try {
    const bodies: Array<{ data: Array<{ event_id: string; custom_data: { value: number; contents: Array<{ id: string; quantity: number; item_price: number }> } }> }> = [];
    const fetchImpl: typeof fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return Response.json({ events_received: 1, fbtrace_id: "t" }); };
    const when = new Date(NOW.getTime() + 60_000);
    await reportMetaPurchase(prisma, CODE, null, { now: when, fetchImpl });
    await reportMetaPurchase(prisma, CODE, null, { now: new Date(when.getTime() + 1000), fetchImpl });
    await reportMetaPurchase(prisma, CODE, null, { now: new Date(when.getTime() + 2000), fetchImpl });
    assert.equal(bodies.length, 1, "the event is sent once");
    const event = bodies[0]!.data[0]!;
    assert.equal(event.event_id, CODE);
    assert.equal(event.custom_data.value, 320_003);
    assert.deepEqual(event.custom_data.contents.map((content) => [content.id, content.quantity, content.item_price]), [["content-p", 2, 100_001], ["content-p", 1, 90_001]]);
  } finally {
    delete process.env.FACEBOOK_CAPI_ACCESS_TOKEN;
    delete process.env.LA_META_FIRST_PARTY_COOKIES_ENABLED;
  }
});

test("GQ22: an order that is not CONFIRMED reports nothing, gifts or not", async () => {
  const order = await confirmedBenefitOrder();
  await prisma.orderMirror.update({ where: { id: order.id }, data: { state: "SYNC_UNKNOWN" } });
  assert.equal(await readMetaPurchaseSnapshot(prisma, CODE), null);
});
