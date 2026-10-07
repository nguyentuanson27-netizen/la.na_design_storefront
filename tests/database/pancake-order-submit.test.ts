import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createPancakeOrderSubmissionService } from "../../src/commerce/pancake-order-submit.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";
import type { PancakeCatalogVariation } from "../../src/integrations/pancake/catalog-contract.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const shopId = 920_007;

function liveVariation({
  id = "order-variation-001",
  price = 500_000,
  stock = 2,
}: {
  id?: string;
  price?: number;
  stock?: number;
} = {}): PancakeCatalogVariation {
  return {
    id,
    productId: "order-product-001",
    displayId: "display-001",
    barcode: "barcode-001",
    fields: [],
    imageUrls: [],
    isHidden: false,
    isLocked: false,
    retailPrice: price,
    retailPriceAfterDiscount: price,
    product: { id: "order-product-001", name: "Order Product" },
    warehouseStocks: [{ warehouseId: "warehouse-001", remainQuantity: stock }],
    sellableStock: stock,
  };
}

async function cleanup(key: string) {
  await prisma.orderMirror.deleteMany({ where: { publicCode: `submit-${key}` } });
}

async function createDraft(
  key: string,
  {
    price = 500_000,
    quantity = 2,
    shippingFee = 30_000,
    pancakeShopId = shopId,
  }: { price?: number; quantity?: number; shippingFee?: number; pancakeShopId?: number | null } = {},
) {
  await cleanup(key);
  const subtotal = price * quantity;
  return prisma.orderMirror.create({
    data: {
      publicCode: `submit-${key}`,
      pancakeShopId,
      state: "DRAFT",
      checkoutSnapshottedAt: new Date("2026-08-11T08:40:00.000Z"),
      guestName: "Nguyễn Văn A",
      guestPhone: "0901234567",
      provinceRef: "province-01",
      districtRef: "district-001",
      communeRef: "commune-0001",
      addressDetail: "12 Đường A",
      note: "Gọi trước khi giao",
      merchandiseSubtotalVnd: BigInt(subtotal),
      shippingFeeVnd: BigInt(shippingFee),
      totalVnd: BigInt(subtotal + shippingFee),
      lines: {
        create: {
          variantId: `local-variant-${key}`,
          pancakeVariationId: "order-variation-001",
          productName: "Order Product",
          color: "Black",
          size: "M",
          quantity,
          unitPriceVnd: BigInt(price),
          lineTotalVnd: BigInt(subtotal),
        },
      },
    },
  });
}

test.after(async () => {
  await prisma.$disconnect();
});

test("submission durably enters POS_SUBMITTING before exactly one successful Pancake POST", async () => {
  const key = "success";
  const order = await createDraft(key);
  let createCalls = 0;
  let conversionTime: string | undefined;

  const service = createPancakeOrderSubmissionService(prisma, {
    async fetchVariations(requestShopId) {
      assert.equal(requestShopId, shopId);
      return [liveVariation()];
    },
    async createOrder(request) {
      createCalls += 1;
      const persisted = await prisma.orderMirror.findUniqueOrThrow({ where: { id: order.id } });
      assert.equal(persisted.state, "POS_SUBMITTING");
      conversionTime = persisted.purchaseOccurredAt?.toISOString();
      assert.ok(conversionTime, "persist conversion time before an ambiguous external write is possible");
      assert.equal(request.shop_id, shopId);
      assert.equal(request.items[0]?.variation_id, "order-variation-001");
      assert.equal(request.items[0]?.variation_info.retail_price, 500_000);
      assert.equal("cod" in request, false);
      return { id: 700_001 };
    },
  });

  const result = await service.submit({ publicCode: order.publicCode, shopId });
  assert.deepEqual(result, { ok: true, state: "CONFIRMED", pancakeOrderId: "700001" });
  assert.equal(createCalls, 1);

  const persisted = await prisma.orderMirror.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(persisted.state, "CONFIRMED");
  assert.equal(persisted.pancakeOrderId, "700001");
  assert.equal(persisted.syncErrorCode, null);
  assert.equal(persisted.purchaseOccurredAt?.toISOString(), conversionTime);
  await cleanup(key);
});

test("submission rejects mismatched or unproven Pancake shop scope before any external call", async () => {
  for (const scenario of [
    { key: "shop-mismatch", persistedShopId: shopId, runtimeShopId: shopId + 1 },
    { key: "shop-unproven", persistedShopId: null, runtimeShopId: shopId },
  ] as const) {
    const order = await createDraft(scenario.key, { pancakeShopId: scenario.persistedShopId });
    let fetchCalls = 0;
    let createCalls = 0;
    const service = createPancakeOrderSubmissionService(prisma, {
      async fetchVariations() {
        fetchCalls += 1;
        return [liveVariation()];
      },
      async createOrder() {
        createCalls += 1;
        return { id: 1 };
      },
    });

    assert.deepEqual(
      await service.submit({ publicCode: order.publicCode, shopId: scenario.runtimeShopId }),
      { ok: false, state: "REJECTED", reason: "SHOP_SCOPE_UNVERIFIED" },
    );
    assert.equal(fetchCalls, 0);
    assert.equal(createCalls, 0);

    const persisted = await prisma.orderMirror.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(persisted.state, "REJECTED");
    assert.equal(persisted.syncErrorCode, "SHOP_SCOPE_UNVERIFIED");
    await cleanup(scenario.key);
  }
});

test("stock drift is rejected outright before Pancake order creation", async () => {
  // Unlike a price move, stock is not something the buyer can reconfirm their way past, so this
  // stays terminal. P9b changed only the price half of what used to be one shared assertion.
  const key = "stock-drift";
  const order = await createDraft(key);
  let createCalls = 0;
  const service = createPancakeOrderSubmissionService(prisma, {
    async fetchVariations() {
      return [liveVariation({ stock: 1 })];
    },
    async createOrder() {
      createCalls += 1;
      return { id: 1 };
    },
  });

  const result = await service.submit({ publicCode: order.publicCode, shopId });
  assert.deepEqual(result, { ok: false, state: "REJECTED", reason: "STOCK_UNAVAILABLE" });
  assert.equal(createCalls, 0);
  const persisted = await prisma.orderMirror.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(persisted.state, "REJECTED");
  assert.equal(persisted.syncErrorCode, "STOCK_UNAVAILABLE");
  await cleanup(key);
});

test("price drift returns the order to a reconfirmable DRAFT instead of killing it", async () => {
  // P9b: a price that moved upstream is not an invalid order, it is one the buyer has not agreed to
  // yet. It must stay reconfirmable, carry the refreshed money, and reach no Pancake write.
  const key = "price-drift";
  const order = await createDraft(key);
  let createCalls = 0;
  const service = createPancakeOrderSubmissionService(prisma, {
    async fetchVariations() {
      return [liveVariation({ price: 510_000 })];
    },
    async createOrder() {
      createCalls += 1;
      return { id: 1 };
    },
  });

  const result = await service.submit({ publicCode: order.publicCode, shopId });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.state, "DRAFT");
  assert.equal(result.reason, "PRICE_CHANGED");
  assert.equal(createCalls, 0);

  const persisted = await prisma.orderMirror.findUniqueOrThrow({
    where: { id: order.id },
    include: { lines: true },
  });
  assert.equal(persisted.state, "DRAFT");
  assert.equal(persisted.syncErrorCode, "PRICE_CHANGED");
  assert.equal(persisted.lines[0]!.unitPriceVnd, BigInt(510_000));
  await cleanup(key);
});

test("pre-write validation transport failure safely returns to DRAFT and may be retried", async () => {
  const key = "validation-retry";
  const order = await createDraft(key);
  let createCalls = 0;

  const unavailable = createPancakeOrderSubmissionService(prisma, {
    async fetchVariations() {
      throw new Error("transport unavailable");
    },
    async createOrder() {
      createCalls += 1;
      return { id: 1 };
    },
  });

  assert.deepEqual(await unavailable.submit({ publicCode: order.publicCode, shopId }), {
    ok: false,
    state: "DRAFT",
    reason: "VALIDATION_UNAVAILABLE",
  });
  assert.equal(createCalls, 0);

  const afterFailure = await prisma.orderMirror.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(afterFailure.state, "DRAFT");
  assert.equal(afterFailure.syncErrorCode, "VALIDATION_UNAVAILABLE");

  const healthy = createPancakeOrderSubmissionService(prisma, {
    async fetchVariations() {
      return [liveVariation()];
    },
    async createOrder() {
      createCalls += 1;
      return { id: 700_002 };
    },
  });
  assert.deepEqual(await healthy.submit({ publicCode: order.publicCode, shopId }), {
    ok: true,
    state: "CONFIRMED",
    pancakeOrderId: "700002",
  });
  assert.equal(createCalls, 1);
  await cleanup(key);
});

test("ambiguous POST outcome becomes SYNC_UNKNOWN and is never posted again", async () => {
  const key = "ambiguous";
  const order = await createDraft(key);
  let createCalls = 0;
  const service = createPancakeOrderSubmissionService(prisma, {
    async fetchVariations() {
      return [liveVariation()];
    },
    async createOrder() {
      createCalls += 1;
      throw new Error("timeout after request may have reached Pancake");
    },
  });

  assert.deepEqual(await service.submit({ publicCode: order.publicCode, shopId }), {
    ok: false,
    state: "SYNC_UNKNOWN",
    reason: "CREATE_OUTCOME_UNKNOWN",
  });
  assert.equal(createCalls, 1);
  const occurredAt = (await prisma.orderMirror.findUniqueOrThrow({ where: { id: order.id } })).purchaseOccurredAt?.toISOString();
  assert.ok(occurredAt);

  assert.deepEqual(await service.submit({ publicCode: order.publicCode, shopId }), {
    ok: false,
    state: "SYNC_UNKNOWN",
    reason: "CREATE_OUTCOME_UNKNOWN",
  });
  assert.equal(createCalls, 1);
  assert.equal((await prisma.orderMirror.findUniqueOrThrow({ where: { id: order.id } })).purchaseOccurredAt?.toISOString(), occurredAt);
  await cleanup(key);
});

test("malformed HTTP-success identity becomes SYNC_UNKNOWN without a second POST", async () => {
  const key = "malformed-success";
  const order = await createDraft(key);
  let createCalls = 0;
  const service = createPancakeOrderSubmissionService(prisma, {
    async fetchVariations() {
      return [liveVariation()];
    },
    async createOrder() {
      createCalls += 1;
      return { id: "not-an-integer" };
    },
  });

  assert.deepEqual(await service.submit({ publicCode: order.publicCode, shopId }), {
    ok: false,
    state: "SYNC_UNKNOWN",
    reason: "CREATE_OUTCOME_UNKNOWN",
  });
  assert.equal(createCalls, 1);
  assert.equal((await prisma.orderMirror.findUniqueOrThrow({ where: { id: order.id } })).state, "SYNC_UNKNOWN");
  await cleanup(key);
});

test("concurrent submitters cannot issue two Pancake order POSTs", async () => {
  const key = "concurrent";
  const order = await createDraft(key);
  let createCalls = 0;
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });

  const service = createPancakeOrderSubmissionService(prisma, {
    async fetchVariations() {
      return [liveVariation()];
    },
    async createOrder() {
      createCalls += 1;
      await hold;
      return { id: 700_003 };
    },
  });

  const first = service.submit({ publicCode: order.publicCode, shopId });
  while (createCalls === 0) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const second = await service.submit({ publicCode: order.publicCode, shopId });
  assert.equal(second.ok, false);
  assert.equal(second.state, "POS_SUBMITTING");
  assert.equal(createCalls, 1);

  release();
  assert.deepEqual(await first, { ok: true, state: "CONFIRMED", pancakeOrderId: "700003" });
  assert.equal(createCalls, 1);
  await cleanup(key);
});
