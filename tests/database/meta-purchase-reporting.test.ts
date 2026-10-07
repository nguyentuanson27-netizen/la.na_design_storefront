import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { readMetaPurchaseSnapshot } from "../../src/commerce/meta-purchase-snapshot.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

// The pixel id is captured when the config module first loads, because the Content-Security-Policy
// is built from the same value and the two must agree. Setting it after the fact would be a no-op,
// so it is set here and the reporting module is pulled in afterwards. This is the key next.config
// inlines at build time, which is what the config module actually reads.
process.env.LA_BUILD_FACEBOOK_PIXEL_ID = "123456789012345";
const { reportMetaPurchase, reportMetaPurchaseSafely, saveMetaPurchaseContextSafely, cleanupMetaPurchaseAttributionSafely } = await import(
  "../../src/commerce/meta-purchase-reporting.ts"
);
const { createPancakeOrderReconciliationService } = await import("../../src/commerce/pancake-order-reconciliation.ts");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required for database smoke tests");
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const shopId = 910_090;
const orderCode = "META-TEST-0001";
const syncedAt = new Date("2026-08-29T03:00:00.000Z");
const reportedAt = new Date("2026-08-29T04:00:00.000Z");

const requestContext = {
  clientIpAddress: "203.0.113.9",
  clientUserAgent: "Mozilla/5.0",
  fbp: "fb.1.1700000000000.1234567890",
  fbc: "fb.1.1700000000000.AbCd",
  eventSourceUrl: "https://example.test/checkout",
} as const;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function cleanup() {
  await prisma.orderMirror.deleteMany({ where: { publicCode: orderCode } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: shopId } });
}

async function seedConfirmedOrder(state: "CONFIRMED" | "DRAFT" | "SYNC_UNKNOWN" = "CONFIRMED") {
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: shopId,
      pancakeProductId: "meta-product",
      slug: "meta-linen-shirt",
      name: "Áo Linen",
      isPresent: true,
      isActive: true,
      syncedAt,
    },
  });
  const variant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: "meta-variation",
      productId: product.id,
      color: "Ink",
      size: "M",
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 449_000,
      pancakeRetailPriceAfterDiscount: 449_000,
      syncedAt,
    },
  });
  const order = await prisma.orderMirror.create({
    data: {
      publicCode: orderCode,
      state,
      pancakeShopId: shopId,
      checkoutSnapshottedAt: syncedAt,
      purchaseOccurredAt: syncedAt,
      guestName: "Nguyễn Văn An",
      guestPhone: "0912345678",
      provinceRef: "1",
      districtRef: "2",
      communeRef: "3",
      addressDetail: "12 Nguyễn Huệ",
      note: "",
      merchandiseSubtotalVnd: BigInt(898_000),
      shippingFeeVnd: BigInt(30_000),
      totalVnd: BigInt(928_000),
    },
  });
  await prisma.orderLineSnapshot.create({
    data: {
      orderId: order.id,
      variantId: variant.id,
      pancakeVariationId: variant.pancakeVariationId,
      metaContentId: product.slug,
      productName: "Áo Linen",
      color: "Ink",
      size: "M",
      quantity: 2,
      unitPriceVnd: BigInt(449_000),
      lineTotalVnd: BigInt(898_000),
    },
  });
}

/** The access token is read per call, so it is what turns server reporting on and off here. */
function withConversionsEnv<T>(run: () => Promise<T>): Promise<T> {
  process.env.FACEBOOK_CAPI_ACCESS_TOKEN = "test-token";
  return run().finally(() => {
    delete process.env.FACEBOOK_CAPI_ACCESS_TOKEN;
  });
}

test.beforeEach(cleanup);
test.afterEach(cleanup);
test.after(async () => prisma.$disconnect());

test("the purchase snapshot reports the order total and its lines by catalog slug", async () => {
  await seedConfirmedOrder();

  assert.deepEqual(await readMetaPurchaseSnapshot(prisma, orderCode), {
    // The reported value is what the buyer paid, shipping included.
    valueVnd: 928_000,
    contents: [{ id: "meta-linen-shirt", quantity: 2, itemPrice: 449_000 }],
  });
});

test("an order that is not confirmed is not a sale", async () => {
  await seedConfirmedOrder("DRAFT");

  assert.equal(await readMetaPurchaseSnapshot(prisma, orderCode), null);
  assert.equal(await readMetaPurchaseSnapshot(prisma, "NO-SUCH-ORDER"), null);
});

test("an order with a line it cannot describe exactly is not reported at all", async () => {
  await seedConfirmedOrder();
  const order = await prisma.orderMirror.findUniqueOrThrow({
    where: { publicCode: orderCode },
    select: { id: true },
  });
  // Past Number's exact range the price cannot be reported, and reporting the order without the
  // line would contradict its own total.
  await prisma.orderLineSnapshot.updateMany({
    where: { orderId: order.id },
    data: { unitPriceVnd: BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1) },
  });

  assert.equal(await readMetaPurchaseSnapshot(prisma, orderCode), null);
});

test("the server event carries hashed identity and the order code as its dedup id", async () => {
  await seedConfirmedOrder();

  const requests: Array<{ url: string; body: unknown }> = [];
  await withConversionsEnv(() =>
    reportMetaPurchase(prisma, orderCode, requestContext, {
      now: reportedAt,
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return Response.json({ events_received: 1, fbtrace_id: "test_trace" });
      },
    }),
  );

  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.url, "https://graph.facebook.com/v26.0/123456789012345/events");

  const body = request.body as { data: Array<Record<string, unknown>> };
  const event = body.data[0]!;
  assert.equal(event.event_name, "Purchase");
  // Same id the browser pixel sends, which is what stops this counting as a second sale.
  assert.equal(event.event_id, orderCode);
  // Meta wants whole seconds, not milliseconds.
  assert.equal(event.event_time, Math.floor(syncedAt.getTime() / 1000));
  assert.deepEqual(event.custom_data, {
    currency: "VND",
    value: 928_000,
    contents: [{ id: "meta-linen-shirt", quantity: 2, item_price: 449_000 }],
    content_type: "product",
  });

  const userData = event.user_data as Record<string, unknown>;
  assert.deepEqual(userData.ph, [sha256("84912345678")]);
  assert.deepEqual(userData.fn, [sha256("an")]);
  assert.equal(userData.fbp, requestContext.fbp);

  // The buyer's phone and name must never leave in the clear.
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("0912345678"), false);
  assert.equal(serialized.includes("Nguyễn"), false);
  const stored = await prisma.orderMirror.findUniqueOrThrow({ where: { publicCode: orderCode } });
  assert.equal(stored.metaPurchaseContext, null);
  assert.equal(JSON.parse(stored.metaPurchasePayload!).user_data, undefined);
  assert.equal(JSON.parse(stored.metaPurchasePayload!).event_source_url, undefined);
  assert.deepEqual(await readMetaPurchaseSnapshot(prisma, orderCode), {
    valueVnd: 928_000, contents: [{ id: "meta-linen-shirt", quantity: 2, itemPrice: 449_000 }],
  });
});

test("nothing is sent when the Conversions API has no access token", async () => {
  await seedConfirmedOrder();

  let called = false;
  await reportMetaPurchase(prisma, orderCode, requestContext, {
    fetchImpl: async () => {
      called = true;
      return new Response("{}", { status: 200 });
    },
  });

  assert.equal(called, false);
});

test("a reporting failure never reaches the checkout that triggered it", async () => {
  await seedConfirmedOrder();

  await withConversionsEnv(async () => {
    // Must resolve, not reject: the sale is already complete by the time this runs.
    await reportMetaPurchaseSafely(prisma, orderCode, requestContext, {
      now: reportedAt,
      fetchImpl: async () => {
        throw new Error("Meta is unreachable");
      },
    });
  });
});

test("SYNC_UNKNOWN reconciliation reports Purchase after commit with the original time and saved attribution", async () => {
  await seedConfirmedOrder("DRAFT");
  const events: Array<Record<string, unknown>> = [];
  await withConversionsEnv(async () => {
    await saveMetaPurchaseContextSafely(prisma, orderCode, requestContext, reportedAt);
    await prisma.orderMirror.update({ where: { publicCode: orderCode }, data: { state: "SYNC_UNKNOWN" } });
    const service = createPancakeOrderReconciliationService({
      client: prisma, clock: () => reportedAt,
      gateway: { searchOrderByMarker: async () => ({ kind: "FOUND", orderId: "meta-pos-1" }) },
      onConfirmed: async (code) => {
        assert.equal((await prisma.orderMirror.findUniqueOrThrow({ where: { publicCode: code } })).state, "CONFIRMED");
        await reportMetaPurchaseSafely(prisma, code, null, { now: reportedAt, fetchImpl: async (_url, init) => {
          events.push(JSON.parse(String(init?.body)).data[0]);
          return Response.json({ events_received: 1 });
        } });
      },
    });
    assert.equal((await service.reconcileAllUnknownOrders({ shopId })).confirmed, 1);
    await service.reconcileOrder(orderCode);
  });
  assert.equal(events.length, 1, "acknowledged replay must not resend");
  assert.equal(events[0]!.event_id, orderCode);
  assert.equal(events[0]!.event_time, Math.floor(syncedAt.getTime() / 1000));
  assert.equal(events[0]!.event_source_url, requestContext.eventSourceUrl);
  assert.equal((events[0]!.user_data as Record<string, unknown>).fbc, requestContext.fbc);
});

test("retry and browser readback reuse immutable Purchase bytes after catalog, order and identity changes", async () => {
  await seedConfirmedOrder();
  const bodies: string[] = [];
  const unavailable: typeof fetch = async (_url, init) => {
    bodies.push(String(init?.body));
    return Response.json({ error: { code: 190, message: "test-token 0912345678" } }, { status: 400 });
  };
  await withConversionsEnv(async () => {
    await reportMetaPurchaseSafely(prisma, orderCode, requestContext, { now: reportedAt, fetchImpl: unavailable });
    assert.equal((await prisma.orderMirror.findUniqueOrThrow({ where: { publicCode: orderCode } })).metaPurchaseSentAt, null);
    await prisma.productMirror.updateMany({ where: { pancakeShopId: shopId }, data: { slug: "renamed-after-purchase" } });
    await prisma.orderMirror.update({ where: { publicCode: orderCode }, data: {
      guestName: "Changed Name", merchandiseSubtotalVnd: BigInt(2), totalVnd: BigInt(30_002),
    } });
    await prisma.orderLineSnapshot.updateMany({ where: { order: { publicCode: orderCode } }, data: {
      metaContentId: "changed-snapshot", unitPriceVnd: BigInt(1), lineTotalVnd: BigInt(2),
    } });
    const browserSnapshot = await readMetaPurchaseSnapshot(prisma, orderCode);
    assert.deepEqual(browserSnapshot, { valueVnd: 928_000, contents: [{ id: "meta-linen-shirt", quantity: 2, itemPrice: 449_000 }] });
    await reportMetaPurchaseSafely(prisma, orderCode, { ...requestContext, fbc: null }, {
      now: new Date(reportedAt.getTime() + 3600_000), fetchImpl: async (_url, init) => {
        bodies.push(String(init?.body)); return Response.json({ events_received: 1 });
      },
    });
    await reportMetaPurchaseSafely(prisma, orderCode, null, { now: reportedAt, fetchImpl: unavailable });
  });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.deepEqual(await readMetaPurchaseSnapshot(prisma, orderCode), { valueVnd: 928_000,
    contents: [{ id: "meta-linen-shirt", quantity: 2, itemPrice: 449_000 }] });
  const stored = await prisma.orderMirror.findUniqueOrThrow({ where: { publicCode: orderCode } });
  assert.equal(stored.metaPurchaseContext, null);
  assert.equal(stored.metaPurchasePayload!.includes('"user_data"'), false);
});

test("concurrent Purchase reports select one payload even with different request contexts", async () => {
  await seedConfirmedOrder();
  const bodies: string[] = [];
  await withConversionsEnv(async () => {
    const fetchImpl: typeof fetch = async (_url, init) => {
      bodies.push(String(init?.body)); return Response.json({ events_received: 1 });
    };
    await Promise.all([
      reportMetaPurchaseSafely(prisma, orderCode, requestContext, { now: reportedAt, fetchImpl }),
      reportMetaPurchaseSafely(prisma, orderCode, { ...requestContext, fbc: null }, { now: reportedAt, fetchImpl }),
    ]);
  });
  assert.ok(bodies.length >= 1);
  assert.equal(new Set(bodies).size, 1);
  const stored = await prisma.orderMirror.findUniqueOrThrow({ where: { publicCode: orderCode } });
  assert.equal(stored.metaPurchaseContext, null);
  assert.equal(stored.metaPurchasePayload!.includes('"user_data"'), false);
});

test("maintenance redacts expired/acknowledged attribution without sending or changing immutable browser facts", async () => {
  await seedConfirmedOrder("DRAFT");
  await withConversionsEnv(async () => {
    await saveMetaPurchaseContextSafely(prisma, orderCode, requestContext, reportedAt);
    await prisma.orderMirror.update({ where: { publicCode: orderCode }, data: { state: "CONFIRMED" } });
    await reportMetaPurchase(prisma, orderCode, null, { now: reportedAt, fetchImpl: async () => Response.json({ error: { code: 190 } }, { status: 400 }) });
  });
  const snapshot = await readMetaPurchaseSnapshot(prisma, orderCode);
  const before = await prisma.orderMirror.findUniqueOrThrow({ where: { publicCode: orderCode } });
  assert.ok(before.metaPurchaseContext);
  assert.ok(JSON.parse(before.metaPurchasePayload!).user_data.fbp);
  await cleanupMetaPurchaseAttributionSafely(prisma, new Date(syncedAt.getTime() + 7 * 86400_000 - 1));
  assert.equal((await prisma.orderMirror.findUniqueOrThrow({ where: { publicCode: orderCode } })).metaPurchasePayload, before.metaPurchasePayload);
  await cleanupMetaPurchaseAttributionSafely(prisma, new Date(syncedAt.getTime() + 7 * 86400_000));
  const after = await prisma.orderMirror.findUniqueOrThrow({ where: { publicCode: orderCode } });
  assert.equal(after.metaPurchaseContext, null);
  assert.equal(JSON.parse(after.metaPurchasePayload!).user_data, undefined);
  assert.equal(JSON.parse(after.metaPurchasePayload!).event_source_url, undefined);
  assert.equal(after.metaPurchaseSentAt, null);
  assert.deepEqual(await readMetaPurchaseSnapshot(prisma, orderCode), snapshot);
  let sent = false;
  await withConversionsEnv(() => reportMetaPurchase(prisma, orderCode, requestContext, {
    now: new Date(syncedAt.getTime() + 7 * 86400_000), fetchImpl: async () => { sent = true; return Response.json({ events_received: 1 }); },
  }));
  assert.equal(sent, false);
});

test("expired ambiguous submissions lose saved attribution even without a confirmation callback", async () => {
  await seedConfirmedOrder("SYNC_UNKNOWN");
  await withConversionsEnv(() => saveMetaPurchaseContextSafely(prisma, orderCode, requestContext, reportedAt));
  await cleanupMetaPurchaseAttributionSafely(prisma, new Date(syncedAt.getTime() + 8 * 86400_000));
  const order = await prisma.orderMirror.findUniqueOrThrow({ where: { publicCode: orderCode } });
  assert.equal(order.metaPurchaseContext, null);
  assert.equal(order.state, "SYNC_UNKNOWN");
  await withConversionsEnv(() => saveMetaPurchaseContextSafely(prisma, orderCode, requestContext, new Date(syncedAt.getTime() + 8 * 86400_000)));
  assert.equal((await prisma.orderMirror.findUniqueOrThrow({ where: { publicCode: orderCode } })).metaPurchaseContext, null);
});

test("historical missing identity/time and expired conversions are not fabricated", async () => {
  await seedConfirmedOrder();
  let called = false;
  const fetchImpl: typeof fetch = async () => { called = true; return Response.json({ events_received: 1 }); };
  await withConversionsEnv(async () => {
    await reportMetaPurchaseSafely(prisma, orderCode, null, { now: new Date("2026-09-10"), fetchImpl });
    await prisma.orderMirror.update({ where: { publicCode: orderCode }, data: { purchaseOccurredAt: null, metaPurchasePayload: null } });
    await reportMetaPurchaseSafely(prisma, orderCode, null, { now: reportedAt, fetchImpl });
    await prisma.orderMirror.update({ where: { publicCode: orderCode }, data: { purchaseOccurredAt: syncedAt } });
    await prisma.orderLineSnapshot.updateMany({ where: { order: { publicCode: orderCode } }, data: { metaContentId: null } });
    await reportMetaPurchaseSafely(prisma, orderCode, null, { now: reportedAt, fetchImpl });
  });
  assert.equal(called, false);
});

test("exception logs cannot expose request context, PII, or credentials", async () => {
  const logs: string[] = [];
  const original = console.warn;
  console.warn = (value) => { logs.push(String(value)); };
  try {
    await withConversionsEnv(() => reportMetaPurchaseSafely({ orderMirror: {
      findUnique: async () => { throw new Error("postgresql://password test-token 0912345678 Nguyễn"); },
    } } as unknown as Parameters<typeof reportMetaPurchaseSafely>[0], orderCode, requestContext));
  } finally { console.warn = original; }
  assert.equal(logs.length, 1);
  assert.equal(/password|test-token|0912345678|Nguyễn|203\.0\.113\.9/.test(logs.join()), false);
});
