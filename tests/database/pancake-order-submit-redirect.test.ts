import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
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
  id: "redirect-variation-001",
  productId: "redirect-product-001",
  displayId: "redirect-display-001",
  barcode: "redirect-barcode-001",
  fields: [],
  imageUrls: [],
  isHidden: false,
  isLocked: false,
  retailPrice: 500_000,
  retailPriceAfterDiscount: 500_000,
  product: { id: "redirect-product-001", name: "Redirect Product" },
  warehouseStocks: [{ warehouseId: "redirect-warehouse-001", remainQuantity: 1 }],
  sellableStock: 1,
};

async function cleanup(publicCode: string) {
  await prisma.orderMirror.deleteMany({ where: { publicCode } });
}

async function createDraft(status: number) {
  const publicCode = `submit-redirect-${status}`;
  await cleanup(publicCode);
  return prisma.orderMirror.create({
    data: {
      publicCode,
      pancakeShopId: shopId,
      state: "DRAFT",
      checkoutSnapshottedAt: new Date("2026-08-12T04:05:16.000Z"),
      guestName: "Nguyễn Văn A",
      guestPhone: "0901234567",
      provinceRef: "province-01",
      districtRef: "district-001",
      communeRef: "commune-0001",
      addressDetail: "12 Đường A",
      note: "Gọi trước khi giao",
      merchandiseSubtotalVnd: BigInt(500_000),
      shippingFeeVnd: BigInt(30_000),
      totalVnd: BigInt(530_000),
      lines: {
        create: {
          variantId: `redirect-local-variant-${status}`,
          pancakeVariationId: liveVariation.id,
          productName: "Redirect Product",
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

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind to a TCP port");
  return address.port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test.after(async () => {
  await prisma.$disconnect();
});

test("create-order redirects cannot escape the validated Pancake origin and are never reposted", async () => {
  for (const redirectStatus of [307, 308]) {
    const order = await createDraft(redirectStatus);
    let trustedRequests = 0;
    let redirectedRequests = 0;
    let redirectedMethod = "";
    let redirectedBody = "";

    const redirectedServer = createServer((request, response) => {
      redirectedRequests += 1;
      redirectedMethod = request.method ?? "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        redirectedBody += chunk;
      });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: 910_000 + redirectStatus }));
      });
    });

    const trustedServer = createServer((_request, response) => {
      trustedRequests += 1;
      response.writeHead(redirectStatus, {
        location: `http://127.0.0.1:${redirectedPort}/capture`,
      });
      response.end();
    });

    let redirectedPort = 0;
    let trustedPort = 0;

    try {
      redirectedPort = await listen(redirectedServer);
      trustedPort = await listen(trustedServer);

      const client = new PancakeClient({
        apiKey: "test-api-key",
        fetcher: async (_input, init) => fetch(`http://127.0.0.1:${trustedPort}/orders`, init),
      });
      const gateway = createPancakeOrderGateway(
        client,
        async ({ shopId: requestedShopId }) => {
          assert.equal(requestedShopId, shopId);
          return [liveVariation];
        },
        // The targeted live read is injected too, so the fake HTTP client only ever sees the create.
        async ({ shopId: requestedShopId, variationIds }) => {
          assert.equal(requestedShopId, shopId);
          assert.deepEqual(variationIds, [liveVariation.id]);
          return [liveVariation];
        },
      );
      const service = createPancakeOrderSubmissionService(prisma, gateway);

      assert.deepEqual(await service.submit({ publicCode: order.publicCode, shopId }), {
        ok: false,
        state: "SYNC_UNKNOWN",
        reason: "CREATE_OUTCOME_UNKNOWN",
      });
      assert.equal(trustedRequests, 1);
      assert.equal(redirectedRequests, 0);
      assert.equal(redirectedMethod, "");
      assert.equal(redirectedBody, "");

      const afterFirstAttempt = await prisma.orderMirror.findUniqueOrThrow({ where: { id: order.id } });
      assert.equal(afterFirstAttempt.state, "SYNC_UNKNOWN");
      assert.equal(afterFirstAttempt.pancakeOrderId, null);

      assert.deepEqual(await service.submit({ publicCode: order.publicCode, shopId }), {
        ok: false,
        state: "SYNC_UNKNOWN",
        reason: "CREATE_OUTCOME_UNKNOWN",
      });
      assert.equal(trustedRequests, 1);
      assert.equal(redirectedRequests, 0);
    } finally {
      await close(trustedServer);
      await close(redirectedServer);
      await cleanup(order.publicCode);
    }
  }
});
