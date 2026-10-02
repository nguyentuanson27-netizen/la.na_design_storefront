import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createCatalogMirrorRepository } from "../../src/commerce/catalog-mirror-repository.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";
import type { PancakeParsedCatalogVariation } from "../../src/integrations/pancake/catalog-contract.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required for database smoke tests");
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});
const repository = createCatalogMirrorRepository(prisma);
const shopId = 910_041;
const productId = "p17-field-name-product";
const variationId = "p17-field-name-variation";

async function cleanup() {
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: shopId } });
  await prisma.catalogSyncState.deleteMany({ where: { pancakeShopId: shopId } });
}

test.beforeEach(cleanup);
test.afterEach(cleanup);
test.after(async () => {
  await prisma.$disconnect();
});

test("catalog mirror maps Pancake option dimensions from field name instead of keyValue option value", async () => {
  const variation: PancakeParsedCatalogVariation = {
    id: variationId,
    productId,
    displayId: "A132-XANH-M",
    barcode: "A132-XANH-M",
    fields: [
      {
        id: "field-color",
        keyValue: "XANH",
        name: "màu",
        value: "Xanh",
      },
      {
        id: "field-size",
        keyValue: "M",
        name: "size",
        value: "M",
      },
    ],
    imageUrls: [],
    isHidden: false,
    isLocked: false,
    retailPrice: 500_000,
    retailPriceAfterDiscount: 500_000,
    product: {
      id: productId,
      name: "Áo A132",
      sourceDescription: null,
      primaryImageUrl: null,
    },
    warehouseStocks: [{ warehouseId: "warehouse-p17", remainQuantity: 1 }],
    sellableStock: 1,
  };

  await repository.syncSnapshot({
    shopId,
    variations: [variation],
    syncedAt: new Date("2026-08-23T04:30:00.000Z"),
  });

  const mirrored = await prisma.variantMirror.findUniqueOrThrow({
    where: { pancakeVariationId: variationId },
    select: { color: true, size: true },
  });

  assert.equal(mirrored.size, "M");
  assert.equal(mirrored.color, "Xanh");
});
