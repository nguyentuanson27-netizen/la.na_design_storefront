import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createPancakeOrderSubmissionService } from "../../src/commerce/pancake-order-submit.ts";
import { createPreorderSnapshotAtConfirmation } from "../../src/commerce/preorder-order-snapshot-repository.ts";
import { Prisma, PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const shopId = 920_007;
const prefix = "i7-preorder-snapshot";

const confirmedAt = new Date("2026-01-25T10:15:00.000Z");

async function withRollback<T>(
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const rollback = Symbol("I7_TEST_ROLLBACK");
  try {
    return await prisma.$transaction(async (tx) => {
      const result = await callback(tx);
      throw rollback;
    });
  } catch (error) {
    if (error === rollback) {
      return undefined as T;
    }
    throw error;
  }
}

async function seedProduct(
  tx: Prisma.TransactionClient,
  label: string,
  sellingMode: "STANDARD" | "PREORDER",
  stock: number,
) {
  return tx.productMirror.create({
    data: {
      pancakeShopId: shopId,
      pancakeProductId: `${prefix}-product-${label}`,
      slug: `${prefix}-${label}`,
      name: `I7 ${label}`,
      isPresent: true,
      isActive: true,
      syncedAt: confirmedAt,
      sellingPolicy: { create: { sellingMode, negativeStockLimit: -20 } },
      variants: {
        create: {
          pancakeVariationId: `${prefix}-variation-${label}`,
          color: "Black",
          size: "M",
          isPresent: true,
          isActive: true,
          syncedAt: confirmedAt,
          pancakeRetailPrice: 500_000,
          pancakeRetailPriceAfterDiscount: 500_000,
          warehouseStocks: {
            create: {
              pancakeWarehouseId: `${prefix}-warehouse-${label}`,
              quantity: stock,
              syncedAt: confirmedAt,
            },
          },
        },
      },
    },
    include: { variants: true },
  });
}

function orderLine(variantId: string, suffix: string, quantity = 1) {
  return {
    variantId,
    pancakeVariationId: `${prefix}-variation-${suffix}`,
    productName: `I7 ${suffix}`,
    color: "Black",
    size: "M",
    quantity,
    unitPriceVnd: BigInt(500_000),
    lineTotalVnd: BigInt(500_000 * quantity),
  };
}

test.after(async () => {
  await prisma.$disconnect();
});

test("I7 persists mixed ready + preorder state, 15-day ETA, and idempotent snapshot creation", async () => {
  await withRollback(async (tx) => {
    const ready = await seedProduct(tx, "ready", "STANDARD", 10);
    const preorderA = await seedProduct(tx, "preorder-a", "PREORDER", 0);
    const preorderB = await seedProduct(tx, "preorder-b", "PREORDER", 0);

    const order = await tx.orderMirror.create({
      data: {
        publicCode: `${prefix}-mixed`,
        pancakeShopId: shopId,
        state: "CONFIRMED",
        checkoutSnapshottedAt: confirmedAt,
        guestName: "Nguyễn Văn A",
        guestPhone: "0901234567",
        merchandiseSubtotalVnd: BigInt(1_500_000),
        shippingFeeVnd: BigInt(30_000),
        totalVnd: BigInt(1_530_000),
        lines: {
          create: [
            orderLine(ready.variants[0]!.id, "ready"),
            orderLine(preorderA.variants[0]!.id, "preorder-a"),
            orderLine(preorderB.variants[0]!.id, "preorder-b", 2),
          ],
        },
      },
    });

    await createPreorderSnapshotAtConfirmation(tx, order.id, confirmedAt);
    await createPreorderSnapshotAtConfirmation(tx, order.id, new Date("2027-01-01T00:00:00.000Z"));

    const snapshot = await tx.orderPreorderSnapshot.findUniqueOrThrow({
      where: { orderId: order.id },
      include: { lines: { orderBy: { variantId: "asc" } } },
    });

    assert.equal(snapshot.confirmedAt.toISOString(), confirmedAt.toISOString());
    assert.equal(snapshot.preorderReadyAt?.toISOString(), "2026-02-09T10:15:00.000Z");
    assert.equal(snapshot.lines.length, 3);
    assert.equal(snapshot.lines.filter((line) => line.state === "PREORDER").length, 2);
    assert.equal(snapshot.lines.filter((line) => line.state === "READY").length, 1);
    assert.deepEqual(
      snapshot.lines
        .filter((line) => line.state === "PREORDER")
        .map((line) => line.preorderReadyAt?.toISOString()),
      ["2026-02-09T10:15:00.000Z", "2026-02-09T10:15:00.000Z"],
    );
  });
});

test("I7 does not rewrite history when stock or selling policy changes after confirmation", async () => {
  await withRollback(async (tx) => {
    const preorder = await seedProduct(tx, "history", "PREORDER", 0);
    const order = await tx.orderMirror.create({
      data: {
        publicCode: `${prefix}-history`,
        pancakeShopId: shopId,
        state: "CONFIRMED",
        lines: { create: [orderLine(preorder.variants[0]!.id, "history")] },
      },
    });

    await createPreorderSnapshotAtConfirmation(tx, order.id, confirmedAt);

    await tx.productSellingPolicy.update({
      where: { productId: preorder.id },
      data: { sellingMode: "STANDARD", negativeStockLimit: 0 },
    });
    await tx.warehouseStock.updateMany({
      where: { variantId: preorder.variants[0]!.id },
      data: { quantity: 100, syncedAt: new Date("2027-01-01T00:00:00.000Z") },
    });

    const snapshot = await tx.orderPreorderSnapshot.findUniqueOrThrow({
      where: { orderId: order.id },
      include: { lines: true },
    });
    assert.equal(snapshot.preorderReadyAt?.toISOString(), "2026-02-09T10:15:00.000Z");
    assert.equal(snapshot.lines[0]?.state, "PREORDER");
    assert.equal(snapshot.lines[0]?.preorderReadyAt?.toISOString(), "2026-02-09T10:15:00.000Z");
  });
});

test("I7 does not create a 15-day snapshot for a submission that never reaches CONFIRMED", async () => {
  const publicCode = `${prefix}-preconfirm`;
  await prisma.orderMirror.deleteMany({ where: { publicCode } });
  const order = await prisma.orderMirror.create({
    data: {
      publicCode,
      pancakeShopId: shopId,
      state: "DRAFT",
      lines: {
        create: {
          variantId: `${prefix}-missing-variant`,
          pancakeVariationId: `${prefix}-missing-variation`,
          productName: "I7 preconfirm",
          color: "Black",
          size: "M",
          quantity: 1,
          unitPriceVnd: BigInt(500_000),
          lineTotalVnd: BigInt(500_000),
        },
      },
    },
  });

  const submission = createPancakeOrderSubmissionService(prisma, {
    async fetchCompleteCatalog() {
      throw new Error("simulated pre-confirmation failure");
    },
    async createOrder() {
      throw new Error("must not reach external create");
    },
  });

  const result = await submission.submit({ publicCode, shopId });
  assert.equal(result.ok, false);
  assert.equal(result.state, "DRAFT");

  const snapshotCount = await prisma.orderPreorderSnapshot.count({ where: { orderId: order.id } });
  assert.equal(snapshotCount, 0);

  await prisma.orderMirror.delete({ where: { id: order.id } });
});

test("I7 uses confirmation date, not Merchant availability_date, for the stored ETA", async () => {
  await withRollback(async (tx) => {
    const preorder = await seedProduct(tx, "merchant-date-independent", "PREORDER", 0);
    const order = await tx.orderMirror.create({
      data: {
        publicCode: `${prefix}-merchant-date-independent`,
        pancakeShopId: shopId,
        state: "CONFIRMED",
        lines: { create: [orderLine(preorder.variants[0]!.id, "merchant-date-independent")] },
      },
    });

    await createPreorderSnapshotAtConfirmation(tx, order.id, new Date("2026-12-20T10:15:00.000Z"));

    const snapshot = await tx.orderPreorderSnapshot.findUniqueOrThrow({
      where: { orderId: order.id },
    });
    assert.equal(snapshot.preorderReadyAt?.toISOString(), "2027-01-04T10:15:00.000Z");
  });
});
