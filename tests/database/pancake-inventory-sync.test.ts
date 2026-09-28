/**
 * Webhook-driven targeted inventory sync against a real database: the marker store, the 30-second
 * batch, the guarded stock write shared with the hourly full reconciliation, and the capacity
 * handoff it must preserve (ADR 0014 §4).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { readAdvisoryHeldQuantities } from "../../src/commerce/capacity-advisory.ts";
import { createCapacityReservationRepository } from "../../src/commerce/capacity-reservation.ts";
import { createCatalogMirrorRepository } from "../../src/commerce/catalog-mirror-repository.ts";
import {
  createInventorySignalRepository,
  handlePancakeInventoryWebhook,
  PANCAKE_WEBHOOK_SECRET_HEADER,
} from "../../src/commerce/pancake-inventory-signals.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";
import type {
  PancakeCatalogWarehouseStock,
  PancakeParsedCatalogVariation,
} from "../../src/integrations/pancake/catalog-contract.ts";
import { processInventorySignals } from "../../src/operations/inventory-batch.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const catalog = createCatalogMirrorRepository(prisma);
const signals = createInventorySignalRepository(prisma);
const reservations = createCapacityReservationRepository(prisma);

const SHOP = 920_419;
const P = "inv-webhook";
const SECRET = "inventory-webhook-secret-0123456789";
const T0 = new Date("2026-09-28T08:00:00.000Z");

async function cleanup() {
  await prisma.pancakeInventorySignal.deleteMany({ where: { pancakeVariationId: { startsWith: P } } });
  await prisma.variantCapacityReservation.deleteMany({ where: { variant: { product: { pancakeShopId: SHOP } } } });
  await prisma.orderMirror.deleteMany({ where: { publicCode: { startsWith: P } } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP } });
  await prisma.catalogSyncState.deleteMany({ where: { pancakeShopId: SHOP } });
}

test.beforeEach(cleanup);
test.afterEach(cleanup);
test.after(async () => prisma.$disconnect());

const TEE = `${P}-tee-m`;
const DRESS = `${P}-dress-m`;

function variation(id: string, productId: string, stocks: Record<string, number>): PancakeParsedCatalogVariation {
  const warehouseStocks = Object.entries(stocks).map(([warehouseId, remainQuantity]) => ({ warehouseId, remainQuantity }));
  return {
    id,
    productId,
    displayId: id,
    barcode: id,
    fields: [{ id: `${id}-size`, keyValue: "size", name: "Size", value: "M" }],
    imageUrls: [],
    isHidden: false,
    isLocked: false,
    retailPrice: 500_000,
    retailPriceAfterDiscount: 500_000,
    product: { id: productId, name: productId, sourceDescription: null, primaryImageUrl: null },
    warehouseStocks,
    sellableStock: warehouseStocks.reduce((total, { remainQuantity }) => total + remainQuantity, 0),
  };
}

/** One full reconciliation whose Pancake read began at `syncedAt`. */
function reconcile(tee: Record<string, number>, dress: Record<string, number>, syncedAt: Date) {
  return catalog.syncSnapshot({
    shopId: SHOP,
    variations: [variation(TEE, `${P}-tee`, tee), variation(DRESS, `${P}-dress`, dress)],
    syncedAt,
  });
}

async function stockOf(pancakeVariationId: string) {
  const rows = await prisma.warehouseStock.findMany({
    where: { variant: { pancakeVariationId } },
    orderBy: { pancakeWarehouseId: "asc" },
    select: { pancakeWarehouseId: true, quantity: true, syncedAt: true },
  });
  return rows;
}

/** Pancake as the batch sees it: a mutable per-variation stock table and a read log. */
function pancake(initial: Record<string, Record<string, number>>) {
  const state = structuredClone(initial);
  const reads: string[][] = [];
  let failNext = 0;
  return {
    state,
    reads,
    failNextReads: (count: number) => {
      failNext = count;
    },
    readVariations: async (variationIds: readonly string[]) => {
      reads.push([...variationIds]);
      if (failNext > 0) {
        failNext -= 1;
        throw new Error("pancake 502");
      }
      return new Map(
        variationIds.flatMap((id) =>
          state[id] === undefined
            ? []
            : [[id, Object.entries(state[id]!).map(([warehouseId, remainQuantity]) => ({ warehouseId, remainQuantity }))]],
        ),
      ) as Map<string, PancakeCatalogWarehouseStock[]>;
    },
  };
}

function clockFrom(start: Date) {
  let at = start.getTime();
  return () => new Date((at += 1_000));
}

function batch(source: ReturnType<typeof pancake>, clock: () => Date) {
  return processInventorySignals({
    shopId: SHOP,
    signals,
    readVariations: source.readVariations,
    applyVariationStocks: (input) => catalog.applyVariationStocks(input),
    clock,
  });
}

/** One `variations_warehouses` delivery in the OpenAPI `WebhookInventoryResponse` shape. */
function inventory(variationId: string, warehouseId: string, remainQuantity = 0) {
  return { data: { record: { variation_id: variationId, warehouse_id: warehouseId, remain_quantity: remainQuantity }, success: true } };
}

function deliver(body: unknown, at: Date) {
  return handlePancakeInventoryWebhook(
    new Request("http://127.0.0.1/api/pancake/inventory-webhook", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { [PANCAKE_WEBHOOK_SECRET_HEADER]: SECRET },
    }),
    { secret: SECRET, record: signals.record, now: () => at, log: () => undefined },
  );
}

test("webhooks only mark; duplicates and out-of-order deliveries collapse into one latest marker", async () => {
  await reconcile({ "wh-a": 5 }, { "wh-a": 2 }, T0);

  const later = new Date(T0.getTime() + 20_000);
  const earlier = new Date(T0.getTime() + 10_000);
  // The same change delivered three times, the last one out of order, with a stale quantity.
  for (const at of [later, later, earlier]) {
    assert.equal(
      (await deliver(inventory(TEE, "wh-a", 99), at)).status,
      200,
    );
  }

  const markers = await prisma.pancakeInventorySignal.findMany({ where: { pancakeVariationId: TEE } });
  assert.equal(markers.length, 1);
  assert.equal(markers[0]!.receivedCount, 3);
  assert.deepEqual(markers[0]!.lastReceivedAt, later, "an older delivery never moves the marker back");
  // Nothing was written from a delivery, least of all its quantity.
  assert.deepEqual((await stockOf(TEE)).map(({ quantity }) => quantity), [5]);
});

test("a batch applies Pancake's authoritative stock in one read and clears what it covered", async () => {
  await reconcile({ "wh-a": 5 }, { "wh-a": 2 }, T0);
  await deliver(inventory(TEE, "wh-a"), new Date(T0.getTime() + 5_000));
  await deliver(inventory(TEE, "wh-a"), new Date(T0.getTime() + 5_000));
  await deliver(inventory(`${P}-never-synced`, "wh-a"), new Date(T0.getTime() + 5_000));

  const source = pancake({ [TEE]: { "wh-a": 3, "wh-b": 1 }, [`${P}-never-synced`]: { "wh-a": 8 } });
  const result = await batch(source, clockFrom(new Date(T0.getTime() + 60_000)));

  assert.deepEqual(source.reads, [[TEE, `${P}-never-synced`]], "one read for every flagged variation");
  assert.equal(result.events, 3);
  assert.equal(result.deduplicated, 1);
  assert.equal(result.applied, 1);
  assert.equal(result.unknown, 1, "a variation the mirror has never seen is left to reconciliation");
  assert.deepEqual((await stockOf(TEE)).map(({ pancakeWarehouseId, quantity }) => [pancakeWarehouseId, quantity]), [
    ["wh-a", 3],
    ["wh-b", 1],
  ]);
  assert.equal(await prisma.pancakeInventorySignal.count({ where: { pancakeVariationId: { startsWith: P } } }), 0);
  // The untouched variation keeps its reconciled row.
  assert.deepEqual((await stockOf(DRESS)).map(({ quantity }) => quantity), [2]);
});

test("a redelivery that arrives while a batch is reading keeps its marker for the next batch", async () => {
  await reconcile({ "wh-a": 5 }, { "wh-a": 2 }, T0);
  await deliver(inventory(TEE, "wh-a"), new Date(T0.getTime() + 5_000));

  const source = pancake({ [TEE]: { "wh-a": 4 } });
  const original = source.readVariations;
  source.readVariations = async (variationIds) => {
    // Pancake changes again, and says so, after this batch's read began.
    await deliver(inventory(TEE, "wh-a"), new Date(T0.getTime() + 3_600_000));
    return original(variationIds);
  };
  await batch(source, clockFrom(new Date(T0.getTime() + 60_000)));
  assert.equal(await prisma.pancakeInventorySignal.count({ where: { pancakeVariationId: TEE } }), 1);
});

test("a failed Pancake read is retried next batch and recovers; a persistent failure is bounded", async () => {
  await reconcile({ "wh-a": 5 }, { "wh-a": 2 }, T0);
  await deliver(inventory(TEE, "wh-a"), new Date(T0.getTime() + 5_000));
  const source = pancake({ [TEE]: { "wh-a": 1 } });

  source.failNextReads(1);
  const failed = await batch(source, clockFrom(new Date(T0.getTime() + 60_000)));
  assert.equal(failed.failedReads, 1);
  assert.deepEqual((await stockOf(TEE)).map(({ quantity }) => quantity), [5], "no write from a failed read");
  assert.equal((await prisma.pancakeInventorySignal.findFirstOrThrow({ where: { pancakeVariationId: TEE } })).attempts, 1);

  const recovered = await batch(source, clockFrom(new Date(T0.getTime() + 90_000)));
  assert.equal(recovered.applied, 1);
  assert.deepEqual((await stockOf(TEE)).map(({ quantity }) => quantity), [1]);
  assert.equal(await prisma.pancakeInventorySignal.count({ where: { pancakeVariationId: TEE } }), 0);

  // A variation Pancake keeps failing on is dropped after the attempt bound; the hourly
  // reconciliation, not an ever-growing queue, is what fixes it.
  await deliver(inventory(TEE, "wh-a"), new Date(T0.getTime() + 120_000));
  source.failNextReads(10);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await batch(source, clockFrom(new Date(T0.getTime() + 150_000 + attempt * 30_000)));
  }
  assert.equal(await prisma.pancakeInventorySignal.count({ where: { pancakeVariationId: TEE } }), 0);
});

test("a delivery that arrives during a failing read survives the old claim's last attempt", async () => {
  await reconcile({ "wh-a": 5 }, { "wh-a": 2 }, T0);
  await deliver(inventory(TEE, "wh-a"), new Date(T0.getTime() + 5_000));
  await prisma.pancakeInventorySignal.updateMany({ where: { pancakeVariationId: TEE }, data: { attempts: 4 } });

  const source = pancake({ [TEE]: { "wh-a": 2 } });
  const original = source.readVariations;
  source.readVariations = async (variationIds) => {
    // Pancake changes again, and says so, while this batch's last-attempt read is failing.
    await deliver(inventory(TEE, "wh-a"), new Date(T0.getTime() + 61_500));
    source.readVariations = original;
    source.failNextReads(1);
    return original(variationIds);
  };
  const failed = await batch(source, clockFrom(new Date(T0.getTime() + 60_000)));
  assert.equal(failed.failedReads, 1);
  assert.equal(failed.dropped, 0, "the claimed marker changed, so the old claim drops nothing");

  const marker = await prisma.pancakeInventorySignal.findFirstOrThrow({ where: { pancakeVariationId: TEE } });
  assert.equal(marker.attempts, 0, "the new delivery neither inherits nor is charged the old failures");
  assert.deepEqual(marker.lastReceivedAt, new Date(T0.getTime() + 61_500));

  const next = await batch(source, clockFrom(new Date(T0.getTime() + 90_000)));
  assert.equal(next.applied, 1);
  assert.deepEqual((await stockOf(TEE)).map(({ quantity }) => quantity), [2]);
  assert.equal(await prisma.pancakeInventorySignal.count({ where: { pancakeVariationId: TEE } }), 0);
});

test("reads never overwrite a newer read, in either order (ADR 0014 §4.1)", async () => {
  await reconcile({ "wh-a": 5 }, { "wh-a": 2 }, T0);

  // A targeted read that began at T0+30s commits first.
  const targetedStart = new Date(T0.getTime() + 30_000);
  const applied = await catalog.applyVariationStocks({
    shopId: SHOP,
    observations: [{ variationId: TEE, warehouseStocks: [{ warehouseId: "wh-a", remainQuantity: 4 }] }],
    syncedAt: targetedStart,
  });
  assert.equal(applied.applied, 1);

  // An hourly reconciliation whose read began earlier (T0+10s) commits afterwards: its tee numbers
  // predate the targeted read and must not come back; its dress numbers are still news.
  await reconcile({ "wh-a": 5 }, { "wh-a": 7 }, new Date(T0.getTime() + 10_000));
  assert.deepEqual((await stockOf(TEE)).map(({ quantity, syncedAt }) => [quantity, syncedAt]), [[4, targetedStart]]);
  assert.deepEqual((await stockOf(DRESS)).map(({ quantity }) => quantity), [7]);

  // And a targeted read older than the stored one is superseded, not applied.
  const stale = await catalog.applyVariationStocks({
    shopId: SHOP,
    observations: [{ variationId: TEE, warehouseStocks: [{ warehouseId: "wh-a", remainQuantity: 9 }] }],
    syncedAt: new Date(T0.getTime() + 20_000),
  });
  assert.deepEqual(stale, { applied: 0, unknown: 0, superseded: 1, capacityHandedOff: 0 });
  assert.deepEqual((await stockOf(TEE)).map(({ quantity }) => quantity), [4]);
});

test("a newer read that observed no warehouse keeps winning over an older positive read", async () => {
  await reconcile({ "wh-a": 5 }, { "wh-a": 2 }, T0);

  // A targeted read that began at T0+30s sees the tee in no warehouse at all, and commits first.
  const emptyStart = new Date(T0.getTime() + 30_000);
  const emptied = await catalog.applyVariationStocks({
    shopId: SHOP,
    observations: [{ variationId: TEE, warehouseStocks: [] }],
    syncedAt: emptyStart,
  });
  assert.equal(emptied.applied, 1);
  assert.deepEqual(await stockOf(TEE), [], "no row is left to carry the newer read's start");

  // An hourly reconciliation whose read began earlier (T0+10s) commits afterwards with 5 units.
  await reconcile({ "wh-a": 5 }, { "wh-a": 2 }, new Date(T0.getTime() + 10_000));
  assert.deepEqual(await stockOf(TEE), [], "sold-out stock is not resurrected by the older read");

  // The same holds for an older targeted read.
  const stale = await catalog.applyVariationStocks({
    shopId: SHOP,
    observations: [{ variationId: TEE, warehouseStocks: [{ warehouseId: "wh-a", remainQuantity: 9 }] }],
    syncedAt: new Date(T0.getTime() + 20_000),
  });
  assert.equal(stale.superseded, 1);
  assert.deepEqual(await stockOf(TEE), []);

  // A read that began later still applies.
  await reconcile({ "wh-a": 3 }, { "wh-a": 2 }, new Date(T0.getTime() + 40_000));
  assert.deepEqual((await stockOf(TEE)).map(({ quantity }) => quantity), [3]);
});

test("the targeted batch hands a COMMITTED hold to the mirror exactly like a full sync would", async () => {
  await reconcile({ "wh-a": 5 }, { "wh-a": 2 }, T0);
  const variant = await prisma.variantMirror.findUniqueOrThrow({ where: { pancakeVariationId: TEE }, select: { id: true } });
  const order = await prisma.orderMirror.create({ data: { publicCode: `${P}-order` }, select: { id: true } });
  const held = await reservations.reserveOrderCapacity({ orderId: order.id, lines: [{ variantId: variant.id, quantity: 2 }] });
  const reservationId = held.ok ? held.reservations[0]!.id : "";
  const committedAt = new Date(T0.getTime() + 60_000);
  await reservations.transitionReservation({ id: reservationId, from: "RESERVED", to: "SUBMITTING" });
  await reservations.transitionReservation({ id: reservationId, from: "SUBMITTING", to: "COMMITTED", at: committedAt });

  // Pancake decrements (5 -> 3) and fires the webhook; the batch reads after the commit.
  await deliver(inventory(TEE, "wh-a"), new Date(committedAt.getTime() + 1_000));
  const source = pancake({ [TEE]: { "wh-a": 3 } });
  const result = await batch(source, clockFrom(new Date(committedAt.getTime() + 30_000)));

  assert.equal(result.capacityHandedOff, 1);
  assert.equal((await readAdvisoryHeldQuantities(prisma, [variant.id])).get(variant.id), 0);
  assert.deepEqual((await stockOf(TEE)).map(({ quantity }) => quantity), [3], "not double-subtracted");
});

test("a lost webhook is converged by the next hourly reconciliation", async () => {
  await reconcile({ "wh-a": 5 }, { "wh-a": 2 }, T0);
  // Pancake changed the dress to 0, but the webhook never arrived (or the app was down).
  const idle = await batch(pancake({}), clockFrom(new Date(T0.getTime() + 60_000)));
  assert.equal(idle.signals, 0);
  assert.deepEqual((await stockOf(DRESS)).map(({ quantity }) => quantity), [2]);

  await reconcile({ "wh-a": 5 }, { "wh-a": 0 }, new Date(T0.getTime() + 3_600_000));
  assert.deepEqual((await stockOf(DRESS)).map(({ quantity }) => quantity), [0]);
});
