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
