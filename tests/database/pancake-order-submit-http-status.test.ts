import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createPancakeOrderSubmissionService } from "../../src/commerce/pancake-order-submit.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";
import type { PancakeCatalogVariation } from "../../src/integrations/pancake/catalog-contract.ts";
import { PancakeClient } from "../../src/integrations/pancake/client.ts";
import { createPancakeOrderGateway } from "../../src/integrations/pancake/order-gateway.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const shopId = 920_007;

const liveVariation: PancakeCatalogVariation = {
  id: "status-variation-001",
  productId: "status-product-001",
  displayId: "status-display-001",
  barcode: "status-barcode-001",
  fields: [],
  imageUrls: [],
  isHidden: false,
  isLocked: false,
  retailPrice: 500_000,
  retailPriceAfterDiscount: 500_000,
  product: { id: "status-product-001", name: "Status Product" },
  warehouseStocks: [{ warehouseId: "status-warehouse-001", remainQuantity: 1 }],
  sellableStock: 1,
};

async function cleanup(publicCode: string) {
  await prisma.orderMirror.deleteMany({ where: { publicCode } });
}

async function createDraft(status: number) {
  const publicCode = `submit-unexpected-status-${status}`;
  await cleanup(publicCode);
  return prisma.orderMirror.create({
    data: {
      publicCode,
      pancakeShopId: shopId,
      state: "DRAFT",
      checkoutSnapshottedAt: new Date("2026-08-12T03:48:16.000Z"),
      guestName: "Nguyễn Văn A",
      guestPhone: "0901234567",
      provinceRef: "province-01",
      districtRef: "district-001",
      communeRef: "commune-0001",
      addressDetail: "12 Đường A",
      note: null,
      merchandiseSubtotalVnd: BigInt(500_000),
      shippingFeeVnd: BigInt(30_000),
      totalVnd: BigInt(530_000),
      lines: {
        create: {
          variantId: `status-local-variant-${status}`,
          pancakeVariationId: liveVariation.id,
          productName: "Status Product",
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

test.after(async () => {
  await prisma.$disconnect();
});

test("undocumented successful-looking 2xx create statuses become SYNC_UNKNOWN and are never posted twice", async () => {
  for (const status of [202]) {
    const order = await createDraft(status);
    let postCalls = 0;

    try {
      const client = new PancakeClient({
        apiKey: "test-api-key",
        fetcher: async (_input, init) => {
          assert.equal(init?.method, "POST");
          postCalls += 1;
          return new Response(JSON.stringify({ id: 900_000 + status }), {
            status,
            headers: { "content-type": "application/json" },
          });
        },
      });
      const gateway = createPancakeOrderGateway(client, async ({ shopId: requestedShopId }) => {
        assert.equal(requestedShopId, shopId);
        return [liveVariation];
      });
      const service = createPancakeOrderSubmissionService(prisma, gateway);

      assert.deepEqual(await service.submit({ publicCode: order.publicCode, shopId }), {
        ok: false,
        state: "SYNC_UNKNOWN",
        reason: "CREATE_OUTCOME_UNKNOWN",
      });
      assert.equal(postCalls, 1);

      const afterFirstAttempt = await prisma.orderMirror.findUniqueOrThrow({ where: { id: order.id } });
      assert.equal(afterFirstAttempt.state, "SYNC_UNKNOWN");
      assert.equal(afterFirstAttempt.pancakeOrderId, null);

      assert.deepEqual(await service.submit({ publicCode: order.publicCode, shopId }), {
        ok: false,
        state: "SYNC_UNKNOWN",
        reason: "CREATE_OUTCOME_UNKNOWN",
      });
      assert.equal(postCalls, 1);
    } finally {
      await cleanup(order.publicCode);
    }
  }
});
