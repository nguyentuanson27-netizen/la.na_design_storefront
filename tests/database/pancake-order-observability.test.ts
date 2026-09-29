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

const liveVariation: PancakeCatalogVariation = {
  id: "observable-variation-001",
  productId: "observable-product-001",
  displayId: "observable-display-001",
  barcode: "observable-barcode-001",
  fields: [],
  imageUrls: [],
  isHidden: false,
  isLocked: false,
  retailPrice: 500_000,
  retailPriceAfterDiscount: 500_000,
  product: { id: "observable-product-001", name: "Observable Product" },
  warehouseStocks: [{ warehouseId: "observable-warehouse-001", remainQuantity: 2 }],
  sellableStock: 2,
};

async function createDraft(key: string) {
  const publicCode = `observable-${key}`;
  await prisma.orderMirror.deleteMany({ where: { publicCode } });
  return prisma.orderMirror.create({
    data: {
      publicCode,
      pancakeShopId: shopId,
      state: "DRAFT",
      checkoutSnapshottedAt: new Date("2026-08-11T08:40:00.000Z"),
      guestName: "Sensitive Name",
      guestPhone: "0901234567",
      provinceRef: "province-01",
      districtRef: "district-001",
      communeRef: "commune-0001",
      addressDetail: "Sensitive Address",
      note: "Sensitive Note",
      merchandiseSubtotalVnd: BigInt(500_000),
      shippingFeeVnd: BigInt(30_000),
      totalVnd: BigInt(530_000),
      lines: {
        create: {
          variantId: `observable-local-${key}`,
          pancakeVariationId: liveVariation.id,
          productName: "Observable Product",
          color: "Black",
          size: "M",
          quantity: 1,
          unitPriceVnd: BigInt(500_000),
          lineTotalVnd: BigInt(500_000),
        },
      },
    },
  });
}

async function cleanup(publicCode: string) {
  await prisma.orderMirror.deleteMany({ where: { publicCode } });
}

test.after(async () => {
  await prisma.$disconnect();
});

test("submission emits stable lifecycle events without checkout PII or public tracking capability", async () => {
  const order = await createDraft("success");
  const events: unknown[] = [];
  const service = createPancakeOrderSubmissionService(
    prisma,
    {
      async fetchVariations() {
        return [liveVariation];
      },
      async createOrder() {
        return { id: 800_001 };
      },
    },
    { onEvent: (event) => events.push(event) },
  );

  assert.deepEqual(await service.submit({ publicCode: order.publicCode, shopId }), {
    ok: true,
    state: "CONFIRMED",
    pancakeOrderId: "800001",
  });
  assert.deepEqual(events, [
    {
      name: "pancake_order.validation_started",
      correlationId: order.id,
      state: "VALIDATING",
    },
    {
      name: "pancake_order.create_started",
      correlationId: order.id,
      state: "POS_SUBMITTING",
      dependency: "pancake",
      operation: "create_order",
    },
    {
      name: "pancake_order.confirmed",
      correlationId: order.id,
      state: "CONFIRMED",
    },
  ]);

  const serialized = JSON.stringify(events);
  for (const sensitiveValue of [
    order.publicCode,
    "Sensitive Name",
    "0901234567",
    "Sensitive Address",
    "Sensitive Note",
    "800001",
  ]) {
    assert.equal(serialized.includes(sensitiveValue), false);
  }
  await cleanup(order.publicCode);
});

test("ambiguous create emits only a stable unknown outcome and observer failures never alter submission safety", async () => {
  const unknownOrder = await createDraft("unknown");
  const events: unknown[] = [];
  const unknownService = createPancakeOrderSubmissionService(
    prisma,
    {
      async fetchVariations() {
        return [liveVariation];
      },
      async createOrder() {
        throw new Error("sensitive remote failure detail");
      },
    },
    { onEvent: (event) => events.push(event) },
  );

  assert.deepEqual(await unknownService.submit({ publicCode: unknownOrder.publicCode, shopId }), {
    ok: false,
    state: "SYNC_UNKNOWN",
    reason: "CREATE_OUTCOME_UNKNOWN",
  });
  assert.deepEqual(events.at(-1), {
    name: "pancake_order.create_unknown",
    correlationId: unknownOrder.id,
    state: "SYNC_UNKNOWN",
    reason: "CREATE_OUTCOME_UNKNOWN",
  });
  assert.equal(JSON.stringify(events).includes("sensitive remote failure detail"), false);
  await cleanup(unknownOrder.publicCode);

  const resilientOrder = await createDraft("observer-failure");
  let createCalls = 0;
  const resilientService = createPancakeOrderSubmissionService(
    prisma,
    {
      async fetchVariations() {
        return [liveVariation];
      },
      async createOrder() {
        createCalls += 1;
        return { id: 800_002 };
      },
    },
    {
      onEvent() {
        throw new Error("observer unavailable");
      },
    },
  );

  assert.deepEqual(await resilientService.submit({ publicCode: resilientOrder.publicCode, shopId }), {
    ok: true,
    state: "CONFIRMED",
    pancakeOrderId: "800002",
  });
  assert.equal(createCalls, 1);
  assert.equal(
    (await prisma.orderMirror.findUniqueOrThrow({ where: { id: resilientOrder.id } })).state,
    "CONFIRMED",
  );
  await cleanup(resilientOrder.publicCode);
});
