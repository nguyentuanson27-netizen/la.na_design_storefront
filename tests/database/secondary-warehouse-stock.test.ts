import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createCatalogMirrorRepository } from "../../src/commerce/catalog-mirror-repository.ts";
import {
  configureSecondaryShop,
  purgeSecondaryWarehouseStock,
  syncSecondaryShopInventory,
} from "../../src/commerce/secondary-inventory-sync.ts";
import { syncConfiguredPancakeCatalog } from "../../src/commerce/catalog-sync-runtime.ts";
import { prisma as runtimePrisma } from "../../src/db/prisma.ts";
import { normalizedSkuSql } from "../../src/commerce/sku-sql.ts";
import { createCapacityReservationRepository } from "../../src/commerce/capacity-reservation.ts";
import { findAmbiguousPrimarySkus, findUnsafePrimarySkus } from "../../src/commerce/secondary-sku-guard.ts";
import { normalizeSku } from "../../src/integrations/pancake/sku.ts";
import type { PancakeCompositeSnapshot } from "../../src/integrations/pancake/composite-contract.ts";
import { Prisma, PrismaClient } from "../../src/generated/prisma/client.ts";
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

/** What the runtime does before any secondary sync: the shop is stored as the configured one. */
async function activate(shopId = secondaryShopId) {
  await prisma.catalogSyncState.updateMany({
    where: { pancakeShopId: primaryShopId },
    data: { secondaryShopId: shopId },
  });
}

async function syncSecondary(
  rows: Array<{ displayId: string; stocks: Array<[string, number]> }>,
  at: Date,
  shopId = secondaryShopId,
) {
  await activate(shopId);
  return syncSecondaryShopInventory({
    primaryShopId,
    secondaryShopId: shopId,
    secondaryClient: secondaryClient(rows),
    prisma,
    clock: () => at,
    warn: () => undefined,
  });
}

/**
 * A client that runs `beforeFirstTransaction` right before its first transaction opens: after the
 * secondary sync has read its shop and its candidate variants, before it takes the catalog lock.
 */
function racingPrisma(beforeFirstTransaction: () => Promise<void>): PrismaClient {
  let first = true;
  return {
    variantMirror: prisma.variantMirror,
    async $transaction(fn: unknown, options: unknown) {
      if (first) {
        first = false;
        await beforeFirstTransaction();
      }
      return (prisma.$transaction as (f: unknown, o: unknown) => Promise<unknown>).call(prisma, fn, options);
    },
  } as unknown as PrismaClient;
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
  await prisma.variantCapacityReservation.deleteMany({
    where: { variant: { product: { pancakeShopId: primaryShopId } } },
  });
  await prisma.orderMirror.deleteMany({ where: { publicCode: { startsWith: "sec-handoff" } } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: primaryShopId } });
  await prisma.catalogSyncState.deleteMany({ where: { pancakeShopId: primaryShopId } });
}

test.beforeEach(cleanup);
test.afterEach(cleanup);
test.after(async () => {
  await prisma.$disconnect();
  await runtimePrisma.$disconnect();
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
  assert.equal(await purgeSecondaryWarehouseStock(prisma, { primaryShopId, exceptShopId: secondaryShopId }), 1);
  assert.deepEqual(await stockRows("v1"), [["secondary:920239:wh-s1", 5], ["wh-a", 3]]);

  // Its sync has been failing since t(10): rows older than the cutoff go, fresher ones would stay.
  assert.equal(await purgeSecondaryWarehouseStock(prisma, { primaryShopId, shopId: secondaryShopId, syncedBefore: t(5) }), 0);
  assert.equal(await purgeSecondaryWarehouseStock(prisma, { primaryShopId, shopId: secondaryShopId, syncedBefore: t(15) }), 1);
  assert.deepEqual(await stockRows("v1"), [["wh-a", 3]]);

  // Feature switched off.
  await syncSecondary([{ displayId: "SKU-1", stocks: [["wh-s1", 5]] }], t(30));
  assert.equal(await purgeSecondaryWarehouseStock(prisma, { primaryShopId }), 1);
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

test("an older secondary read that commits after a newer EMPTY one cannot bring deleted stock back", async () => {
  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [primaryVariation("v1", "SKU-1", [{ warehouseId: "wh-a", remainQuantity: 1 }])],
    syncedAt: t(0),
  });

  // B began at t(20) and saw the SKU gone; it commits first and removes the secondary rows.
  await syncSecondary([{ displayId: "SKU-1", stocks: [["wh-s1", 5]] }], t(5));
  await syncSecondary([], t(20));
  assert.deepEqual(await stockRows("v1"), [["wh-a", 1]]);

  // A began at t(10), before B, saw 5, and commits late. B left no row behind to compare with, so
  // only the durable marker can tell A is older.
  const late = await syncSecondary([{ displayId: "SKU-1", stocks: [["wh-s1", 5]] }], t(10));

  assert.equal(late.matchedCount, 1, "A did match the SKU in what it read");
  assert.deepEqual(await stockRows("v1"), [["wh-a", 1]]);

  // A genuinely newer read still applies.
  await syncSecondary([{ displayId: "SKU-1", stocks: [["wh-s1", 2]] }], t(30));
  assert.deepEqual(await stockRows("v1"), [["secondary:920239:wh-s1", 2], ["wh-a", 1]]);
});

// End to end: whichever statement takes the row first (the watermark stamp or the explicit lock), the
// write cannot run under a reservation that already holds the row. That the chunk also locks ALL its
// rows up front, sorted, before any write (so two multi-row lockers cannot deadlock) is asserted on
// the hook order in tests/domain/secondary-inventory-sync.test.ts.
test("a secondary stock write waits for a reservation's lock on the variant row", async () => {
  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [primaryVariation("v1", "SKU-1", [{ warehouseId: "wh-a", remainQuantity: 1 }])],
    syncedAt: t(0),
  });
  const variant = await prisma.variantMirror.findFirstOrThrow({ where: { pancakeVariationId: "v1" }, select: { id: true } });

  let releaseReservation!: () => void;
  const reservationMayFinish = new Promise<void>((resolve) => {
    releaseReservation = resolve;
  });
  let reservationHoldsLock!: () => void;
  const lockTaken = new Promise<void>((resolve) => {
    reservationHoldsLock = resolve;
  });

  // What `reserveOrderCapacity()` does: lock the variant row, read the stock, decide, then commit.
  const reservation = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "VariantMirror" WHERE "id" = ${variant.id} FOR UPDATE`;
    const seen = await tx.warehouseStock.findMany({ where: { variantId: variant.id }, select: { quantity: true } });
    reservationHoldsLock();
    await reservationMayFinish;
    return seen.reduce((total, row) => total + row.quantity, 0);
  });
  await lockTaken;

  let writeSettled = false;
  const write = syncSecondary([{ displayId: "SKU-1", stocks: [["wh-s1", 5]] }], t(1)).then(() => {
    writeSettled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(writeSettled, false, "the secondary write must wait for the reservation");

  releaseReservation();
  assert.equal(await reservation, 1, "the reservation judged the stock as it was before the write");
  await write;
  assert.deepEqual(await stockRows("v1"), [["secondary:920239:wh-s1", 5], ["wh-a", 1]]);
});

test("purging secondary stock (disabled, stale, or shop changed) re-observes a preorder variant's cycle", async () => {
  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [primaryVariation("v1", "SKU-1", [{ warehouseId: "wh-a", remainQuantity: 1 }])],
    syncedAt: t(0),
  });
  const product = await prisma.productMirror.findFirstOrThrow({ where: { pancakeShopId: primaryShopId } });
  await prisma.productSellingPolicy.create({
    data: { productId: product.id, sellingMode: "PREORDER", negativeStockLimit: -20 },
  });
  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [primaryVariation("v1", "SKU-1", [{ warehouseId: "wh-a", remainQuantity: 0 }])],
    syncedAt: t(1),
  });
  const restock = async (minute: number) => {
    await syncSecondary([{ displayId: "SKU-1", stocks: [["wh-s1", 5]] }], t(minute));
    assert.equal((await preorderCycle("v1"))?.lastStockNonPositive, false);
  };

  // Feature switched off.
  await restock(2);
  assert.equal(await purgeSecondaryWarehouseStock(prisma, { primaryShopId, observedAt: t(3) }), 1);
  assert.equal((await preorderCycle("v1"))?.lastStockNonPositive, true, "disabled");

  // The secondary sync has been failing for too long.
  await restock(4);
  assert.equal(
    await purgeSecondaryWarehouseStock(prisma, { primaryShopId, shopId: secondaryShopId, syncedBefore: t(50), observedAt: t(51) }),
    1,
  );
  assert.equal((await preorderCycle("v1"))?.lastStockNonPositive, true, "stale");

  // The configured shop changed and the new one has not synced yet.
  await syncSecondary([{ displayId: "SKU-1", stocks: [["wh-s9", 5]] }], t(60), otherSecondaryShopId);
  assert.equal((await preorderCycle("v1"))?.lastStockNonPositive, false);
  assert.equal(
    await purgeSecondaryWarehouseStock(prisma, { primaryShopId, exceptShopId: secondaryShopId, observedAt: t(61) }),
    1,
  );
  assert.equal((await preorderCycle("v1"))?.lastStockNonPositive, true, "shop changed");

  // Nothing to purge: no observation, no error.
  assert.equal(await purgeSecondaryWarehouseStock(prisma, { primaryShopId, observedAt: t(62) }), 0);
});

test("renaming a primary SKU takes the old SKU's secondary stock off the variant even if the secondary API never answers", async () => {
  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [primaryVariation("v1", "SKU-A", [{ warehouseId: "wh-a", remainQuantity: 1 }])],
    syncedAt: t(0),
  });
  await syncSecondary([{ displayId: "SKU-A", stocks: [["wh-s1", 5]] }], t(1));
  assert.equal(await sellable("v1"), 6);

  // The primary sync renames v1 to SKU-B; the secondary sync that would follow fails, so it never runs.
  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [primaryVariation("v1", "SKU-B", [{ warehouseId: "wh-a", remainQuantity: 1 }])],
    syncedAt: t(2),
  });

  assert.deepEqual(await stockRows("v1"), [["wh-a", 1]]);
  assert.equal(await sellable("v1"), 1, "B does not carry A's stock");
});

test("a primary sync that removes a SKU, retires the variant, or makes the SKU shared drops the secondary stock at once", async () => {
  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [
      primaryVariation("v1", "SKU-1", [{ warehouseId: "wh-a", remainQuantity: 1 }]),
      primaryVariation("v2", "SKU-2", [{ warehouseId: "wh-a", remainQuantity: 1 }]),
      primaryVariation("v3", "SKU-3", [{ warehouseId: "wh-a", remainQuantity: 1 }]),
    ],
    syncedAt: t(0),
  });
  await syncSecondary(
    [
      { displayId: "SKU-1", stocks: [["wh-s1", 5]] },
      { displayId: "SKU-2", stocks: [["wh-s1", 5]] },
      { displayId: "SKU-3", stocks: [["wh-s1", 5]] },
    ],
    t(1),
  );
  assert.equal((await stockRows("v1")).length, 2);

  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [
      primaryVariation("v1", null, [{ warehouseId: "wh-a", remainQuantity: 1 }]), // SKU removed
      primaryVariation("v3", "sku-2", [{ warehouseId: "wh-a", remainQuantity: 1 }]), // now shares v2's SKU
      // v2 is absent from the snapshot: retired.
    ],
    syncedAt: t(2),
  });

  assert.deepEqual(await stockRows("v1"), [["wh-a", 1]]);
  assert.deepEqual(await stockRows("v2"), [], "retired variant keeps nothing");
  assert.deepEqual(await stockRows("v3"), [["wh-a", 1]], "SKU now shared with another variant on sale");
});

test("a primary sync leaves a correctly attributed secondary contribution alone", async () => {
  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [primaryVariation("v1", "SKU-A", [{ warehouseId: "wh-a", remainQuantity: 1 }])],
    syncedAt: t(0),
  });
  await syncSecondary([{ displayId: "SKU-A", stocks: [["wh-s1", 5]] }], t(1));

  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [primaryVariation("v1", " sku-a ", [{ warehouseId: "wh-a", remainQuantity: 2 }])],
    syncedAt: t(2),
  });

  assert.deepEqual(await stockRows("v1"), [["secondary:920239:wh-s1", 5], ["wh-a", 2]]);
});

test("a primary sync that commits between the candidate read and the lock cannot receive the old SKU's stock", async () => {
  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [
      primaryVariation("v1", "SKU-A", [{ warehouseId: "wh-a", remainQuantity: 1 }]),
      primaryVariation("v2", "SKU-C", [{ warehouseId: "wh-a", remainQuantity: 1 }]),
    ],
    syncedAt: t(0),
  });

  // The secondary sync has read its shop and the candidate variants. Before it takes the lock, a
  // primary sync renames v1 to SKU-B and gives v2 the SKU-A.
  await activate();
  let raced = false;
  const racing = racingPrisma(async () => {
    if (!raced) {
      raced = true;
      await repository.syncSnapshot({
        shopId: primaryShopId,
        variations: [
          primaryVariation("v1", "SKU-B", [{ warehouseId: "wh-a", remainQuantity: 1 }]),
          primaryVariation("v2", "SKU-A", [{ warehouseId: "wh-a", remainQuantity: 1 }]),
        ],
        syncedAt: t(1),
      });
    }
  });

  await syncSecondaryShopInventory({
    primaryShopId,
    secondaryShopId,
    secondaryClient: secondaryClient([
      { displayId: "SKU-A", stocks: [["wh-s1", 5]] },
      { displayId: "SKU-B", stocks: [["wh-s1", 2]] },
    ]),
    prisma: racing,
    clock: () => t(2),
    warn: () => undefined,
  });

  assert.equal(raced, true);
  assert.deepEqual(await stockRows("v1"), [["secondary:920239:wh-s1", 2], ["wh-a", 1]], "v1 is SKU-B now");
  assert.deepEqual(await stockRows("v2"), [["secondary:920239:wh-s1", 5], ["wh-a", 1]], "v2 is SKU-A now");
});

test("a SKU that became shared between the candidate read and the lock gets no secondary stock", async () => {
  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [
      primaryVariation("v1", "SKU-A", [{ warehouseId: "wh-a", remainQuantity: 1 }]),
      primaryVariation("v2", "SKU-C", [{ warehouseId: "wh-a", remainQuantity: 1 }]),
    ],
    syncedAt: t(0),
  });

  await activate();
  let raced = false;
  const racing = racingPrisma(async () => {
    if (!raced) {
      raced = true;
      await repository.syncSnapshot({
        shopId: primaryShopId,
        variations: [
          primaryVariation("v1", "SKU-A", [{ warehouseId: "wh-a", remainQuantity: 1 }]),
          primaryVariation("v2", "SKU-A", [{ warehouseId: "wh-a", remainQuantity: 1 }]),
        ],
        syncedAt: t(1),
      });
    }
  });

  const result = await syncSecondaryShopInventory({
    primaryShopId,
    secondaryShopId,
    secondaryClient: secondaryClient([{ displayId: "SKU-A", stocks: [["wh-s1", 5]] }]),
    prisma: racing,
    clock: () => t(2),
    warn: () => undefined,
  });

  assert.equal(result.ambiguousCount, 1);
  assert.deepEqual(await stockRows("v1"), [["wh-a", 1]]);
  assert.deepEqual(await stockRows("v2"), [["wh-a", 1]]);
});

test("the SQL normalization equals normalizeSku() for every BMP character at the ends of a SKU", async () => {
  const samples: string[] = [];
  for (let code = 1; code <= 0xffff; code += 1) {
    if (code >= 0xd800 && code <= 0xdfff) continue; // lone surrogates cannot be stored
    const char = String.fromCharCode(code);
    samples.push(`${char}a-1${char}`);
  }
  samples.push("", "SKU-A", "sku-a", "\tSKU-A", "\u00a0sku-a\u3000", "stra\u00dfe", "AO XL", "  ");

  const rows = await prisma.$queryRaw<Array<{ input: string; normalized: string | null }>>(Prisma.sql`
    SELECT s.input AS input, ${normalizedSkuSql(Prisma.sql`s.input`)} AS normalized
    FROM unnest(${samples}::text[]) AS s(input)
  `);

  assert.equal(rows.length, samples.length);
  const mismatches = rows
    .filter((row) => row.normalized !== normalizeSku(row.input))
    .map((row) => JSON.stringify(row.input));
  assert.deepEqual(mismatches, []);
});

test("SKUs that differ only by tab or no-break space are one SKU: shared, so none gets secondary stock", async () => {
  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [
      primaryVariation("v1", "\tSKU-A", [{ warehouseId: "wh-a", remainQuantity: 1 }]),
      primaryVariation("v2", "SKU-A", [{ warehouseId: "wh-a", remainQuantity: 1 }]),
      primaryVariation("v3", "\u00a0sku-b\u00a0", [{ warehouseId: "wh-a", remainQuantity: 1 }]),
      primaryVariation("v4", "SKU-B", [{ warehouseId: "wh-a", remainQuantity: 1 }]),
    ],
    syncedAt: t(0),
  });

  const found = await findAmbiguousPrimarySkus(prisma, primaryShopId, ["SKU-A", "SKU-B", "SKU-C"]);
  assert.deepEqual([...found].sort(), ["SKU-A", "SKU-B"], "the checkout guard sees them");

  const result = await syncSecondary(
    [
      { displayId: "SKU-A", stocks: [["wh-s1", 5]] },
      { displayId: "SKU-B", stocks: [["wh-s1", 5]] },
    ],
    t(1),
  );
  assert.equal(result.ambiguousCount, 2);
  for (const id of ["v1", "v2", "v3", "v4"]) {
    assert.deepEqual(await stockRows(id), [["wh-a", 1]], `${id} received nothing`);
  }
});

test("a primary sync keeps a valid contribution for a SKU written with a tab or no-break space", async () => {
  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [primaryVariation("v1", "\u00a0SKU-A\t", [{ warehouseId: "wh-a", remainQuantity: 1 }])],
    syncedAt: t(0),
  });
  await syncSecondary([{ displayId: "sku-a", stocks: [["wh-s1", 5]] }], t(1));
  assert.deepEqual(await stockRows("v1"), [["secondary:920239:wh-s1", 5], ["wh-a", 1]]);

  // The cleanup that runs inside every primary sync must not mistake it for a renamed SKU.
  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [primaryVariation("v1", "\u00a0SKU-A\t", [{ warehouseId: "wh-a", remainQuantity: 2 }])],
    syncedAt: t(2),
  });

  assert.deepEqual(await stockRows("v1"), [["secondary:920239:wh-s1", 5], ["wh-a", 2]]);
});

function comboVariation(id: string, productId: string, displayId: string | null, stock: number) {
  return {
    ...primaryVariation(id, displayId, [{ warehouseId: "wh-a", remainQuantity: stock }]),
    productId,
    product: { id: productId, name: productId, sourceDescription: null, primaryImageUrl: null },
  };
}

const comboSnapshot: PancakeCompositeSnapshot = {
  parentVariationIds: ["set-m"],
  componentVariationIds: ["shirt-m"],
  parentIdentities: [{ variationId: "set-m", productId: "set-product" }],
  componentIdentities: [{ variationId: "shirt-m", productId: "shirt-product" }],
  edges: [{ parentVariationId: "set-m", componentVariationId: "shirt-m", quantity: 1 }],
};

test("a PREORDER combo is judged on its component's stock AFTER a rename removes the old SKU's secondary stock", async () => {
  const sync = (shirtSku: string, shirtStock: number, minute: number) =>
    repository.syncSnapshot({
      shopId: primaryShopId,
      variations: [
        comboVariation("set-m", "set-product", null, 0),
        comboVariation("shirt-m", "shirt-product", shirtSku, shirtStock),
      ],
      compositeSnapshot: comboSnapshot,
      syncedAt: t(minute),
    });

  await sync("SKU-A", 0, 0);
  const setProduct = await prisma.productMirror.findFirstOrThrow({
    where: { pancakeShopId: primaryShopId, pancakeProductId: "set-product" },
  });
  await prisma.productSellingPolicy.create({
    data: { productId: setProduct.id, sellingMode: "PREORDER", negativeStockLimit: -20 },
  });

  // The secondary shop holds 5 of the shirt: the combo can be made.
  await syncSecondary([{ displayId: "SKU-A", stocks: [["wh-s1", 5]] }], t(1));
  assert.equal((await preorderCycle("set-m"))?.lastStockNonPositive, false);

  // The primary sync renames the shirt to SKU-B and the secondary API never answers. The 5 units
  // belonged to SKU-A: after the commit the combo has no capacity and its cycle must say so.
  await sync("SKU-B", 0, 2);

  assert.deepEqual(await stockRows("shirt-m"), [["wh-a", 0]]);
  assert.equal((await preorderCycle("set-m"))?.lastStockNonPositive, true);
});


test("a COMMITTED hold is handed off once the PRIMARY shop observed after the commit, whatever the age of the secondary rows", async () => {
  const mirror = createCatalogMirrorRepository(prisma, { clock: () => t(59) });
  const reservations = createCapacityReservationRepository(prisma);

  await mirror.syncSnapshot({
    shopId: primaryShopId,
    variations: [primaryVariation("v1", "SKU-1", [{ warehouseId: "wh-a", remainQuantity: 3 }])],
    syncedAt: t(0),
  });
  // The secondary rows were read at t(1) and stay at that age.
  await syncSecondary([{ displayId: "SKU-1", stocks: [["wh-s1", 5]] }], t(1));
  const variant = await prisma.variantMirror.findFirstOrThrow({ where: { pancakeVariationId: "v1" }, select: { id: true } });

  // The order is created in the primary POS and committed at t(10).
  const order = await prisma.orderMirror.create({ data: { publicCode: "sec-handoff-1" }, select: { id: true } });
  const outcome = await reservations.reserveOrderCapacity({
    orderId: order.id,
    lines: [{ variantId: variant.id, quantity: 2 }],
  });
  assert.equal(outcome.ok, true);
  const reservationId = outcome.ok ? outcome.reservations[0]!.id : "";
  assert.equal(await reservations.transitionReservation({ id: reservationId, from: "RESERVED", to: "SUBMITTING" }), true);
  assert.equal(
    await reservations.transitionReservation({ id: reservationId, from: "SUBMITTING", to: "COMMITTED", at: t(10) }),
    true,
  );

  // The primary shop is read after the commit and shows its decrement (3 -> 1). That read is the
  // evidence; the older secondary rows say nothing about this POS and must not keep the hold alive.
  const result = await mirror.syncSnapshot({
    shopId: primaryShopId,
    variations: [primaryVariation("v1", "SKU-1", [{ warehouseId: "wh-a", remainQuantity: 1 }])],
    syncedAt: t(20),
  });

  assert.equal(result.capacityHandedOff, 1);
  const resource = await prisma.capacityReservationResource.findFirstOrThrow({
    where: { reservationId },
    select: { mirroredAt: true, mirrorObservationStartedAt: true },
  });
  assert.deepEqual(resource, { mirroredAt: t(59), mirrorObservationStartedAt: t(20) });
});

test("a hold is still kept while the primary shop has not been read since the commit, however fresh the secondary rows are", async () => {
  const mirror = createCatalogMirrorRepository(prisma, { clock: () => t(59) });
  const reservations = createCapacityReservationRepository(prisma);

  await mirror.syncSnapshot({
    shopId: primaryShopId,
    variations: [primaryVariation("v1", "SKU-1", [{ warehouseId: "wh-a", remainQuantity: 3 }])],
    syncedAt: t(0),
  });
  const variant = await prisma.variantMirror.findFirstOrThrow({ where: { pancakeVariationId: "v1" }, select: { id: true } });
  const order = await prisma.orderMirror.create({ data: { publicCode: "sec-handoff-2" }, select: { id: true } });
  const outcome = await reservations.reserveOrderCapacity({
    orderId: order.id,
    lines: [{ variantId: variant.id, quantity: 2 }],
  });
  const reservationId = outcome.ok ? outcome.reservations[0]!.id : "";
  await reservations.transitionReservation({ id: reservationId, from: "RESERVED", to: "SUBMITTING" });
  await reservations.transitionReservation({ id: reservationId, from: "SUBMITTING", to: "COMMITTED", at: t(10) });

  // A secondary read after the commit is not evidence about the primary POS's decrement.
  await syncSecondary([{ displayId: "SKU-1", stocks: [["wh-s1", 5]] }], t(30));

  const resource = await prisma.capacityReservationResource.findFirstOrThrow({
    where: { reservationId },
    select: { mirroredAt: true },
  });
  assert.equal(resource.mirroredAt, null);
});

test("a live read the mirror disagrees with is unsafe: renamed, unknown or retired variants lose their SKU's secondary stock", async () => {
  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [
      primaryVariation("v1", "SKU-A", [{ warehouseId: "wh-a", remainQuantity: 1 }]),
      primaryVariation("v2", "SKU-B", [{ warehouseId: "wh-a", remainQuantity: 1 }]),
      primaryVariation("v3", "\tsku-c ", [{ warehouseId: "wh-a", remainQuantity: 1 }]),
    ],
    syncedAt: t(0),
  });
  const unsafe = async (entries: Array<[string, string]>) =>
    [...(await findUnsafePrimarySkus(prisma, primaryShopId, entries.map(([variationId, sku]) => ({ variationId, sku }))))].sort();

  // The mirror and the live read agree (padding and case aside): nothing is unsafe.
  assert.deepEqual(await unsafe([["v1", "SKU-A"], ["v3", "SKU-C"]]), []);

  // The POS has just renamed v2 from B to A. The mirror still says B, so it sees no duplicate of A
  // (v1 and v2 look distinct there); the disagreement is what marks A unsafe.
  assert.deepEqual(await findUnsafePrimarySkus(prisma, primaryShopId, [{ variationId: "v1", sku: "SKU-A" }]), new Set());
  assert.deepEqual(await unsafe([["v1", "SKU-A"], ["v2", "SKU-A"]]), ["SKU-A"]);

  // A variation the mirror has never seen.
  assert.deepEqual(await unsafe([["v-new", "SKU-N"]]), ["SKU-N"]);

  // A variant the mirror holds as retired but the POS still lists.
  await prisma.variantMirror.updateMany({ where: { pancakeVariationId: "v3" }, data: { isPresent: false } });
  assert.deepEqual(await unsafe([["v3", "SKU-C"]]), ["SKU-C"]);

  // Duplicates the mirror itself knows about stay unsafe, as before.
  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [
      primaryVariation("v1", "SKU-A", [{ warehouseId: "wh-a", remainQuantity: 1 }]),
      primaryVariation("v2", "sku-a", [{ warehouseId: "wh-a", remainQuantity: 1 }]),
    ],
    syncedAt: t(1),
  });
  assert.deepEqual(await unsafe([["v1", "SKU-A"]]), ["SKU-A"]);
});

// ---------------------------------------------------------------------------------------------
// Which secondary shop the deployment is configured with, stored under the shop's lock.
// ---------------------------------------------------------------------------------------------

async function activeShop() {
  return (await prisma.catalogSyncState.findUniqueOrThrow({ where: { pancakeShopId: primaryShopId } })).secondaryShopId;
}

async function seedPrimary() {
  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [primaryVariation("v1", "SKU-1", [{ warehouseId: "wh-a", remainQuantity: 1 }])],
    syncedAt: t(0),
  });
}

/** An in-flight sync of `shopId`: it has read its shop and its candidates and is about to take the lock. */
function inFlightSync(shopId: number, beforeLock: () => Promise<void>, rows: Array<{ displayId: string; stocks: Array<[string, number]> }>, at: Date) {
  let ran = false;
  return syncSecondaryShopInventory({
    primaryShopId,
    secondaryShopId: shopId,
    secondaryClient: secondaryClient(rows),
    prisma: racingPrisma(async () => {
      if (ran) return;
      ran = true;
      await beforeLock();
    }),
    clock: () => at,
    warn: () => undefined,
  });
}

test("a worker of the previous shop cannot write after the shop was replaced, even though rows of it were stored", async () => {
  await seedPrimary();
  await syncSecondary([{ displayId: "SKU-1", stocks: [["wh-s1", 5]] }], t(5)); // shop A is active, A rows stored

  const result = await inFlightSync(
    secondaryShopId,
    async () => {
      const outcome = await configureSecondaryShop(prisma, { primaryShopId, secondaryShopId: otherSecondaryShopId, observedAt: t(20) });
      assert.deepEqual(outcome, { changed: true, removed: 1 });
    },
    [{ displayId: "SKU-1", stocks: [["wh-s1", 9]] }],
    t(10),
  );

  assert.equal(result.discarded, true);
  assert.deepEqual(await stockRows("v1"), [["wh-a", 1]], "A's old rows went with the change and A wrote nothing back");

  await syncSecondary([{ displayId: "SKU-1", stocks: [["wh-s9", 7]] }], t(30), otherSecondaryShopId);
  assert.deepEqual(await stockRows("v1"), [["secondary:920240:wh-s9", 7], ["wh-a", 1]], "only B counts");
});

test("replacing the shop when the old one had stored NOTHING still stops the old worker: old read, change, old write, new write", async () => {
  await seedPrimary();
  await configureSecondaryShop(prisma, { primaryShopId, secondaryShopId }); // A is configured; no A rows exist
  assert.deepEqual(await stockRows("v1"), [["wh-a", 1]]);

  const old = await inFlightSync(
    secondaryShopId,
    async () => {
      const outcome = await configureSecondaryShop(prisma, { primaryShopId, secondaryShopId: otherSecondaryShopId, observedAt: t(20) });
      assert.deepEqual(outcome, { changed: true, removed: 0 }, "nothing to purge: the stored shop is all that stops the old worker");
    },
    [{ displayId: "SKU-1", stocks: [["wh-s1", 5]] }],
    t(10),
  );
  assert.equal(old.discarded, true);

  await syncSecondary([{ displayId: "SKU-1", stocks: [["wh-s9", 7]] }], t(30), otherSecondaryShopId);

  assert.deepEqual(await stockRows("v1"), [["secondary:920240:wh-s9", 7], ["wh-a", 1]], "A + B is never what counts");
});

test("switching the feature off stops a worker that was already running, and its stock never appears", async () => {
  await seedPrimary();
  await configureSecondaryShop(prisma, { primaryShopId, secondaryShopId });

  const result = await inFlightSync(
    secondaryShopId,
    async () => {
      await configureSecondaryShop(prisma, { primaryShopId, secondaryShopId: null, observedAt: t(20) });
    },
    [{ displayId: "SKU-1", stocks: [["wh-s1", 5]] }],
    t(10),
  );

  assert.equal(result.discarded, true);
  assert.deepEqual(await stockRows("v1"), [["wh-a", 1]]);
  assert.equal(await activeShop(), null);
});

test("a sync with no secondary shop configured at all writes nothing", async () => {
  await seedPrimary();
  const result = await syncSecondaryShopInventory({
    primaryShopId,
    secondaryShopId,
    secondaryClient: secondaryClient([{ displayId: "SKU-1", stocks: [["wh-s1", 5]] }]),
    prisma,
    clock: () => t(5),
    warn: () => undefined,
  });
  assert.equal(result.discarded, true);
  assert.deepEqual(await stockRows("v1"), [["wh-a", 1]]);
});

test("configuring is idempotent: only the first call changes anything, and a steady state touches no stock", async () => {
  await seedPrimary();
  const first = await configureSecondaryShop(prisma, { primaryShopId, secondaryShopId });
  await syncSecondary([{ displayId: "SKU-1", stocks: [["wh-s1", 5]] }], t(5));
  const again = await configureSecondaryShop(prisma, { primaryShopId, secondaryShopId, observedAt: t(10) });
  const thrice = await configureSecondaryShop(prisma, { primaryShopId, secondaryShopId, observedAt: t(20) });

  assert.deepEqual([first.changed, again.changed, thrice.changed], [true, false, false]);
  assert.deepEqual([again.removed, thrice.removed], [0, 0]);
  assert.deepEqual(await stockRows("v1"), [["secondary:920239:wh-s1", 5], ["wh-a", 1]]);
  assert.equal(await activeShop(), secondaryShopId);
});

test("before the first catalog sync there is nothing to store the shop in: configuring does nothing", async () => {
  const result = await configureSecondaryShop(prisma, { primaryShopId, secondaryShopId });
  assert.deepEqual(result, { changed: false, removed: 0 });
});

test("changing the configured shop takes no lock on any variant row when it has nothing to remove", async () => {
  await seedPrimary();
  await configureSecondaryShop(prisma, { primaryShopId, secondaryShopId });
  const variant = await prisma.variantMirror.findFirstOrThrow({ where: { pancakeVariationId: "v1" }, select: { id: true } });

  let release!: () => void;
  const mayFinish = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked!: () => void;
  const lockTaken = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const holder = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "VariantMirror" WHERE "id" = ${variant.id} FOR UPDATE`;
    locked();
    await mayFinish;
  });
  await lockTaken;

  try {
    const change = configureSecondaryShop(prisma, { primaryShopId, secondaryShopId: null, observedAt: t(20) });
    const outcome = await Promise.race([
      change.then(() => "finished" as const),
      new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 1500)),
    ]);
    assert.equal(outcome, "finished", "a reservation holding a variant row does not hold up a configuration change");
  } finally {
    release();
    await holder;
  }
  assert.equal(await activeShop(), null);
});

test("the stale-stock purge drops a failing shop's old rows and leaves fresher ones", async () => {
  await seedPrimary();
  await syncSecondary([{ displayId: "SKU-1", stocks: [["wh-s1", 5]] }], t(10));

  assert.equal(await purgeSecondaryWarehouseStock(prisma, { primaryShopId, shopId: secondaryShopId, syncedBefore: t(5) }), 0);
  assert.equal(await purgeSecondaryWarehouseStock(prisma, { primaryShopId, shopId: secondaryShopId, syncedBefore: t(15) }), 1);
  assert.deepEqual(await stockRows("v1"), [["wh-a", 1]]);
});

// ---------------------------------------------------------------------------------------------
// The runtime, with the primary Pancake API failing.
// ---------------------------------------------------------------------------------------------

async function withEnvironment<T>(env: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const saved = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  const savedFetch = globalThis.fetch;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = (async () => {
    throw new TypeError("network down");
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = savedFetch;
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const primaryOnlyEnv = { PANCAKE_API_KEY: "test-primary-key", PANCAKE_SHOP_ID: String(primaryShopId) };

test("a primary outage cannot leave a switched-off secondary shop's stock counting", async () => {
  await seedPrimary();
  const product = await prisma.productMirror.findFirstOrThrow({ where: { pancakeShopId: primaryShopId } });
  await prisma.productSellingPolicy.create({ data: { productId: product.id, sellingMode: "PREORDER", negativeStockLimit: -20 } });
  await repository.syncSnapshot({
    shopId: primaryShopId,
    variations: [primaryVariation("v1", "SKU-1", [{ warehouseId: "wh-a", remainQuantity: 0 }])],
    syncedAt: t(1),
  });
  await syncSecondary([{ displayId: "SKU-1", stocks: [["wh-s1", 5]] }], t(2));
  assert.equal((await preorderCycle("v1"))?.lastStockNonPositive, false);

  // The deployment now has no PANCAKE_SECONDARY_* and the primary API is down.
  await withEnvironment(
    { ...primaryOnlyEnv, PANCAKE_SECONDARY_SHOP_ID: undefined, PANCAKE_SECONDARY_API_KEY: undefined },
    async () => {
      await assert.rejects(() => syncConfiguredPancakeCatalog({ clock: () => t(10) }));
    },
  );

  assert.deepEqual(await stockRows("v1"), [["wh-a", 0]], "the old shop's stock is gone although the primary read failed");
  assert.equal((await preorderCycle("v1"))?.lastStockNonPositive, true, "and the preorder cycle was observed again");
  assert.equal(await activeShop(), null);
});

test("a primary outage cannot leave a replaced secondary shop's stock counting either", async () => {
  await seedPrimary();
  await syncSecondary([{ displayId: "SKU-1", stocks: [["wh-s1", 5]] }], t(2)); // shop A

  await withEnvironment(
    {
      ...primaryOnlyEnv,
      PANCAKE_SECONDARY_SHOP_ID: String(otherSecondaryShopId),
      PANCAKE_SECONDARY_API_KEY: "test-secondary-key",
    },
    async () => {
      await assert.rejects(() => syncConfiguredPancakeCatalog({ clock: () => t(10) }));
    },
  );

  assert.deepEqual(await stockRows("v1"), [["wh-a", 1]], "A's stock is gone");
  assert.equal(await activeShop(), otherSecondaryShopId, "and B is recorded as the configured shop");
});
