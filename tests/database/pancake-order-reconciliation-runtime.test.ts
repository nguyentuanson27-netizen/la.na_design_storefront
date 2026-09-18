import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createPancakeOrderReconciliationRuntime } from "../../src/commerce/pancake-order-reconciliation-runtime.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const shopId = 920_125;
const prefix = "i8-runtime";

async function seedUnknownOrder(label: string) {
  const suffix = `${label}-${randomUUID()}`;
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: shopId,
      pancakeProductId: `${prefix}-product-${suffix}`,
      slug: `${prefix}-${suffix}`,
      name: `I8 runtime ${label}`,
      isPresent: true,
      isActive: true,
      syncedAt: new Date("2026-09-18T00:00:00.000Z"),
      variants: {
        create: {
          pancakeVariationId: `${prefix}-variation-${suffix}`,
          isPresent: true,
          isActive: true,
          syncedAt: new Date("2026-09-18T00:00:00.000Z"),
        },
      },
    },
    include: { variants: true },
  });
  const variant = product.variants[0]!;
  const cartId = `${prefix}-cart-${suffix}`;
  const order = await prisma.orderMirror.create({
    data: {
      publicCode: `${prefix}-order-${suffix}`,
      sourceCartId: cartId,
      pancakeShopId: shopId,
      state: "SYNC_UNKNOWN",
      syncErrorCode: "CREATE_OUTCOME_UNKNOWN",
      lines: {
        create: {
          variantId: variant.id,
          pancakeVariationId: variant.pancakeVariationId,
          productName: `I8 runtime ${label}`,
          size: "M",
          quantity: 1,
          unitPriceVnd: BigInt(100_000),
          lineTotalVnd: BigInt(100_000),
        },
      },
      capacityReservations: {
        create: {
          variantId: variant.id,
          quantity: 1,
        },
      },
    },
    include: { capacityReservations: true },
  });
  const reservation = order.capacityReservations[0]!;
  await prisma.variantCapacityReservation.update({
    where: { id: reservation.id },
    data: { state: "UNKNOWN" },
  });
  return { productId: product.id, order, reservationId: reservation.id, cartId };
}

async function cleanup(seed: Awaited<ReturnType<typeof seedUnknownOrder>>) {
  await prisma.variantCapacityReservation.deleteMany({ where: { orderId: seed.order.id } });
  await prisma.orderMirror.delete({ where: { id: seed.order.id } });
  await prisma.productMirror.delete({ where: { id: seed.productId } });
}

test.after(async () => {
  await prisma.$disconnect();
});

test("runtime reconciliation makes checkout-recovery UNKNOWN orders convergent without reposting", async () => {
  const scenarios = [
    {
      label: "found",
      search: { kind: "FOUND" as const, orderId: "880125" },
      expectedOrderState: "CONFIRMED",
      expectedReservationState: "COMMITTED",
      expectedSearchCalls: 1,
    },
    {
      label: "absent",
      search: { kind: "ABSENT" as const },
      expectedOrderState: "REJECTED",
      expectedReservationState: "RELEASED",
      expectedSearchCalls: 5,
    },
    {
      label: "ambiguous",
      search: { kind: "AMBIGUOUS" as const, reason: "marker search still inconclusive" },
      expectedOrderState: "SYNC_UNKNOWN",
      expectedReservationState: "UNKNOWN",
      expectedSearchCalls: 1,
    },
  ] as const;

  for (const scenario of scenarios) {
    const seed = await seedUnknownOrder(scenario.label);
    try {
      let searchCalls = 0;
      const runtime = createPancakeOrderReconciliationRuntime(
        { apiKey: "server-only-test-key", shopId },
        {
          createGateway() {
            return {
              async searchOrderByMarker(receivedShopId, marker) {
                searchCalls += 1;
                assert.equal(receivedShopId, shopId);
                assert.equal(marker, `[ORDER:${seed.order.publicCode}]`);
                return scenario.search;
              },
            };
          },
        },
      );

      const result = await runtime.reconcileCart(seed.cartId);
      assert.ok(result, "the cart-scoped runtime must find its SYNC_UNKNOWN order");
      assert.equal(searchCalls, scenario.expectedSearchCalls, "recovery must use bounded marker search and never repost");

      const [order, reservation] = await Promise.all([
        prisma.orderMirror.findUniqueOrThrow({
          where: { id: seed.order.id },
          select: { state: true, pancakeOrderId: true },
        }),
        prisma.variantCapacityReservation.findUniqueOrThrow({
          where: { id: seed.reservationId },
          select: { state: true },
        }),
      ]);
      assert.equal(order.state, scenario.expectedOrderState);
      assert.equal(reservation.state, scenario.expectedReservationState);
      if (scenario.search.kind === "FOUND") {
        assert.equal(order.pancakeOrderId, scenario.search.orderId);
      } else {
        assert.equal(order.pancakeOrderId, null);
      }
    } finally {
      await cleanup(seed);
    }
  }
});
