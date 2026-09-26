process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/test?schema=public";

import assert from "node:assert/strict";
import test from "node:test";

import { createPancakeOrderSubmissionService } from "../../src/commerce/pancake-order-submit.ts";
import type { PancakeCatalogVariation } from "../../src/integrations/pancake/catalog-contract.ts";
import { PancakeHttpError, PancakeNetworkError } from "../../src/integrations/pancake/client.ts";
import type { PancakeCreateOrderRequest } from "../../src/integrations/pancake/order-create.ts";

import type { PrismaClient } from "../../src/generated/prisma/client.ts";

const shopId = 1720000650;
const variantId = "var-test-01";
const pancakeVariationId = "pan-var-01";
const publicCode = "LA-260918-001";
const componentVariationId = "pan-comp-01";

function buildCatalogVariation(
  id: string,
  sellableStock: number,
  retailPrice = 200_000,
): PancakeCatalogVariation {
  return {
    id,
    productId: "prod-01",
    displayId: "V8014-S",
    barcode: "BARCODE-01",
    fields: [],
    imageUrls: [],
    isHidden: false,
    isLocked: false,
    retailPrice,
    retailPriceAfterDiscount: retailPrice,
    product: { id: "prod-01", name: "Áo Dài Test" },
    warehouseStocks: [{ warehouseId: "wh-01", remainQuantity: sellableStock }],
    sellableStock,
  };
}

function buildMockPrisma({
  initialOrderState = "DRAFT",
  sellingMode = "STANDARD",
  negativeStockLimit = -20,
  isComposite = false,
}: {
  initialOrderState?: "DRAFT" | "VALIDATING" | "POS_SUBMITTING" | "CONFIRMED" | "SYNC_UNKNOWN" | "REJECTED";
  sellingMode?: "STANDARD" | "OVERSELL" | "PREORDER";
  negativeStockLimit?: number;
  isComposite?: boolean;
} = {}) {
  let orderState = initialOrderState;
  let pancakeOrderId: string | null = null;
  let syncErrorCode: string | null = null;

  const mockOrder = {
    id: "order-uuid-01",
    publicCode,
    pancakeShopId: shopId,
    state: orderState,
    syncErrorCode: syncErrorCode as string | null,
    pancakeOrderId: pancakeOrderId as string | null,
    checkoutSnapshottedAt: new Date("2026-09-18T05:00:00.000Z"),
    guestName: "Nguyen Van A",
    guestPhone: "0901234567",
    provinceRef: "805",
    districtRef: "80505",
    communeRef: "8050501",
    addressDetail: "123 Test Street",
    note: "Test Order Note",
    merchandiseSubtotalVnd: BigInt(200_000),
    shippingFeeVnd: BigInt(30_000),
    totalVnd: BigInt(230_000),
    capacityReservations: [],
    lines: [
      {
        id: "line-01",
        orderId: "order-uuid-01",
        variantId,
        pancakeVariationId,
        quantity: 1,
        unitPriceVnd: BigInt(200_000),
        lineTotalVnd: BigInt(200_000),
        baseUnitPriceVnd: BigInt(200_000),
        promotionCampaignId: null,
        promotionName: null,
        promotionKind: null,
        promotionDiscountType: null,
        promotionPercentageValue: null,
        promotionFixedPriceVnd: null,
      },
    ],
  };

  async function findUnique({ where }: { where: { publicCode?: string; id?: string } }) {
    if (where.publicCode === publicCode || where.id === mockOrder.id) {
      return {
        ...mockOrder,
        state: orderState,
        pancakeOrderId,
        syncErrorCode,
      };
    }
    return null;
  }

  const client = {
    orderMirror: {
      async updateMany({
        where,
        data,
      }: {
        where: { publicCode?: string; id?: string; state?: string };
        data: { state?: typeof orderState; syncErrorCode?: string | null; pancakeOrderId?: string };
      }) {
        if (where.publicCode && where.publicCode !== publicCode) return { count: 0 };
        if (where.id && where.id !== mockOrder.id) return { count: 0 };
        if (where.state && where.state !== orderState) return { count: 0 };

        if (data.state) orderState = data.state;
        if (data.syncErrorCode !== undefined) syncErrorCode = data.syncErrorCode;
        if (data.pancakeOrderId !== undefined) pancakeOrderId = data.pancakeOrderId;
        mockOrder.state = orderState;
        mockOrder.syncErrorCode = syncErrorCode;
        mockOrder.pancakeOrderId = pancakeOrderId;
        return { count: 1 };
      },
      findUnique,
      async findUniqueOrThrow({ where }: { where: { publicCode?: string; id?: string } }) {
        const found = await findUnique({ where });
        if (!found) throw new Error("Order not found");
        return found;
      },
    },
    orderPreorderSnapshot: {
      async findUnique() {
        return null;
      },
    },
    variantMirror: {
      async findMany() {
        return [
          {
            id: variantId,
            productId: "prod-01",
            product: {
              sellingPolicy: {
                sellingMode,
                negativeStockLimit,
              },
            },
            // One component edge: a STANDARD composite's capacity is its component's live stock.
            compositeComponents: isComposite
              ? [
                  {
                    quantity: 1,
                    componentVariant: {
                      pancakeVariationId: componentVariationId,
                      isPresent: true,
                      product: { pancakeShopId: shopId, isPresent: true },
                    },
                  },
                ]
              : [],
          },
        ];
      },
    },
    promotionTarget: {
      async findMany() {
        return [];
      },
    },
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(client);
    },
    getOrderState: () => ({ orderState, pancakeOrderId, syncErrorCode }),
  };

  return client as unknown as PrismaClient & { getOrderState: typeof client.getOrderState };
}

test("STANDARD mode: allows order when stock >= requested quantity", async () => {
  const prismaMock = buildMockPrisma({ sellingMode: "STANDARD" });
  let createdRequest: PancakeCreateOrderRequest | null = null;

  const gateway = {
    async fetchCompleteCatalog() {
      return [buildCatalogVariation(pancakeVariationId, 5)];
    },
    async createOrder(req: PancakeCreateOrderRequest) {
      createdRequest = req;
      return { id: 70001 };
    },
  };

  const service = createPancakeOrderSubmissionService(prismaMock, gateway);
  const result = await service.submit({ publicCode, shopId });

  assert.deepEqual(result, { ok: true, state: "CONFIRMED", pancakeOrderId: "70001" });
  assert.equal(prismaMock.getOrderState().orderState, "CONFIRMED");
  assert.equal(prismaMock.getOrderState().pancakeOrderId, "70001");
  assert.ok(createdRequest);
});

test("STANDARD mode: rejects with STOCK_UNAVAILABLE when stock is zero", async () => {
  const prismaMock = buildMockPrisma({ sellingMode: "STANDARD" });
  let createCalled = false;

  const gateway = {
    async fetchCompleteCatalog() {
      return [buildCatalogVariation(pancakeVariationId, 0)];
    },
    async createOrder() {
      createCalled = true;
      return { id: 70002 };
    },
  };

  const service = createPancakeOrderSubmissionService(prismaMock, gateway);
  const result = await service.submit({ publicCode, shopId });

  assert.deepEqual(result, { ok: false, state: "REJECTED", reason: "STOCK_UNAVAILABLE" });
  assert.equal(createCalled, false);
  assert.equal(prismaMock.getOrderState().orderState, "REJECTED");
  assert.equal(prismaMock.getOrderState().syncErrorCode, "STOCK_UNAVAILABLE");
});

test("STANDARD mode: rejects with STOCK_UNAVAILABLE when stock is already negative", async () => {
  const prismaMock = buildMockPrisma({ sellingMode: "STANDARD" });
  let createCalled = false;

  const gateway = {
    async fetchCompleteCatalog() {
      return [buildCatalogVariation(pancakeVariationId, -1)];
    },
    async createOrder() {
      createCalled = true;
      return { id: 70003 };
    },
  };

  const service = createPancakeOrderSubmissionService(prismaMock, gateway);
  const result = await service.submit({ publicCode, shopId });

  assert.deepEqual(result, { ok: false, state: "REJECTED", reason: "STOCK_UNAVAILABLE" });
  assert.equal(createCalled, false);
});

test("OVERSELL mode: allows order at stock zero within negative limit", async () => {
  const prismaMock = buildMockPrisma({
    sellingMode: "OVERSELL",
    negativeStockLimit: -20,
  });

  const gateway = {
    async fetchCompleteCatalog() {
      return [buildCatalogVariation(pancakeVariationId, 0)];
    },
    async createOrder() {
      return { id: 70004 };
    },
  };

  const service = createPancakeOrderSubmissionService(prismaMock, gateway);
  const result = await service.submit({ publicCode, shopId });

  assert.deepEqual(result, { ok: true, state: "CONFIRMED", pancakeOrderId: "70004" });
});

test("OVERSELL mode: allows order at negative stock within limit", async () => {
  const prismaMock = buildMockPrisma({
    sellingMode: "OVERSELL",
    negativeStockLimit: -20,
  });

  const gateway = {
    async fetchCompleteCatalog() {
      return [buildCatalogVariation(pancakeVariationId, -15)];
    },
    async createOrder() {
      return { id: 70005 };
    },
  };

  const service = createPancakeOrderSubmissionService(prismaMock, gateway);
  const result = await service.submit({ publicCode, shopId });

  assert.deepEqual(result, { ok: true, state: "CONFIRMED", pancakeOrderId: "70005" });
});

test("OVERSELL mode: rejects with STOCK_UNAVAILABLE when projected stock exceeds negative limit", async () => {
  const prismaMock = buildMockPrisma({
    sellingMode: "OVERSELL",
    negativeStockLimit: -20,
  });
  let createCalled = false;

  const gateway = {
    async fetchCompleteCatalog() {
      // Current stock is -20, requested 1 => projected -21 < -20
      return [buildCatalogVariation(pancakeVariationId, -20)];
    },
    async createOrder() {
      createCalled = true;
      return { id: 70006 };
    },
  };

  const service = createPancakeOrderSubmissionService(prismaMock, gateway);
  const result = await service.submit({ publicCode, shopId });

  assert.deepEqual(result, { ok: false, state: "REJECTED", reason: "STOCK_UNAVAILABLE" });
  assert.equal(createCalled, false);
});

test("PREORDER mode: allows order within negative limit and rejects past limit", async () => {
  const prismaMock = buildMockPrisma({
    sellingMode: "PREORDER",
    negativeStockLimit: -10,
  });

  const gateway = {
    async fetchCompleteCatalog() {
      return [buildCatalogVariation(pancakeVariationId, -9)];
    },
    async createOrder() {
      return { id: 70007 };
    },
  };

  const service = createPancakeOrderSubmissionService(prismaMock, gateway);
  const resultOk = await service.submit({ publicCode, shopId });
  assert.deepEqual(resultOk, { ok: true, state: "CONFIRMED", pancakeOrderId: "70007" });

  // Exceeding limit
  const prismaMockPastLimit = buildMockPrisma({
    sellingMode: "PREORDER",
    negativeStockLimit: -10,
  });
  const gatewayPastLimit = {
    async fetchCompleteCatalog() {
      return [buildCatalogVariation(pancakeVariationId, -10)];
    },
    async createOrder() {
      return { id: 70008 };
    },
  };
  const servicePastLimit = createPancakeOrderSubmissionService(prismaMockPastLimit, gatewayPastLimit);
  const resultPast = await servicePastLimit.submit({ publicCode, shopId });
  assert.deepEqual(resultPast, { ok: false, state: "REJECTED", reason: "STOCK_UNAVAILABLE" });
});

test("Malformed stock: rejects with STOCK_UNAVAILABLE when sellableStock is non-finite", async () => {
  const prismaMock = buildMockPrisma({ sellingMode: "STANDARD" });

  const gateway = {
    async fetchCompleteCatalog() {
      return [buildCatalogVariation(pancakeVariationId, Number.NaN)];
    },
    async createOrder() {
      return { id: 70009 };
    },
  };

  const service = createPancakeOrderSubmissionService(prismaMock, gateway);
  const result = await service.submit({ publicCode, shopId });

  assert.deepEqual(result, { ok: false, state: "REJECTED", reason: "STOCK_UNAVAILABLE" });
});

test("Composite parent: allowed in STANDARD mode when component stock is available", async () => {
  const prismaMock = buildMockPrisma({
    sellingMode: "STANDARD",
    isComposite: true,
  });

  const gateway = {
    async fetchCompleteCatalog() {
      // The parent's own Pancake row is 0, as a COMBO / SET routinely is; its component is stocked.
      return [
        buildCatalogVariation(pancakeVariationId, 0),
        buildCatalogVariation(componentVariationId, 3),
      ];
    },
    async createOrder() {
      return { id: 70010 };
    },
  };

  const service = createPancakeOrderSubmissionService(prismaMock, gateway);
  const result = await service.submit({ publicCode, shopId });

  assert.deepEqual(result, { ok: true, state: "CONFIRMED", pancakeOrderId: "70010" });
});

test("Composite parent: STANDARD capacity is its component's live stock, not the parent row", async () => {
  const prismaMock = buildMockPrisma({
    sellingMode: "STANDARD",
    isComposite: true,
  });
  let createCalled = false;

  const gateway = {
    async fetchCompleteCatalog() {
      return [
        buildCatalogVariation(pancakeVariationId, 50),
        buildCatalogVariation(componentVariationId, 0),
      ];
    },
    async createOrder() {
      createCalled = true;
      return { id: 70013 };
    },
  };

  const service = createPancakeOrderSubmissionService(prismaMock, gateway);
  const result = await service.submit({ publicCode, shopId });

  assert.deepEqual(result, { ok: false, state: "REJECTED", reason: "STOCK_UNAVAILABLE" });
  assert.equal(createCalled, false);
});

test("Composite parent: fails closed with COMPOSITE_SELLING_MODE_UNSUPPORTED under OVERSELL mode", async () => {
  const prismaMock = buildMockPrisma({
    sellingMode: "OVERSELL",
    isComposite: true,
  });
  let createCalled = false;

  const gateway = {
    async fetchCompleteCatalog() {
      return [buildCatalogVariation(pancakeVariationId, 5)];
    },
    async createOrder() {
      createCalled = true;
      return { id: 70011 };
    },
  };

  const service = createPancakeOrderSubmissionService(prismaMock, gateway);
  const result = await service.submit({ publicCode, shopId });

  assert.deepEqual(result, {
    ok: false,
    state: "REJECTED",
    reason: "COMPOSITE_SELLING_MODE_UNSUPPORTED",
  });
  assert.equal(createCalled, false);
  assert.equal(prismaMock.getOrderState().orderState, "REJECTED");
  assert.equal(prismaMock.getOrderState().syncErrorCode, "COMPOSITE_SELLING_MODE_UNSUPPORTED");
});

test("Composite parent: fails closed with COMPOSITE_SELLING_MODE_UNSUPPORTED under PREORDER mode", async () => {
  const prismaMock = buildMockPrisma({
    sellingMode: "PREORDER",
    isComposite: true,
  });

  const gateway = {
    async fetchCompleteCatalog() {
      return [buildCatalogVariation(pancakeVariationId, 5)];
    },
    async createOrder() {
      return { id: 70012 };
    },
  };

  const service = createPancakeOrderSubmissionService(prismaMock, gateway);
  const result = await service.submit({ publicCode, shopId });

  assert.deepEqual(result, {
    ok: false,
    state: "REJECTED",
    reason: "COMPOSITE_SELLING_MODE_UNSUPPORTED",
  });
});

test("Request embeds canonical [ORDER:publicCode] marker in note and shipping address", async () => {
  const prismaMock = buildMockPrisma({ sellingMode: "STANDARD" });
  let capturedRequest: PancakeCreateOrderRequest | null = null;

  const gateway = {
    async fetchCompleteCatalog() {
      return [buildCatalogVariation(pancakeVariationId, 5)];
    },
    async createOrder(req: PancakeCreateOrderRequest) {
      capturedRequest = req;
      return { id: 70013 };
    },
  };

  const service = createPancakeOrderSubmissionService(prismaMock, gateway);
  await service.submit({ publicCode, shopId });

  assert.ok(capturedRequest);
  const req: PancakeCreateOrderRequest = capturedRequest;
  assert.ok(req.note?.includes(`[ORDER:${publicCode}]`));
  assert.ok(req.shipping_address.address.includes(`[ORDER:${publicCode}]`));
});

test("Definite HTTP 4xx rejection marks order as REJECTED with ORDER_REJECTED", async () => {
  for (const status of [400, 401, 403, 404, 422]) {
    const prismaMock = buildMockPrisma({ sellingMode: "STANDARD" });

    const gateway = {
      async fetchCompleteCatalog() {
        return [buildCatalogVariation(pancakeVariationId, 5)];
      },
      async createOrder() {
        throw new PancakeHttpError(status, "/shops/orders");
      },
    };

    const service = createPancakeOrderSubmissionService(prismaMock, gateway);
    const result = await service.submit({ publicCode, shopId });

    assert.deepEqual(
      result,
      { ok: false, state: "REJECTED", reason: "ORDER_REJECTED" },
      `Status ${status} should be classified as definite rejection`,
    );
    assert.equal(prismaMock.getOrderState().orderState, "REJECTED");
    assert.equal(prismaMock.getOrderState().syncErrorCode, "ORDER_REJECTED");
  }
});

test("Ambiguous write (network error / 5xx) marks order as SYNC_UNKNOWN", async () => {
  // Case A: Network error
  const prismaNet = buildMockPrisma({ sellingMode: "STANDARD" });
  const gatewayNet = {
    async fetchCompleteCatalog() {
      return [buildCatalogVariation(pancakeVariationId, 5)];
    },
    async createOrder() {
      throw new PancakeNetworkError("/shops/orders");
    },
  };
  const serviceNet = createPancakeOrderSubmissionService(prismaNet, gatewayNet);
  const resultNet = await serviceNet.submit({ publicCode, shopId });

  assert.deepEqual(resultNet, {
    ok: false,
    state: "SYNC_UNKNOWN",
    reason: "CREATE_OUTCOME_UNKNOWN",
  });
  assert.equal(prismaNet.getOrderState().orderState, "SYNC_UNKNOWN");
  assert.equal(prismaNet.getOrderState().syncErrorCode, "CREATE_OUTCOME_UNKNOWN");

  // Case B: 500 server error
  const prisma500 = buildMockPrisma({ sellingMode: "STANDARD" });
  const gateway500 = {
    async fetchCompleteCatalog() {
      return [buildCatalogVariation(pancakeVariationId, 5)];
    },
    async createOrder() {
      throw new PancakeHttpError(500, "/shops/orders");
    },
  };
  const service500 = createPancakeOrderSubmissionService(prisma500, gateway500);
  const result500 = await service500.submit({ publicCode, shopId });

  assert.deepEqual(result500, {
    ok: false,
    state: "SYNC_UNKNOWN",
    reason: "CREATE_OUTCOME_UNKNOWN",
  });
  assert.equal(prisma500.getOrderState().orderState, "SYNC_UNKNOWN");
});

test("Ambiguous create leaves order in SYNC_UNKNOWN without inline marker search", async () => {
  const prismaMock = buildMockPrisma({ sellingMode: "STANDARD" });

  const gateway = {
    async fetchCompleteCatalog() {
      return [buildCatalogVariation(pancakeVariationId, 5)];
    },
    async createOrder() {
      // Simulates network drop after Pancake accepted order
      throw new PancakeNetworkError("/shops/orders");
    },
  };

  const service = createPancakeOrderSubmissionService(prismaMock, gateway);
  const result = await service.submit({ publicCode, shopId });

  assert.deepEqual(result, {
    ok: false,
    state: "SYNC_UNKNOWN",
    reason: "CREATE_OUTCOME_UNKNOWN",
  });
  assert.equal(prismaMock.getOrderState().orderState, "SYNC_UNKNOWN");
  assert.equal(prismaMock.getOrderState().syncErrorCode, "CREATE_OUTCOME_UNKNOWN");
  assert.equal(prismaMock.getOrderState().pancakeOrderId, null);
});
