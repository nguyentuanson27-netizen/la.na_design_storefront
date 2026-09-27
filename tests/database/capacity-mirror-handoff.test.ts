/**
 * The durable mirror handoff (ADR 0014 §4.1) through the real catalog sync.
 *
 * What these pin: a `COMMITTED` resource leaves the local ledger exactly once, at the first catalog
 * sync whose stock observation began strictly after the commit, with that observation recorded as
 * its evidence; nothing else moves it, and the checkout authority, the advisory read model and the
 * migration backfill all agree with what the sync recorded.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { readAdvisoryHeldQuantities } from "../../src/commerce/capacity-advisory.ts";
import { createCapacityReservationRepository } from "../../src/commerce/capacity-reservation.ts";
import { createCatalogMirrorRepository } from "../../src/commerce/catalog-mirror-repository.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";
import type { PancakeParsedCatalogVariation } from "../../src/integrations/pancake/catalog-contract.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const HANDED_OFF_AT = new Date("2026-09-27T12:00:00.000Z");
const catalog = createCatalogMirrorRepository(prisma, { clock: () => HANDED_OFF_AT });
const reservations = createCapacityReservationRepository(prisma);

const SHOP = 920_418;
const P = "mirror-handoff";
const T0 = new Date("2026-09-27T08:00:00.000Z");
const COMMITTED_AT = new Date("2026-09-27T09:00:00.000Z");

async function cleanup() {
  await prisma.variantCapacityReservation.deleteMany({
    where: { variant: { product: { pancakeShopId: SHOP } } },
  });
  await prisma.orderMirror.deleteMany({ where: { publicCode: { startsWith: P } } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP } });
  await prisma.catalogSyncState.deleteMany({ where: { pancakeShopId: SHOP } });
}

test.beforeEach(cleanup);
test.afterEach(cleanup);
test.after(async () => prisma.$disconnect());

function tee(stock: number): PancakeParsedCatalogVariation {
  return {
    id: `${P}-tee-m`,
    productId: `${P}-tee`,
    displayId: `${P}-tee-m`,
    barcode: `${P}-tee-m`,
    fields: [{ id: `${P}-size`, keyValue: "size", name: "Size", value: "M" }],
    imageUrls: [],
    isHidden: false,
    isLocked: false,
    retailPrice: 500_000,
    retailPriceAfterDiscount: 500_000,
    product: { id: `${P}-tee`, name: "Tee", sourceDescription: null, primaryImageUrl: null },
    warehouseStocks: [{ warehouseId: `${P}-wh`, remainQuantity: stock }],
    sellableStock: stock,
  };
}

/** One catalog sync whose Pancake read began at `syncedAt` and observed `stock`. */
function sync(stock: number, syncedAt: Date) {
  return catalog.syncSnapshot({ shopId: SHOP, variations: [tee(stock)], syncedAt });
}

async function teeVariantId() {
  const variant = await prisma.variantMirror.findUniqueOrThrow({
    where: { pancakeVariationId: `${P}-tee-m` },
    select: { id: true },
  });
  return variant.id;
}

async function order(key: string) {
  const created = await prisma.orderMirror.create({ data: { publicCode: `${P}-${key}` }, select: { id: true } });
  return created.id;
}

async function commit(key: string, variantId: string, quantity: number, at = COMMITTED_AT) {
  const outcome = await reservations.reserveOrderCapacity({
    orderId: await order(key),
    lines: [{ variantId, quantity }],
  });
  assert.equal(outcome.ok, true, `fixture ${key} must reserve`);
  const id = outcome.ok ? outcome.reservations[0]!.id : "";
  assert.equal(await reservations.transitionReservation({ id, from: "RESERVED", to: "SUBMITTING" }), true);
  assert.equal(await reservations.transitionReservation({ id, from: "SUBMITTING", to: "COMMITTED", at }), true);
  return id;
}

async function resourceOf(reservationId: string) {
  return prisma.capacityReservationResource.findFirstOrThrow({
    where: { reservationId },
    select: { mirroredAt: true, mirrorObservationStartedAt: true, quantity: true },
  });
}

test("a COMMITTED hold is handed to the mirror once, by the first sync that began after the commit", async () => {
  await sync(3, T0);
  const variantId = await teeVariantId();
  const reservationId = await commit("buyer-a", variantId, 2);

  // A sync that began before the commit may have read Pancake before the order landed: no handoff.
  const early = await sync(3, new Date(COMMITTED_AT.getTime() - 60_000));
  assert.equal(early.capacityHandedOff, 0);
  assert.deepEqual(await resourceOf(reservationId), {
    mirroredAt: null,
    mirrorObservationStartedAt: null,
    quantity: 2,
  });
  assert.equal((await readAdvisoryHeldQuantities(prisma, [variantId])).get(variantId), 2);

  // A read that began exactly at the commit proves nothing either (ties keep holding).
  assert.equal((await sync(3, COMMITTED_AT)).capacityHandedOff, 0);

  // The first sync that began after the commit observed Pancake's decrement (3 -> 1). The hold is
  // handed off in that same transaction, and the observation is kept as its evidence.
  const observedFrom = new Date(COMMITTED_AT.getTime() + 60_000);
  const late = await sync(1, observedFrom);
  assert.equal(late.capacityHandedOff, 1);
  assert.deepEqual(await resourceOf(reservationId), {
    mirroredAt: HANDED_OFF_AT,
    mirrorObservationStartedAt: observedFrom,
    quantity: 2,
  });
  assert.equal((await readAdvisoryHeldQuantities(prisma, [variantId])).get(variantId), 0);

  // The checkout authority reads the same fact: the one mirrored unit is sellable exactly once, so
  // the two units were neither double-subtracted nor released early.
  const next = await reservations.reserveOrderCapacity({
    orderId: await order("buyer-b"),
    lines: [{ variantId, quantity: 1 }],
  });
  assert.equal(next.ok, true);
  const oversell = await reservations.reserveOrderCapacity({
    orderId: await order("buyer-c"),
    lines: [{ variantId, quantity: 1 }],
  });
  assert.equal(oversell.ok, false);

  // Idempotent: a later sync neither hands it off again nor rewrites the recorded evidence.
  const again = await sync(1, new Date(COMMITTED_AT.getTime() + 120_000));
  assert.equal(again.capacityHandedOff, 0);
  assert.deepEqual(await resourceOf(reservationId), {
    mirroredAt: HANDED_OFF_AT,
    mirrorObservationStartedAt: observedFrom,
    quantity: 2,
  });
});

test("a sync never hands off a hold whose Pancake outcome is not a confirmed commit", async () => {
  await sync(10, T0);
  const variantId = await teeVariantId();

  const unknown = await reservations.reserveOrderCapacity({
    orderId: await order("unknown"),
    lines: [{ variantId, quantity: 1 }],
  });
  const unknownId = unknown.ok ? unknown.reservations[0]!.id : "";
  await reservations.transitionReservation({ id: unknownId, from: "RESERVED", to: "SUBMITTING" });
  await reservations.transitionReservation({ id: unknownId, from: "SUBMITTING", to: "UNKNOWN" });

  const reserved = await reservations.reserveOrderCapacity({
    orderId: await order("reserved"),
    lines: [{ variantId, quantity: 2 }],
  });
  const reservedId = reserved.ok ? reserved.reservations[0]!.id : "";

  const released = await reservations.reserveOrderCapacity({
    orderId: await order("released"),
    lines: [{ variantId, quantity: 4 }],
  });
  const releasedId = released.ok ? released.reservations[0]!.id : "";
  await reservations.transitionReservation({ id: releasedId, from: "RESERVED", to: "RELEASED" });

  const later = await sync(10, new Date(COMMITTED_AT.getTime() + 3_600_000));
  assert.equal(later.capacityHandedOff, 0);
  for (const id of [unknownId, reservedId, releasedId]) {
    assert.equal((await resourceOf(id)).mirroredAt, null, "only a COMMITTED hold is ever handed off");
  }
  // UNKNOWN and RESERVED keep holding however late the observation; RELEASED never held.
  assert.equal((await readAdvisoryHeldQuantities(prisma, [variantId])).get(variantId), 3);
});

test("the migration backfill hands off exactly what the per-read rule had already retired", async () => {
  await sync(5, T0);
  const variantId = await teeVariantId();
  const retired = await commit("retired", variantId, 1, new Date(T0.getTime() - 60_000));
  const stillHeld = await commit("still-held", variantId, 1, COMMITTED_AT);
  // Simulate rows written before this migration: no handoff recorded yet.
  await prisma.capacityReservationResource.updateMany({
    where: { reservationId: { in: [retired, stillHeld] } },
    data: { mirroredAt: null, mirrorObservationStartedAt: null },
  });

  const migration = await readFile(
    new URL(
      "../../prisma/migrations/20260927120000_add_capacity_resource_mirror_handoff/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const backfill = migration.slice(migration.indexOf('UPDATE "CapacityReservationResource"'));
  await prisma.$executeRawUnsafe(backfill);

  const handedOff = await resourceOf(retired);
  assert.notEqual(handedOff.mirroredAt, null);
  assert.deepEqual(handedOff.mirrorObservationStartedAt, T0);
  assert.equal((await resourceOf(stillHeld)).mirroredAt, null);
  assert.equal((await readAdvisoryHeldQuantities(prisma, [variantId])).get(variantId), 1);
});

test("the database refuses a half-recorded or backdated handoff", async () => {
  await sync(5, T0);
  const variantId = await teeVariantId();
  const reservationId = await commit("constraint", variantId, 1);

  await assert.rejects(
    prisma.capacityReservationResource.updateMany({
      where: { reservationId },
      data: { mirroredAt: HANDED_OFF_AT },
    }),
    "mirroredAt without its evidence",
  );
  await assert.rejects(
    prisma.capacityReservationResource.updateMany({
      where: { reservationId },
      data: { mirroredAt: T0, mirrorObservationStartedAt: HANDED_OFF_AT },
    }),
    "evidence that postdates the handoff",
  );
});
