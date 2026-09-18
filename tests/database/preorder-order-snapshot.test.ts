import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createCapacityReservationRepository } from "../../src/commerce/capacity-reservation.ts";
import { createPreorderSnapshotAtConfirmation } from "../../src/commerce/preorder-order-snapshot-repository.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const shopId = 920_107;
const prefix = "i7-snapshot";

type SellingMode = "STANDARD" | "OVERSELL" | "PREORDER";

async function seedVariant({
  label,
  stock,
  sellingMode,
}: {
  label: string;
  stock: number;
  sellingMode?: SellingMode;
}) {
  const suffix = `${label}-${randomUUID()}`;
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: shopId,
      pancakeProductId: `${prefix}-product-${suffix}`,
      slug: `${prefix}-${suffix}`,
      name: `I7 ${label}`,
      isPresent: true,
      isActive: true,
      syncedAt: new Date("2026-09-18T00:00:00.000Z"),
      ...(sellingMode
        ? {
            sellingPolicy: {
              create: {
                sellingMode,
                negativeStockLimit: -20,
              },
            },
          }
        : {}),
      variants: {
        create: {
          pancakeVariationId: `${prefix}-variation-${suffix}`,
          size: "M",
          isPresent: true,
          isActive: true,
          syncedAt: new Date("2026-09-18T00:00:00.000Z"),
          warehouseStocks: {
            create: {
              pancakeWarehouseId: `${prefix}-warehouse-${suffix}`,
              quantity: stock,
              syncedAt: new Date("2026-09-18T00:00:00.000Z"),
            },
          },
        },
      },
    },
    include: { variants: true },
  });
  return { product, variant: product.variants[0]! };
}

async function seedOrder(
  label: string,
  lines: readonly { variantId: string; pancakeVariationId: string; quantity: number }[],
) {
  const suffix = randomUUID();
  return prisma.orderMirror.create({
    data: {
      publicCode: `${prefix}-${label}-${suffix}`,
      state: "DRAFT",
      lines: {
        create: lines.map((line, index) => ({
          variantId: line.variantId,
          pancakeVariationId: line.pancakeVariationId,
          productName: `I7 line ${index + 1}`,
          size: "M",
          quantity: line.quantity,
          unitPriceVnd: BigInt(100_000),
          lineTotalVnd: BigInt(100_000 * line.quantity),
        })),
      },
    },
  });
}

async function confirmWithI7(orderId: string, confirmedAt: Date) {
  return prisma.$transaction(async (tx) => {
    await tx.orderMirror.update({
      where: { id: orderId },
      data: { state: "CONFIRMED", pancakeOrderId: `i7-${randomUUID()}` },
    });
    await createPreorderSnapshotAtConfirmation(tx, orderId, confirmedAt);
  });
}

test.after(async () => {
  await prisma.$disconnect();
});

test("I7 snapshots the capacity-accepted PREORDER fact even if stock and policy change before confirmation", async () => {
  const { product, variant } = await seedVariant({
    label: "race",
    stock: 0,
    sellingMode: "PREORDER",
  });
  const order = await seedOrder("race", [
    { variantId: variant.id, pancakeVariationId: variant.pancakeVariationId, quantity: 1 },
  ]);

  const capacity = createCapacityReservationRepository(prisma);
  const reserved = await capacity.reserveOrderCapacity({
    orderId: order.id,
    lines: [{ variantId: variant.id, quantity: 1 }],
  });
  assert.equal(reserved.ok, true);

  const accepted = await prisma.variantCapacityReservation.findFirstOrThrow({
    where: { orderId: order.id, variantId: variant.id },
    select: { acceptedPreorderState: true },
  });
  assert.equal(accepted.acceptedPreorderState, "PREORDER");
  assert.equal(
    await prisma.orderPreorderSnapshot.count({ where: { orderId: order.id } }),
    0,
    "reservation alone must not start the 15-day preparation clock",
  );

  // This is the review race: mutable catalog facts change while the remote Pancake write is in
  // flight. Confirmation must copy the already-accepted capacity fact, never re-derive from these.
  await prisma.$transaction([
    prisma.warehouseStock.updateMany({
      where: { variantId: variant.id },
      data: { quantity: 10 },
    }),
    prisma.productSellingPolicy.update({
      where: { productId: product.id },
      data: { sellingMode: "STANDARD" },
    }),
  ]);

  const confirmedAt = new Date("2026-09-18T04:30:00.000Z");
  await confirmWithI7(order.id, confirmedAt);

  const snapshot = await prisma.orderPreorderSnapshot.findUniqueOrThrow({
    where: { orderId: order.id },
    include: { lines: true },
  });
  assert.equal(snapshot.confirmedAt.toISOString(), confirmedAt.toISOString());
  assert.equal(snapshot.preorderReadyAt?.toISOString(), "2026-10-03T04:30:00.000Z");
  assert.equal(snapshot.lines[0]?.state, "PREORDER");

  // Later mutable changes still cannot rewrite history.
  await prisma.warehouseStock.updateMany({
    where: { variantId: variant.id },
    data: { quantity: 50 },
  });
  const after = await prisma.orderPreorderSnapshot.findUniqueOrThrow({
    where: { orderId: order.id },
    include: { lines: true },
  });
  assert.equal(after.lines[0]?.state, "PREORDER");
  assert.equal(after.preorderReadyAt?.toISOString(), "2026-10-03T04:30:00.000Z");
});

test("I7 creates one idempotent mixed snapshot from accepted reservation metadata", async () => {
  const ready = await seedVariant({ label: "mixed-ready", stock: 5 });
  const preorder = await seedVariant({
    label: "mixed-preorder",
    stock: 0,
    sellingMode: "PREORDER",
  });
  const order = await seedOrder("mixed", [
    {
      variantId: ready.variant.id,
      pancakeVariationId: ready.variant.pancakeVariationId,
      quantity: 1,
    },
    {
      variantId: preorder.variant.id,
      pancakeVariationId: preorder.variant.pancakeVariationId,
      quantity: 2,
    },
  ]);

  const capacity = createCapacityReservationRepository(prisma);
  const reserved = await capacity.reserveOrderCapacity({
    orderId: order.id,
    lines: [
      { variantId: ready.variant.id, quantity: 1 },
      { variantId: preorder.variant.id, quantity: 2 },
    ],
  });
  assert.equal(reserved.ok, true);

  const accepted = await prisma.variantCapacityReservation.findMany({
    where: { orderId: order.id },
    orderBy: { variantId: "asc" },
    select: { variantId: true, acceptedPreorderState: true },
  });
  assert.deepEqual(
    new Map(accepted.map((row) => [row.variantId, row.acceptedPreorderState])),
    new Map([
      [ready.variant.id, "READY"],
      [preorder.variant.id, "PREORDER"],
    ]),
  );

  const confirmedAt = new Date("2026-12-25T03:00:00.000Z");
  await confirmWithI7(order.id, confirmedAt);
  await prisma.$transaction((tx) =>
    createPreorderSnapshotAtConfirmation(
      tx,
      order.id,
      new Date("2027-01-01T03:00:00.000Z"),
    ),
  );

  assert.equal(await prisma.orderPreorderSnapshot.count({ where: { orderId: order.id } }), 1);
  const snapshot = await prisma.orderPreorderSnapshot.findUniqueOrThrow({
    where: { orderId: order.id },
    include: { lines: { orderBy: { variantId: "asc" } } },
  });
  assert.equal(snapshot.confirmedAt.toISOString(), confirmedAt.toISOString());
  assert.equal(snapshot.preorderReadyAt?.toISOString(), "2027-01-09T03:00:00.000Z");
  assert.equal(snapshot.lines.find((line) => line.variantId === ready.variant.id)?.state, "READY");
  assert.equal(
    snapshot.lines.find((line) => line.variantId === preorder.variant.id)?.state,
    "PREORDER",
  );
});

test("I7 does not fabricate a snapshot when a legacy order has no accepted capacity authority", async () => {
  const { variant } = await seedVariant({ label: "legacy", stock: 5 });
  const order = await seedOrder("legacy", [
    { variantId: variant.id, pancakeVariationId: variant.pancakeVariationId, quantity: 1 },
  ]);

  await confirmWithI7(order.id, new Date("2026-09-18T05:00:00.000Z"));

  assert.equal(
    await prisma.orderPreorderSnapshot.count({ where: { orderId: order.id } }),
    0,
    "no reservation authority means no inferred/backfilled history",
  );
});

test("I7 database triggers reject update and delete of persisted snapshot history", async () => {
  const { variant } = await seedVariant({
    label: "immutable",
    stock: 0,
    sellingMode: "PREORDER",
  });
  const order = await seedOrder("immutable", [
    { variantId: variant.id, pancakeVariationId: variant.pancakeVariationId, quantity: 1 },
  ]);
  const capacity = createCapacityReservationRepository(prisma);
  const reserved = await capacity.reserveOrderCapacity({
    orderId: order.id,
    lines: [{ variantId: variant.id, quantity: 1 }],
  });
  assert.equal(reserved.ok, true);
  await confirmWithI7(order.id, new Date("2026-09-18T06:00:00.000Z"));

  const snapshot = await prisma.orderPreorderSnapshot.findUniqueOrThrow({
    where: { orderId: order.id },
    include: { lines: true },
  });

  await assert.rejects(
    prisma.orderPreorderSnapshot.update({
      where: { id: snapshot.id },
      data: { preorderReadyAt: null },
    }),
    /immutable/i,
  );
  await assert.rejects(
    prisma.orderPreorderLineSnapshot.delete({
      where: { id: snapshot.lines[0]!.id },
    }),
    /immutable/i,
  );
  await assert.rejects(
    prisma.orderPreorderSnapshot.delete({ where: { id: snapshot.id } }),
    /immutable/i,
  );
});
