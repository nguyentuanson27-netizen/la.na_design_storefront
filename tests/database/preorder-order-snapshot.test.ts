import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { FULFILLMENT } from "../../src/brand/index.ts";
import { createCapacityReservationRepository } from "../../src/commerce/capacity-reservation.ts";
import { createPancakeOrderReconciliationService } from "../../src/commerce/pancake-order-reconciliation.ts";
import { createPreorderSnapshotAtConfirmation } from "../../src/commerce/preorder-order-snapshot-repository.ts";
import { PrismaClient, type Prisma } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const shopId = 920_107;
const prefix = "i7-snapshot";
const rollback = new Error("I7_TEST_ROLLBACK");

type TransactionClient = Prisma.TransactionClient;
type SellingMode = "STANDARD" | "OVERSELL" | "PREORDER";

async function inRollbackTransaction(
  run: (tx: TransactionClient) => Promise<void>,
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await run(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

async function seedVariant(
  tx: TransactionClient,
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

async function seedOrder(
  tx: TransactionClient,
  label: string,
  lines: readonly { variantId: string; pancakeVariationId: string; quantity: number }[],
) {
  const suffix = randomUUID();
  return tx.orderMirror.create({
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

async function seedAcceptedReservation(
  tx: TransactionClient,
  {
    orderId,
    variantId,
    quantity,
    acceptedPreorderState,
  }: {
    orderId: string;
    variantId: string;
    quantity: number;
    acceptedPreorderState: "READY" | "PREORDER";
  },
) {
  return tx.variantCapacityReservation.create({
    data: {
      orderId,
      variantId,
      quantity,
      acceptedPreorderState,
    },
  });
}

async function confirmWithI7(
  tx: TransactionClient,
  orderId: string,
  confirmedAt: Date,
): Promise<void> {
  await tx.orderMirror.update({
    where: { id: orderId },
    data: { state: "CONFIRMED", pancakeOrderId: `i7-${randomUUID()}` },
  });
  await createPreorderSnapshotAtConfirmation(tx, orderId, confirmedAt);
}

test.after(async () => {
  await prisma.$disconnect();
});

test("I7 capacity acceptance persists PREORDER classification before confirmation", async () => {
  const suffix = randomUUID();
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: shopId,
      pancakeProductId: `${prefix}-writer-${suffix}`,
      slug: `${prefix}-writer-${suffix}`,
      name: "I7 writer",
      isPresent: true,
      isActive: true,
      syncedAt: new Date("2026-09-18T00:00:00.000Z"),
      sellingPolicy: {
        create: {
          sellingMode: "PREORDER",
          negativeStockLimit: -20,
        },
      },
      variants: {
        create: {
          pancakeVariationId: `${prefix}-writer-variation-${suffix}`,
          size: "M",
          isPresent: true,
          isActive: true,
          syncedAt: new Date("2026-09-18T00:00:00.000Z"),
          warehouseStocks: {
            create: {
              pancakeWarehouseId: `${prefix}-writer-warehouse-${suffix}`,
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
    data: {
      publicCode: `${prefix}-writer-order-${suffix}`,
      lines: {
        create: {
          variantId: variant.id,
          pancakeVariationId: variant.pancakeVariationId,
          productName: "I7 writer",
          size: "M",
          quantity: 1,
          unitPriceVnd: BigInt(100_000),
          lineTotalVnd: BigInt(100_000),
        },
      },
    },
  });

  try {
    const capacity = createCapacityReservationRepository(prisma);
    const reserved = await capacity.reserveOrderCapacity({
      orderId: order.id,
      lines: [{ variantId: variant.id, quantity: 1 }],
    });
    assert.equal(reserved.ok, true);

    const accepted = await prisma.variantCapacityReservation.findUniqueOrThrow({
      where: {
        orderId_variantId: {
          orderId: order.id,
          variantId: variant.id,
        },
      },
      select: { acceptedPreorderState: true },
    });
    assert.equal(accepted.acceptedPreorderState, "PREORDER");
    assert.equal(
      await prisma.orderPreorderSnapshot.count({ where: { orderId: order.id } }),
      0,
      "reservation acceptance must not start the 15-day preparation clock",
    );
  } finally {
    await prisma.variantCapacityReservation.deleteMany({ where: { orderId: order.id } });
    await prisma.orderMirror.delete({ where: { id: order.id } });
    await prisma.productMirror.delete({ where: { id: product.id } });
  }
});

test("I7 copies the accepted PREORDER fact even if stock and policy change before confirmation", async () => {
  await inRollbackTransaction(async (tx) => {
    const { product, variant } = await seedVariant(tx, {
      label: "race",
      stock: 0,
      sellingMode: "PREORDER",
    });
    const order = await seedOrder(tx, "race", [
      { variantId: variant.id, pancakeVariationId: variant.pancakeVariationId, quantity: 1 },
    ]);
    await seedAcceptedReservation(tx, {
      orderId: order.id,
      variantId: variant.id,
      quantity: 1,
      acceptedPreorderState: "PREORDER",
    });

    // The exact review race: mutable catalog truth changes while Pancake's create is in flight.
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
    assert.equal(snapshot.confirmedAt.toISOString(), confirmedAt.toISOString());
    assert.equal(snapshot.preorderReadyAt?.toISOString(), "2026-10-03T04:30:00.000Z");
    assert.equal(snapshot.lines[0]?.state, "PREORDER");

    await tx.warehouseStock.updateMany({
      where: { variantId: variant.id },
      data: { quantity: 50 },
    });
    const unchanged = await tx.orderPreorderSnapshot.findUniqueOrThrow({
      where: { orderId: order.id },
      include: { lines: true },
    });
    assert.equal(unchanged.lines[0]?.state, "PREORDER");
    assert.equal(unchanged.preorderReadyAt?.toISOString(), "2026-10-03T04:30:00.000Z");
  });
});

test("I8 reconciliation FOUND confirms, commits, and writes the I7 PREORDER snapshot atomically", async () => {
  await inRollbackTransaction(async (tx) => {
    const { variant } = await seedVariant(tx, {
      label: "reconciliation",
      stock: 0,
      sellingMode: "PREORDER",
    });
    const order = await seedOrder(tx, "reconciliation", [
      { variantId: variant.id, pancakeVariationId: variant.pancakeVariationId, quantity: 1 },
    ]);
    await tx.orderMirror.update({
      where: { id: order.id },
      data: {
        state: "SYNC_UNKNOWN",
        pancakeShopId: shopId,
        syncErrorCode: "CREATE_OUTCOME_UNKNOWN",
      },
    });
    const reservation = await seedAcceptedReservation(tx, {
      orderId: order.id,
      variantId: variant.id,
      quantity: 1,
      acceptedPreorderState: "PREORDER",
    });
    await tx.variantCapacityReservation.update({
      where: { id: reservation.id },
      data: { state: "UNKNOWN" },
    });

    const confirmedAt = new Date("2026-09-18T06:30:00.000Z");
    const reconciliationClient = {
      orderMirror: tx.orderMirror,
      variantCapacityReservation: tx.variantCapacityReservation,
      async $transaction<T>(run: (inner: TransactionClient) => Promise<T>): Promise<T> {
        return run(tx);
      },
    } as unknown as PrismaClient;

    const service = createPancakeOrderReconciliationService({
      client: reconciliationClient,
      gateway: {
        async searchOrderByMarker() {
          return { kind: "FOUND" as const, orderId: "880001" };
        },
      },
      clock: () => confirmedAt,
    });

    const result = await service.reconcileOrder(order.publicCode);
    assert.deepEqual(result, {
      ok: true,
      state: "CONFIRMED",
      pancakeOrderId: "880001",
      reservationsCommitted: 1,
    });

    const persistedOrder = await tx.orderMirror.findUniqueOrThrow({
      where: { id: order.id },
      select: { state: true, pancakeOrderId: true },
    });
    assert.equal(persistedOrder.state, "CONFIRMED");
    assert.equal(persistedOrder.pancakeOrderId, "880001");

    const committed = await tx.variantCapacityReservation.findUniqueOrThrow({
      where: { id: reservation.id },
      select: { state: true, committedAt: true },
    });
    assert.equal(committed.state, "COMMITTED");
    assert.equal(committed.committedAt?.toISOString(), confirmedAt.toISOString());

    const snapshot = await tx.orderPreorderSnapshot.findUniqueOrThrow({
      where: { orderId: order.id },
      include: { lines: true },
    });
    assert.equal(snapshot.confirmedAt.toISOString(), confirmedAt.toISOString());
    assert.equal(snapshot.preorderReadyAt?.toISOString(), "2026-10-03T06:30:00.000Z");
    assert.equal(snapshot.lines[0]?.state, "PREORDER");
  });
});

test("I7 creates one idempotent mixed snapshot from accepted reservation metadata", async () => {
  await inRollbackTransaction(async (tx) => {
    const ready = await seedVariant(tx, { label: "mixed-ready", stock: 5 });
    const preorder = await seedVariant(tx, {
      label: "mixed-preorder",
      stock: 0,
      sellingMode: "PREORDER",
    });
    const order = await seedOrder(tx, "mixed", [
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
    await seedAcceptedReservation(tx, {
      orderId: order.id,
      variantId: ready.variant.id,
      quantity: 1,
      acceptedPreorderState: "READY",
    });
    await seedAcceptedReservation(tx, {
      orderId: order.id,
      variantId: preorder.variant.id,
      quantity: 2,
      acceptedPreorderState: "PREORDER",
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

test("I7 confirmation fails closed when accepted reservation metadata disagrees with the order", async () => {
  const suffix = randomUUID();
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: shopId,
      pancakeProductId: `${prefix}-mismatch-${suffix}`,
      slug: `${prefix}-mismatch-${suffix}`,
      name: "I7 mismatch",
      isPresent: true,
      isActive: true,
      syncedAt: new Date("2026-09-18T00:00:00.000Z"),
      variants: {
        create: {
          pancakeVariationId: `${prefix}-mismatch-variation-${suffix}`,
          size: "M",
          isPresent: true,
          isActive: true,
          syncedAt: new Date("2026-09-18T00:00:00.000Z"),
          warehouseStocks: {
            create: {
              pancakeWarehouseId: `${prefix}-mismatch-warehouse-${suffix}`,
              quantity: 5,
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
    data: {
      publicCode: `${prefix}-mismatch-order-${suffix}`,
      state: "DRAFT",
      lines: {
        create: {
          variantId: variant.id,
          pancakeVariationId: variant.pancakeVariationId,
          productName: "I7 mismatch",
          size: "M",
          quantity: 2,
          unitPriceVnd: BigInt(100_000),
          lineTotalVnd: BigInt(200_000),
        },
      },
      capacityReservations: {
        create: {
          variantId: variant.id,
          quantity: 1,
          acceptedPreorderState: "READY",
        },
      },
    },
  });

  try {
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await tx.orderMirror.update({
          where: { id: order.id },
          data: { state: "CONFIRMED", pancakeOrderId: `i7-mismatch-${suffix}` },
        });
        await createPreorderSnapshotAtConfirmation(
          tx,
          order.id,
          new Date("2026-09-18T05:30:00.000Z"),
        );
      }),
      /accepted reservation does not match order line/i,
    );

    const rolledBack = await prisma.orderMirror.findUniqueOrThrow({
      where: { id: order.id },
      select: { state: true, pancakeOrderId: true },
    });
    assert.equal(rolledBack.state, "DRAFT");
    assert.equal(rolledBack.pancakeOrderId, null);
    assert.equal(await prisma.orderPreorderSnapshot.count({ where: { orderId: order.id } }), 0);
  } finally {
    await prisma.variantCapacityReservation.deleteMany({ where: { orderId: order.id } });
    await prisma.orderMirror.delete({ where: { id: order.id } });
    await prisma.productMirror.delete({ where: { id: product.id } });
  }
});

test("I7 does not fabricate a snapshot when accepted capacity authority is absent", async () => {
  await inRollbackTransaction(async (tx) => {
    const { variant } = await seedVariant(tx, { label: "legacy", stock: 5 });
    const order = await seedOrder(tx, "legacy", [
      { variantId: variant.id, pancakeVariationId: variant.pancakeVariationId, quantity: 1 },
    ]);

    await confirmWithI7(tx, order.id, new Date("2026-09-18T05:00:00.000Z"));

    assert.equal(
      await tx.orderPreorderSnapshot.count({ where: { orderId: order.id } }),
      0,
      "no accepted reservation authority means no inferred/backfilled history",
    );
  });
});

async function assertImmutableMutation(
  mutate: (tx: TransactionClient, snapshotId: string, lineId: string) => Promise<unknown>,
): Promise<void> {
  await inRollbackTransaction(async (tx) => {
    const { variant } = await seedVariant(tx, {
      label: "immutable",
      stock: 0,
      sellingMode: "PREORDER",
    });
    const order = await seedOrder(tx, "immutable", [
      { variantId: variant.id, pancakeVariationId: variant.pancakeVariationId, quantity: 1 },
    ]);
    await seedAcceptedReservation(tx, {
      orderId: order.id,
      variantId: variant.id,
      quantity: 1,
      acceptedPreorderState: "PREORDER",
    });
    await confirmWithI7(tx, order.id, new Date("2026-09-18T06:00:00.000Z"));

    const snapshot = await tx.orderPreorderSnapshot.findUniqueOrThrow({
      where: { orderId: order.id },
      include: { lines: true },
    });
    await assert.rejects(
      mutate(tx, snapshot.id, snapshot.lines[0]!.id),
      /immutable/i,
    );
  });
}

test("I7 database triggers reject snapshot UPDATE, line DELETE and snapshot DELETE", async () => {
  await assertImmutableMutation((tx, snapshotId) =>
    tx.orderPreorderSnapshot.update({
      where: { id: snapshotId },
      data: { preorderReadyAt: null },
    }),
  );
  await assertImmutableMutation((tx, _snapshotId, lineId) =>
    tx.orderPreorderLineSnapshot.delete({ where: { id: lineId } }),
  );
  await assertImmutableMutation((tx, snapshotId) =>
    tx.orderPreorderSnapshot.delete({ where: { id: snapshotId } }),
  );
});


test("F8c I7 snapshots the confirmation-time shipping window and live product facts cannot rewrite history", async () => {
  await inRollbackTransaction(async (tx) => {
    const { product, variant } = await seedVariant(tx, {
      label: "historical-mutation",
      stock: 0,
      sellingMode: "PREORDER",
    });
    const order = await seedOrder(tx, "historical-mutation", [
      { variantId: variant.id, pancakeVariationId: variant.pancakeVariationId, quantity: 1 },
    ]);
    await tx.orderMirror.update({
      where: { id: order.id },
      data: { provinceRef: "101" },
    });
    await seedAcceptedReservation(tx, {
      orderId: order.id,
      variantId: variant.id,
      quantity: 1,
      acceptedPreorderState: "PREORDER",
    });

    const confirmedAt = new Date("2026-09-18T04:30:00.000Z");
    await confirmWithI7(tx, order.id, confirmedAt);

    const selectHistory = () =>
      tx.orderPreorderSnapshot.findUniqueOrThrow({
        where: { orderId: order.id },
        select: {
          confirmedAt: true,
          preorderReadyAt: true,
          shippingInnerCityMinDays: true,
          shippingInnerCityMaxDays: true,
          shippingOtherProvinceMinDays: true,
          shippingOtherProvinceMaxDays: true,
          lines: {
            orderBy: [{ variantId: "asc" }],
            select: {
              variantId: true,
              quantity: true,
              state: true,
              preorderReadyAt: true,
            },
          },
        },
      });

    const before = await selectHistory();
    assert.equal(
      before.shippingInnerCityMinDays,
      FULFILLMENT.delivery.estimateDays.innerCity.minimum,
    );
    assert.equal(
      before.shippingInnerCityMaxDays,
      FULFILLMENT.delivery.estimateDays.innerCity.maximum,
    );
    assert.equal(
      before.shippingOtherProvinceMinDays,
      FULFILLMENT.delivery.estimateDays.otherProvince.minimum,
    );
    assert.equal(
      before.shippingOtherProvinceMaxDays,
      FULFILLMENT.delivery.estimateDays.otherProvince.maximum,
    );

    await tx.productSellingPolicy.update({
      where: { productId: product.id },
      data: { sellingMode: "STANDARD", negativeStockLimit: -5 },
    });
    await tx.warehouseStock.updateMany({
      where: { variantId: variant.id },
      data: { quantity: 15 },
    });
    await tx.variantAvailabilityCycle.upsert({
      where: { variantId: variant.id },
      create: {
        variantId: variant.id,
        cycleStartDate: new Date("2026-09-20T00:00:00.000Z"),
        availabilityDate: new Date("2026-10-20T00:00:00.000Z"),
        lastStockNonPositive: true,
        lastPreorder: true,
      },
      update: {
        availabilityDate: new Date("2026-11-20T00:00:00.000Z"),
        lastStockNonPositive: false,
        lastPreorder: false,
      },
    });
    await tx.productSellingPolicy.update({
      where: { productId: product.id },
      data: { sellingMode: "OVERSELL", negativeStockLimit: -12 },
    });
    await tx.warehouseStock.updateMany({
      where: { variantId: variant.id },
      data: { quantity: -7 },
    });
    await tx.productMirror.update({
      where: { id: product.id },
      data: { isPresent: false, isActive: false },
    });
    await tx.variantMirror.update({
      where: { id: variant.id },
      data: { isPresent: false, isActive: false },
    });

    const after = await selectHistory();
    assert.deepEqual(after, before);
    assert.equal(after.lines[0]?.state, "PREORDER");
  });
});
