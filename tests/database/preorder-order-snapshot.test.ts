import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createCapacityReservationRepository } from "../../src/commerce/capacity-reservation.ts";
import { createPreorderSnapshotAtConfirmation } from "../../src/commerce/preorder-order-snapshot-repository.ts";
import { Prisma, PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const shopId = 920_107;
const prefix = "i7-snapshot";
const ROLLBACK = Symbol("I7 test rollback");

type SellingMode = "STANDARD" | "OVERSELL" | "PREORDER";

async function seedVariantInTransaction(
  tx: Prisma.TransactionClient,
  {
    label,
    stock,
    sellingMode,
  }: {
    label: string;
    stock: number;
    sellingMode?: SellingMode;
  },
) {
  const suffix = `${label}-${randomUUID()}`;
  const product = await tx.productMirror.create({
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

async function seedOrderInTransaction(
  tx: Prisma.TransactionClient,
  label: string,
  lines: readonly { variantId: string; pancakeVariationId: string; quantity: number }[],
) {
  return tx.orderMirror.create({
    data: {
      publicCode: `${prefix}-${label}-${randomUUID()}`,
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

async function rollbackAfter(
  assertion: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await assertion(tx);
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
}

async function confirmWithI7(
  tx: Prisma.TransactionClient,
  orderId: string,
  confirmedAt: Date,
) {
  await tx.orderMirror.update({
    where: { id: orderId },
    data: { state: "CONFIRMED", pancakeOrderId: `i7-${randomUUID()}` },
  });
  await createPreorderSnapshotAtConfirmation(tx, orderId, confirmedAt);
}

async function seedAcceptedSnapshot(
  tx: Prisma.TransactionClient,
  label: string,
  acceptedPreorderState: "READY" | "PREORDER",
) {
  const { variant } = await seedVariantInTransaction(tx, {
    label,
    stock: acceptedPreorderState === "PREORDER" ? 0 : 5,
    sellingMode: acceptedPreorderState === "PREORDER" ? "PREORDER" : undefined,
  });
  const order = await seedOrderInTransaction(tx, label, [
    { variantId: variant.id, pancakeVariationId: variant.pancakeVariationId, quantity: 1 },
  ]);
  await tx.variantCapacityReservation.create({
    data: {
      orderId: order.id,
      variantId: variant.id,
      quantity: 1,
      acceptedPreorderState,
    },
  });
  await confirmWithI7(tx, order.id, new Date("2026-09-18T06:00:00.000Z"));
  return tx.orderPreorderSnapshot.findUniqueOrThrow({
    where: { orderId: order.id },
    include: { lines: true },
  });
}

test.after(async () => {
  await prisma.$disconnect();
});

test("I7 capacity acceptance persists PREORDER before confirmation starts the ETA clock", async () => {
  const suffix = randomUUID();
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: shopId,
      pancakeProductId: `${prefix}-capacity-${suffix}`,
      slug: `${prefix}-capacity-${suffix}`,
      name: "I7 capacity authority",
      syncedAt: new Date("2026-09-18T00:00:00.000Z"),
      sellingPolicy: {
        create: { sellingMode: "PREORDER", negativeStockLimit: -20 },
      },
      variants: {
        create: {
          pancakeVariationId: `${prefix}-capacity-variant-${suffix}`,
          size: "M",
          syncedAt: new Date("2026-09-18T00:00:00.000Z"),
          warehouseStocks: {
            create: {
              pancakeWarehouseId: `${prefix}-capacity-wh-${suffix}`,
              quantity: 0,
              syncedAt: new Date("2026-09-18T00:00:00.000Z"),
            },
          },
        },
      },
    },
    include: { variants: true },
  });
  const variant = product.variants[0]!;
  const order = await prisma.orderMirror.create({
    data: { publicCode: `${prefix}-capacity-order-${suffix}` },
  });

  try {
    const reserved = await createCapacityReservationRepository(prisma).reserveOrderCapacity({
      orderId: order.id,
      lines: [{ variantId: variant.id, quantity: 1 }],
    });
    assert.equal(reserved.ok, true);

    const accepted = await prisma.variantCapacityReservation.findUniqueOrThrow({
      where: { orderId_variantId: { orderId: order.id, variantId: variant.id } },
      select: { acceptedPreorderState: true },
    });
    assert.equal(accepted.acceptedPreorderState, "PREORDER");
    assert.equal(
      await prisma.orderPreorderSnapshot.count({ where: { orderId: order.id } }),
      0,
      "capacity acceptance alone must not start the 15-day confirmation clock",
    );
  } finally {
    await prisma.variantCapacityReservation.deleteMany({ where: { orderId: order.id } });
    await prisma.orderMirror.delete({ where: { id: order.id } });
    await prisma.productMirror.delete({ where: { id: product.id } });
  }
});

test("I7 confirmation copies accepted PREORDER even if mutable stock and policy changed meanwhile", async () => {
  await rollbackAfter(async (tx) => {
    const { product, variant } = await seedVariantInTransaction(tx, {
      label: "race",
      stock: 0,
      sellingMode: "PREORDER",
    });
    const order = await seedOrderInTransaction(tx, "race", [
      { variantId: variant.id, pancakeVariationId: variant.pancakeVariationId, quantity: 1 },
    ]);
    await tx.variantCapacityReservation.create({
      data: {
        orderId: order.id,
        variantId: variant.id,
        quantity: 1,
        acceptedPreorderState: "PREORDER",
      },
    });

    // The review race: mutable facts change while Pancake's create is in flight.
    await tx.warehouseStock.updateMany({
      where: { variantId: variant.id },
      data: { quantity: 10 },
    });
    await tx.productSellingPolicy.update({
      where: { productId: product.id },
      data: { sellingMode: "STANDARD" },
    });

    const confirmedAt = new Date("2026-09-18T04:30:00.000Z");
    await confirmWithI7(tx, order.id, confirmedAt);

    const snapshot = await tx.orderPreorderSnapshot.findUniqueOrThrow({
      where: { orderId: order.id },
      include: { lines: true },
    });
    assert.equal(snapshot.preorderReadyAt?.toISOString(), "2026-10-03T04:30:00.000Z");
    assert.equal(snapshot.lines[0]?.state, "PREORDER");

    await tx.warehouseStock.updateMany({
      where: { variantId: variant.id },
      data: { quantity: 50 },
    });
    const after = await tx.orderPreorderSnapshot.findUniqueOrThrow({
      where: { orderId: order.id },
      include: { lines: true },
    });
    assert.equal(after.lines[0]?.state, "PREORDER");
    assert.equal(after.preorderReadyAt?.toISOString(), "2026-10-03T04:30:00.000Z");
  });
});

test("I7 creates one idempotent mixed snapshot from accepted reservation metadata", async () => {
  await rollbackAfter(async (tx) => {
    const ready = await seedVariantInTransaction(tx, { label: "mixed-ready", stock: 5 });
    const preorder = await seedVariantInTransaction(tx, {
      label: "mixed-preorder",
      stock: 0,
      sellingMode: "PREORDER",
    });
    const order = await seedOrderInTransaction(tx, "mixed", [
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
    await tx.variantCapacityReservation.createMany({
      data: [
        {
          orderId: order.id,
          variantId: ready.variant.id,
          quantity: 1,
          acceptedPreorderState: "READY",
        },
        {
          orderId: order.id,
          variantId: preorder.variant.id,
          quantity: 2,
          acceptedPreorderState: "PREORDER",
        },
      ],
    });

    const confirmedAt = new Date("2026-12-25T03:00:00.000Z");
    await confirmWithI7(tx, order.id, confirmedAt);
    await createPreorderSnapshotAtConfirmation(
      tx,
      order.id,
      new Date("2027-01-01T03:00:00.000Z"),
    );

    assert.equal(await tx.orderPreorderSnapshot.count({ where: { orderId: order.id } }), 1);
    const snapshot = await tx.orderPreorderSnapshot.findUniqueOrThrow({
      where: { orderId: order.id },
      include: { lines: true },
    });
    assert.equal(snapshot.confirmedAt.toISOString(), confirmedAt.toISOString());
    assert.equal(snapshot.preorderReadyAt?.toISOString(), "2027-01-09T03:00:00.000Z");
    assert.equal(
      snapshot.lines.find((line) => line.variantId === ready.variant.id)?.state,
      "READY",
    );
    assert.equal(
      snapshot.lines.find((line) => line.variantId === preorder.variant.id)?.state,
      "PREORDER",
    );
  });
});

test("I7 leaves legacy confirmation without a snapshot when accepted authority is absent", async () => {
  await rollbackAfter(async (tx) => {
    const { variant } = await seedVariantInTransaction(tx, { label: "legacy", stock: 5 });
    const order = await seedOrderInTransaction(tx, "legacy", [
      { variantId: variant.id, pancakeVariationId: variant.pancakeVariationId, quantity: 1 },
    ]);

    await confirmWithI7(tx, order.id, new Date("2026-09-18T05:00:00.000Z"));

    assert.equal(
      await tx.orderPreorderSnapshot.count({ where: { orderId: order.id } }),
      0,
      "no accepted reservation metadata means no inferred/backfilled history",
    );
  });
});

async function assertImmutableMutation(
  mutation: (tx: Prisma.TransactionClient, snapshot: Awaited<ReturnType<typeof seedAcceptedSnapshot>>) => Promise<unknown>,
) {
  await assert.rejects(
    prisma.$transaction(async (tx) => {
      const snapshot = await seedAcceptedSnapshot(tx, `immutable-${randomUUID()}`, "PREORDER");
      await mutation(tx, snapshot);
    }),
    /immutable/i,
  );
}

test("I7 database triggers reject UPDATE and DELETE of persisted snapshot history", async () => {
  await assertImmutableMutation((tx, snapshot) =>
    tx.orderPreorderSnapshot.update({
      where: { id: snapshot.id },
      data: { preorderReadyAt: null },
    }),
  );
  await assertImmutableMutation((tx, snapshot) =>
    tx.orderPreorderLineSnapshot.delete({
      where: { id: snapshot.lines[0]!.id },
    }),
  );
});
