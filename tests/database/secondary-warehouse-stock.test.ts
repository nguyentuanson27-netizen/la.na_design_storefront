import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createCatalogMirrorRepository } from "../../src/commerce/catalog-mirror-repository.ts";
import {
  purgeSecondaryWarehouseStock,
  syncSecondaryShopInventory,
} from "../../src/commerce/secondary-inventory-sync.ts";
import { findAmbiguousPrimarySkus } from "../../src/commerce/secondary-sku-guard.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";
import type { PancakeParsedCatalogVariation } from "../../src/integrations/pancake/catalog-contract.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required for database smoke tests");
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const repository = createCatalogMirrorRepository(prisma);
const primaryShopId = 920_238;
const secondaryShopId = 920_239;
const otherSecondaryShopId = 920_240;

const t = (minute: number) => new Date(Date.UTC(2026, 10, 2, 12, minute));

function primaryVariation(
  id: string,
  displayId: string | null,
  stocks: Array<{ warehouseId: string; remainQuantity: number }>,
): PancakeParsedCatalogVariation {
  return {
    id,
    productId: "secondary-stock-product",
    displayId,
    barcode: `BAR-${id}`,
    fields: [
      { id: "field-color", keyValue: "color", name: "Color", value: "Black" },
      { id: "field-size", keyValue: "size", name: "Size", value: id },
    ],
    imageUrls: ["https://example.test/p.jpg"],
    isHidden: false,
    isLocked: false,
    retailPrice: 500_000,
    retailPriceAfterDiscount: 450_000,
    product: { id: "secondary-stock-product", name: "Secondary Stock Product", sourceDescription: null, primaryImageUrl: null },
    warehouseStocks: stocks,
    sellableStock: stocks.reduce((total, stock) => total + stock.remainQuantity, 0),
  };
}

function secondaryClient(rows: Array<{ displayId: string; stocks: Array<[string, number]> }>) {
  return {
    async getJson() {
      return {
        success: true,
        page_number: 1,
        page_size: 100,
        total_entries: rows.length,
        total_pages: 1,
        data: rows.map((row, index) => ({
          id: `sec-${index}`,
          product_id: `sec-product-${index}`,
          display_id: row.displayId,
          barcode: `SEC-BAR-${index}`,
          fields: [],
          images: [],
          is_hidden: false,
          is_locked: false,
          retail_price: 1,
          retail_price_after_discount: 1,
          product: { id: `sec-product-${index}`, name: "Secondary" },
          variations_warehouses: row.stocks.map(([warehouse_id, remain_quantity]) => ({ warehouse_id, remain_quantity })),
        })),
      };
    },
  };
}

function syncSecondary(
  rows: Array<{ displayId: string; stocks: Array<[string, number]> }>,
  at: Date,
  shopId = secondaryShopId,
) {
  return syncSecondaryShopInventory({
    primaryShopId,
    secondaryShopId: shopId,
    secondaryClient: secondaryClient(rows),
    prisma,
    clock: () => at,
    warn: () => undefined,
  });
}

async function stockRows(variationId: string) {
  const rows = await prisma.warehouseStock.findMany({
    where: { variant: { pancakeVariationId: variationId } },
    orderBy: { pancakeWarehouseId: "asc" },
    select: { pancakeWarehouseId: true, quantity: true },
  });
  return rows.map((row) => [row.pancakeWarehouseId, row.quantity]);
}

async function sellable(variationId: string) {
  const products = await repository.listPresentProducts({ shopId: primaryShopId, limit: 10 });
  return products
    .flatMap((product) => product.variants)
    .find((variant) => variant.pancakeVariationId === variationId)?.sellableStock;
}

async function cleanup() {
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: primaryShopId } });
  await prisma.catalogSyncState.deleteMany({ where: { pancakeShopId: primaryShopId } });
}

test.beforeEach(cleanup);
test.afterEach(cleanup);
test.after(async () => {
  await prisma.$disconnect();
});

test("primary and secondary syncs each rewrite only their own warehouses, whatever order they run in", async () => {
  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [
      primaryVariation("v1", "SKU-1", [
        { warehouseId: "wh-a", remainQuantity: 3 },
        { warehouseId: "wh-b", remainQuantity: 4 },
      ]),
    ],
    syncedAt: t(0),
  });

  const result = await syncSecondary([{ displayId: "sku-1", stocks: [["wh-s1", 5], ["wh-s2", 1]] }], t(1));
  assert.equal(result.matchedCount, 1);
  assert.deepEqual(await stockRows("v1"), [
    ["secondary:920239:wh-s1", 5],
    ["secondary:920239:wh-s2", 1],
    ["wh-a", 3],
    ["wh-b", 4],
  ]);
  assert.equal(await sellable("v1"), 13);

  // The primary shop drops a warehouse and changes another. Its sync removes exactly that warehouse
  // and leaves the secondary contribution as it was.
  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [primaryVariation("v1", "SKU-1", [{ warehouseId: "wh-a", remainQuantity: 2 }])],
    syncedAt: t(2),
  });
  assert.deepEqual(await stockRows("v1"), [
    ["secondary:920239:wh-s1", 5],
    ["secondary:920239:wh-s2", 1],
    ["wh-a", 2],
  ]);
  assert.equal(await sellable("v1"), 8);

  // The primary shop empties out entirely. The secondary rows still stand.
  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [primaryVariation("v1", "SKU-1", [])],
    syncedAt: t(3),
  });
  assert.deepEqual(await stockRows("v1"), [
    ["secondary:920239:wh-s1", 5],
    ["secondary:920239:wh-s2", 1],
  ]);

  // The secondary shop drops a warehouse, then loses the SKU: only its own rows go.
  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [primaryVariation("v1", "SKU-1", [{ warehouseId: "wh-a", remainQuantity: 2 }])],
    syncedAt: t(4),
  });
  await syncSecondary([{ displayId: "SKU-1", stocks: [["wh-s1", 6]] }], t(5));
  assert.deepEqual(await stockRows("v1"), [["secondary:920239:wh-s1", 6], ["wh-a", 2]]);

  await syncSecondary([{ displayId: "OTHER", stocks: [["wh-s1", 6]] }], t(6));
  assert.deepEqual(await stockRows("v1"), [["wh-a", 2]]);
  assert.equal(await sellable("v1"), 2);
});

test("a secondary sync that committed later never makes a primary read look superseded", async () => {
  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [primaryVariation("v1", "SKU-1", [{ warehouseId: "wh-a", remainQuantity: 3 }])],
    syncedAt: t(0),
  });
  // The secondary rows carry a later timestamp than the primary read that follows began at.
  await syncSecondary([{ displayId: "SKU-1", stocks: [["wh-s1", 5]] }], t(30));

  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [primaryVariation("v1", "SKU-1", [{ warehouseId: "wh-a", remainQuantity: 9 }])],
    syncedAt: t(10),
  });

  assert.deepEqual(await stockRows("v1"), [["secondary:920239:wh-s1", 5], ["wh-a", 9]]);
});

test("a secondary sync does not move the primary stock watermark", async () => {
  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [primaryVariation("v1", "SKU-1", [{ warehouseId: "wh-a", remainQuantity: 3 }])],
    syncedAt: t(0),
  });
  const before = await prisma.variantMirror.findFirstOrThrow({ where: { pancakeVariationId: "v1" }, select: { stockObservedAt: true } });

  await syncSecondary([{ displayId: "SKU-1", stocks: [["wh-s1", 5]] }], t(45));

  const after = await prisma.variantMirror.findFirstOrThrow({ where: { pancakeVariationId: "v1" }, select: { stockObservedAt: true } });
  assert.deepEqual(after.stockObservedAt, before.stockObservedAt);
});

test("a SKU shared by two primary variants receives no secondary stock, and loses what it had", async () => {
  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [
      primaryVariation("v1", "SKU-1", [{ warehouseId: "wh-a", remainQuantity: 1 }]),
      primaryVariation("v2", "SKU-2", [{ warehouseId: "wh-a", remainQuantity: 1 }]),
    ],
    syncedAt: t(0),
  });
  await syncSecondary([{ displayId: "SKU-2", stocks: [["wh-s1", 5]] }], t(1));
  assert.deepEqual(await stockRows("v2"), [["secondary:920239:wh-s1", 5], ["wh-a", 1]]);

  // v1 is renamed to the same SKU as v2: the 5 units cannot be told apart, so neither gets them.
  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [
      primaryVariation("v1", "sku-2 ", [{ warehouseId: "wh-a", remainQuantity: 1 }]),
      primaryVariation("v2", "SKU-2", [{ warehouseId: "wh-a", remainQuantity: 1 }]),
    ],
    syncedAt: t(2),
  });
  const result = await syncSecondary([{ displayId: "SKU-2", stocks: [["wh-s1", 5]] }], t(3));

  assert.equal(result.ambiguousCount, 1);
  assert.deepEqual(await stockRows("v1"), [["wh-a", 1]]);
  assert.deepEqual(await stockRows("v2"), [["wh-a", 1]]);
});

test("purging drops stale, orphaned or disabled secondary stock and leaves primary stock alone", async () => {
  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [primaryVariation("v1", "SKU-1", [{ warehouseId: "wh-a", remainQuantity: 3 }])],
    syncedAt: t(0),
  });
  await syncSecondary([{ displayId: "SKU-1", stocks: [["wh-s1", 5]] }], t(10));
  await syncSecondary([{ displayId: "SKU-1", stocks: [["wh-s9", 2]] }], t(20), otherSecondaryShopId);
  assert.equal((await stockRows("v1")).length, 3);

  // The configured shop changed: the previous shop's rows go, the configured shop's stay.
  assert.equal(await purgeSecondaryWarehouseStock(prisma, { exceptShopId: secondaryShopId }), 1);
  assert.deepEqual(await stockRows("v1"), [["secondary:920239:wh-s1", 5], ["wh-a", 3]]);

  // Its sync has been failing since t(10): rows older than the cutoff go, fresher ones would stay.
  assert.equal(await purgeSecondaryWarehouseStock(prisma, { shopId: secondaryShopId, syncedBefore: t(5) }), 0);
  assert.equal(await purgeSecondaryWarehouseStock(prisma, { shopId: secondaryShopId, syncedBefore: t(15) }), 1);
  assert.deepEqual(await stockRows("v1"), [["wh-a", 3]]);

  // Feature switched off.
  await syncSecondary([{ displayId: "SKU-1", stocks: [["wh-s1", 5]] }], t(30));
  assert.equal(await purgeSecondaryWarehouseStock(prisma), 1);
  assert.deepEqual(await stockRows("v1"), [["wh-a", 3]]);
  assert.equal(await sellable("v1"), 3);
});

test("a variant whose SKU is removed loses the secondary stock it had", async () => {
  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [primaryVariation("v1", "SKU-1", [{ warehouseId: "wh-a", remainQuantity: 1 }])],
    syncedAt: t(0),
  });
  await syncSecondary([{ displayId: "SKU-1", stocks: [["wh-s1", 5]] }], t(1));
  assert.deepEqual(await stockRows("v1"), [["secondary:920239:wh-s1", 5], ["wh-a", 1]]);

  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [primaryVariation("v1", null, [{ warehouseId: "wh-a", remainQuantity: 1 }])],
    syncedAt: t(2),
  });
  await syncSecondary([{ displayId: "SKU-1", stocks: [["wh-s1", 5]] }], t(3));

  assert.deepEqual(await stockRows("v1"), [["wh-a", 1]]);
});

async function preorderCycle(variationId: string) {
  const variant = await prisma.variantMirror.findFirstOrThrow({
    where: { pancakeVariationId: variationId },
    select: { id: true },
  });
  return prisma.variantAvailabilityCycle.findUnique({
    where: { variantId: variant.id },
    select: { lastStockNonPositive: true },
  });
}

test("a preorder variant is only sold out when the primary AND the secondary shop are", async () => {
  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [primaryVariation("v1", "SKU-1", [{ warehouseId: "wh-a", remainQuantity: 1 }])],
    syncedAt: t(0),
  });
  const product = await prisma.productMirror.findFirstOrThrow({ where: { pancakeShopId: primaryShopId } });
  await prisma.productSellingPolicy.create({
    data: { productId: product.id, sellingMode: "PREORDER", negativeStockLimit: -20 },
  });

  // Primary runs out: the cycle opens.
  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [primaryVariation("v1", "SKU-1", [{ warehouseId: "wh-a", remainQuantity: 0 }])],
    syncedAt: t(1),
  });
  assert.equal((await preorderCycle("v1"))?.lastStockNonPositive, true);

  // The secondary shop holds stock: the variant is not sold out, without any primary read.
  await syncSecondary([{ displayId: "SKU-1", stocks: [["wh-s1", 3]] }], t(2));
  assert.equal((await preorderCycle("v1"))?.lastStockNonPositive, false);

  // A later primary read of 0 must not reopen it while the secondary stock stands.
  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [primaryVariation("v1", "SKU-1", [{ warehouseId: "wh-a", remainQuantity: 0 }])],
    syncedAt: t(3),
  });
  assert.equal((await preorderCycle("v1"))?.lastStockNonPositive, false);

  // The same through the targeted path that webhooks use.
  await repository.applyVariationStocks({
    shopId: primaryShopId,
    observations: [{ variationId: "v1", warehouseStocks: [{ warehouseId: "wh-a", remainQuantity: 0 }] }],
    syncedAt: t(4),
  });
  assert.equal((await preorderCycle("v1"))?.lastStockNonPositive, false);

  // The secondary shop sells out too: now it is sold out.
  await syncSecondary([], t(5));
  assert.equal((await preorderCycle("v1"))?.lastStockNonPositive, true);
});

test("findAmbiguousPrimarySkus reports SKUs shared by variants still on sale, case and padding aside", async () => {
  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [
      primaryVariation("v1", "DUP-1", [{ warehouseId: "wh-a", remainQuantity: 1 }]),
      primaryVariation("v2", " dup-1 ", [{ warehouseId: "wh-a", remainQuantity: 1 }]),
      primaryVariation("v3", "ONE-1", [{ warehouseId: "wh-a", remainQuantity: 1 }]),
    ],
    syncedAt: t(0),
  });

  const found = await findAmbiguousPrimarySkus(prisma, primaryShopId, ["DUP-1", "ONE-1", "NONE-1"]);
  assert.deepEqual([...found], ["DUP-1"]);
  assert.deepEqual([...(await findAmbiguousPrimarySkus(prisma, primaryShopId, []))], []);

  // A retired twin no longer competes for the SKU.
  await prisma.variantMirror.updateMany({ where: { pancakeVariationId: "v2" }, data: { isPresent: false } });
  assert.deepEqual([...(await findAmbiguousPrimarySkus(prisma, primaryShopId, ["DUP-1"]))], []);
});
