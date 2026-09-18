import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createCapacityReservationRepository } from "../../src/commerce/capacity-reservation.ts";
import { createGuestCheckoutSnapshotService } from "../../src/commerce/guest-checkout-snapshot.ts";
import { acceptAnyRenderedQuote } from "../fixtures/rendered-quote-authority.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

/**
 * I6b — an order id must not outlive the basket its ledger rows hold.
 *
 * A reservation is keyed by the order (ADR 0014 §3) and answers a retry only for the *same* basket.
 * The snapshot rewrites a mutable DRAFT's lines in place, keeping its id — so without the supersede
 * below, a buyer who changes their cart after a pre-write ending binds a live order id to a basket
 * its own holds contradict. Every retry is then refused `reservation-conflict`, and the
 * active-checkout index blocks a second order for that cart, so the buyer is stuck on CART_CHANGED
 * with a perfectly valid basket.
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const capacity = createCapacityReservationRepository(prisma);
const shopId = 920_007;
const now = new Date("2026-09-18T02:00:00.000Z");
const key = "i6b-supersede";

const checkoutInput = {
  name: "Nguyễn Văn A",
  phone: "0901234567",
  provinceRef: "province-01",
  districtRef: "district-001",
  communeRef: "commune-0001",
  detail: "12 Đường A",
  note: null,
};

async function cleanup() {
  const orders = await prisma.orderMirror.findMany({
    where: { publicCode: { startsWith: key } },
    select: { id: true },
  });
  await prisma.variantCapacityReservation.deleteMany({
    where: { orderId: { in: orders.map((order) => order.id) } },
  });
  await prisma.orderMirror.deleteMany({ where: { publicCode: { startsWith: key } } });
  await prisma.cart.deleteMany({
    where: { items: { some: { variant: { pancakeVariationId: { startsWith: key } } } } },
  });
  await prisma.productSellingPolicy.deleteMany({
    where: { product: { pancakeProductId: { startsWith: key } } },
  });
  await prisma.productMirror.deleteMany({ where: { pancakeProductId: { startsWith: key } } });
}

test.before(cleanup);
test.afterEach(cleanup);
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

const snapshotService = createGuestCheckoutSnapshotService(prisma, {
  checkoutInputValidated: true,
  verifyRenderedQuote: acceptAnyRenderedQuote,
});

async function seedVariant(label: string, stock: number) {
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: shopId,
      pancakeProductId: `${key}-product-${label}`,
      slug: `${key}-${label}`,
      name: `I6B supersede ${label}`,
      isPresent: true,
      isActive: true,
      syncedAt: now,
      variants: {
        create: {
          pancakeVariationId: `${key}-variation-${label}`,
          color: "Black",
          size: "M",
          isPresent: true,
          isActive: true,
          pancakeRetailPrice: 500_000,
          pancakeRetailPriceAfterDiscount: 500_000,
          syncedAt: now,
          warehouseStocks: {
            create: { pancakeWarehouseId: `${key}-wh-${label}`, quantity: stock, syncedAt: now },
          },
        },
      },
    },
    include: { variants: true },
  });
  return product.variants[0]!;
}

async function snapshot(cartId: string, publicCode: string) {
  return snapshotService.create({ cartId, shopId, publicCode, checkoutInput, now });
}

test("I6b a cart change after a pre-write ending gets a fresh attempt that can reserve", async () => {
  // The exact sequence: A x1 reserved -> submission ends pre-write, so the hold correctly stays
  // RESERVED -> the buyer changes the cart to A x2 -> the retry must be able to hold A x2.
  const variant = await seedVariant("retry", 9);
  const cart = await prisma.cart.create({
    data: {
      expiresAt: new Date(now.getTime() + 600_000),
      items: { create: { variantId: variant.id, quantity: 1 } },
    },
  });

  const first = await snapshot(cart.id, `${key}-retry-1`);
  assert.equal(first.ok, true);
  const firstOrderId = first.ok ? first.order.id : "";

  const heldOnce = await capacity.reserveOrderCapacity({
    orderId: firstOrderId,
    lines: [{ variantId: variant.id, quantity: 1 }],
  });
  assert.equal(heldOnce.ok, true, "A x1 must hold");

  // The submission ended before the write, so the hold stays RESERVED and the order stays DRAFT.
  // That is the state 8f68b88 establishes, and it is what makes this reachable.
  const afterFirst = await prisma.orderMirror.findUniqueOrThrow({ where: { id: firstOrderId } });
  assert.equal(afterFirst.state, "DRAFT");

  // The buyer changes their mind.
  await prisma.cartItem.updateMany({ where: { cartId: cart.id }, data: { quantity: 2 } });

  const second = await snapshot(cart.id, `${key}-retry-2`);
  assert.equal(second.ok, true, "the re-snapshot must succeed");
  const secondOrderId = second.ok ? second.order.id : "";

  assert.notEqual(
    secondOrderId,
    firstOrderId,
    "a changed basket must get a new order id, not a rewritten one still bound to the old hold",
  );

  const superseded = await prisma.orderMirror.findUniqueOrThrow({ where: { id: firstOrderId } });
  assert.equal(superseded.state, "REJECTED");
  assert.equal(superseded.syncErrorCode, "SUPERSEDED_BY_CART_CHANGE");

  const oldHolds = await prisma.variantCapacityReservation.findMany({
    where: { orderId: firstOrderId },
  });
  assert.ok(
    oldHolds.every((hold) => hold.state === "RELEASED"),
    "the superseded order's pre-write holds must be freed, not left counting",
  );

  // The point of the whole fix: the new basket can actually be held.
  const heldTwice = await capacity.reserveOrderCapacity({
    orderId: secondOrderId,
    lines: [{ variantId: variant.id, quantity: 2 }],
  });
  assert.equal(heldTwice.ok, true, "the retry must be able to reserve the new basket");
});

test("I6b an unchanged basket keeps its order id and its hold", async () => {
  // The other direction, so "supersede on change" cannot widen into "supersede on every
  // re-snapshot": that would mint a new order id per attempt and throw away a live hold each time,
  // which is exactly the idempotency §3 exists to provide.
  const variant = await seedVariant("stable", 9);
  const cart = await prisma.cart.create({
    data: {
      expiresAt: new Date(now.getTime() + 600_000),
      items: { create: { variantId: variant.id, quantity: 1 } },
    },
  });

  const first = await snapshot(cart.id, `${key}-stable-1`);
  assert.equal(first.ok, true);
  const orderId = first.ok ? first.order.id : "";
  await capacity.reserveOrderCapacity({
    orderId,
    lines: [{ variantId: variant.id, quantity: 1 }],
  });

  const second = await snapshot(cart.id, `${key}-stable-2`);
  assert.equal(second.ok, true);
  assert.equal(second.ok ? second.order.id : "", orderId, "an unchanged basket must reuse the order");

  const holds = await prisma.variantCapacityReservation.findMany({ where: { orderId } });
  assert.equal(holds.length, 1);
  assert.equal(holds[0]!.state, "RESERVED", "a live hold must survive a no-op re-snapshot");
});

test("I6b a hold that may have reached Pancake is never superseded", async () => {
  // §8's hard line. Once a hold is SUBMITTING, COMMITTED or UNKNOWN, a write may have landed, and
  // nothing may free it on inference. Superseding here would free capacity Pancake has taken.
  for (const state of ["SUBMITTING", "COMMITTED", "UNKNOWN"] as const) {
    const variant = await seedVariant(`live-${state}`, 9);
    const cart = await prisma.cart.create({
      data: {
        expiresAt: new Date(now.getTime() + 600_000),
        items: { create: { variantId: variant.id, quantity: 1 } },
      },
    });
    const first = await snapshot(cart.id, `${key}-live-${state}`);
    assert.equal(first.ok, true);
    const orderId = first.ok ? first.order.id : "";
    await capacity.reserveOrderCapacity({
      orderId,
      lines: [{ variantId: variant.id, quantity: 1 }],
    });
    await prisma.variantCapacityReservation.updateMany({
      where: { orderId },
      data: {
        state,
        committedAt: state === "COMMITTED" ? now : null,
      },
    });

    await prisma.cartItem.updateMany({ where: { cartId: cart.id }, data: { quantity: 2 } });
    const second = await snapshot(cart.id, `${key}-live-${state}-2`);

    assert.equal(
      second.ok ? second.order.id : "",
      orderId,
      `a ${state} hold must not be superseded`,
    );
    const holds = await prisma.variantCapacityReservation.findMany({ where: { orderId } });
    assert.equal(holds[0]!.state, state, `a ${state} hold must be left exactly as it was`);
    await cleanup();
  }
});
