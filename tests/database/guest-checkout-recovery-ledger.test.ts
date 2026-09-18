import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { recoverStrandedGuestCheckouts } from "../../src/commerce/guest-checkout-recovery.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

/**
 * I6b — crash recovery has to move the capacity ledger with the order.
 *
 * `VariantCapacityReservation` is authoritative checkout state, not a side table. A recovery that
 * retires or resolves an `OrderMirror` row while leaving its hold untouched creates exactly the
 * false hold the ledger exists to prevent: the order is gone, the SKU is still unavailable, and
 * nothing short of an operator will notice.
 *
 * The two directions are deliberately asymmetric, and getting that backwards is the whole risk:
 *
 * - `VALIDATING` provably never wrote — `createOrder` is reached only after the
 *   `VALIDATING -> POS_SUBMITTING` compare-and-set commits — so its hold is **released**.
 * - `POS_SUBMITTING` is ambiguous, so §9 says its hold becomes **UNKNOWN**. Releasing it would be
 *   the oversell §8 forbids; only §10 reconciliation may resolve it.
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const shopId = 920_007;
const now = new Date("2026-09-18T03:00:00.000Z");
const stale = new Date(now.getTime() - 60 * 60_000);
const key = "i6b-recovery";

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
  await prisma.productMirror.deleteMany({ where: { pancakeProductId: { startsWith: key } } });
}

test.before(cleanup);
test.afterEach(cleanup);
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

async function seedVariant(label: string) {
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: shopId,
      pancakeProductId: `${key}-product-${label}`,
      slug: `${key}-${label}`,
      name: `I6B recovery ${label}`,
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
            create: { pancakeWarehouseId: `${key}-wh-${label}`, quantity: 9, syncedAt: now },
          },
        },
      },
    },
    include: { variants: true },
  });
  return product.variants[0]!;
}

/**
 * A stranded order with a hold, aged past the stale threshold.
 *
 * `updatedAt` is `@updatedAt`, so it has to be forced with raw SQL — writing the row through Prisma
 * would stamp it with "now" and the recovery sweep would correctly skip it.
 */
async function seedStranded(
  label: string,
  orderState: "VALIDATING" | "POS_SUBMITTING",
  holdState: "RESERVED" | "SUBMITTING",
) {
  const variant = await seedVariant(label);
  const cart = await prisma.cart.create({
    data: {
      expiresAt: new Date(now.getTime() + 600_000),
      items: { create: { variantId: variant.id, quantity: 1 } },
    },
  });
  const order = await prisma.orderMirror.create({
    data: {
      publicCode: `${key}-${label}`,
      sourceCartId: cart.id,
      pancakeShopId: shopId,
      state: orderState,
      // `OrderMirror_checkout_snapshot_complete` is all-or-nothing: an order carrying money must
      // carry the whole checkout snapshot, so a partial fixture is rejected by the database.
      checkoutSnapshottedAt: stale,
      guestName: "Nguyễn Văn A",
      guestPhone: "0901234567",
      provinceRef: "province-01",
      districtRef: "district-001",
      communeRef: "commune-0001",
      addressDetail: "12 Đường A",
      merchandiseSubtotalVnd: BigInt(500_000),
      shippingFeeVnd: BigInt(30_000),
      totalVnd: BigInt(530_000),
    },
  });
  const hold = await prisma.variantCapacityReservation.create({
    data: { orderId: order.id, variantId: variant.id, quantity: 1, state: holdState },
  });
  await prisma.$executeRaw`UPDATE "OrderMirror" SET "updatedAt" = ${stale} WHERE id = ${order.id}`;
  return { order, hold, cart };
}

test("I6b a stranded VALIDATING order releases the hold it proved never wrote", async () => {
  const { order, hold } = await seedStranded("validating", "VALIDATING", "RESERVED");

  const result = await recoverStrandedGuestCheckouts(prisma, { now });
  assert.equal(result.validatingRejected, 1);

  const recovered = await prisma.orderMirror.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(recovered.state, "REJECTED");
  assert.equal(recovered.syncErrorCode, "VALIDATION_INTERRUPTED");

  const recoveredHold = await prisma.variantCapacityReservation.findUniqueOrThrow({
    where: { id: hold.id },
  });
  assert.equal(
    recoveredHold.state,
    "RELEASED",
    "retiring the order while its hold kept counting is a false hold",
  );
  // The CHECK constraint is a biconditional, so a RELEASED row without this timestamp cannot exist
  // — asserting it keeps the intent visible rather than leaving it to the database to enforce.
  assert.notEqual(recoveredHold.releasedAt, null);
});

test("I6b a hold moved to SUBMITTING before a claim that never landed is still released", async () => {
  // The crash window the write-boundary hook opens: it moves the hold immediately BEFORE the
  // `VALIDATING -> POS_SUBMITTING` claim, so a process that dies between the two leaves a
  // SUBMITTING hold on a VALIDATING order. `createOrder` runs only after that claim commits, so
  // nothing was sent and the units must come back.
  const { order, hold } = await seedStranded("prewrite", "VALIDATING", "SUBMITTING");

  await recoverStrandedGuestCheckouts(prisma, { now });

  assert.equal((await prisma.orderMirror.findUniqueOrThrow({ where: { id: order.id } })).state, "REJECTED");
  assert.equal(
    (await prisma.variantCapacityReservation.findUniqueOrThrow({ where: { id: hold.id } })).state,
    "RELEASED",
  );
});

test("I6b a stranded POS_SUBMITTING order makes its hold UNKNOWN, never RELEASED", async () => {
  // §9. The write may have landed, so the hold becomes ambiguous rather than free. A stuck UNKNOWN
  // holding capacity is the safe failure — a variant that stops selling, not one that oversells.
  const { order, hold } = await seedStranded("submitting", "POS_SUBMITTING", "SUBMITTING");

  const result = await recoverStrandedGuestCheckouts(prisma, { now });
  assert.equal(result.submittingUnknown, 1);

  const recovered = await prisma.orderMirror.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(recovered.state, "SYNC_UNKNOWN");
  assert.equal(recovered.syncErrorCode, "CREATE_OUTCOME_UNKNOWN");

  const recoveredHold = await prisma.variantCapacityReservation.findUniqueOrThrow({
    where: { id: hold.id },
  });
  assert.equal(recoveredHold.state, "UNKNOWN", "an ambiguous write must never be freed by recovery");
  assert.equal(recoveredHold.releasedAt, null);
  assert.equal(recoveredHold.committedAt, null);
});

test("I6b a settled hold is never rewritten by recovery", async () => {
  // Terminal rows belong to whatever decided them. Recovery reaching into a COMMITTED hold would
  // be a second settlement of a decision it has no evidence about, and §15 rules that out.
  for (const state of ["COMMITTED", "RELEASED"] as const) {
    const { order, hold } = await seedStranded(`settled-${state}`, "POS_SUBMITTING", "SUBMITTING");
    await prisma.variantCapacityReservation.update({
      where: { id: hold.id },
      data: {
        state,
        committedAt: state === "COMMITTED" ? now : null,
        releasedAt: state === "RELEASED" ? now : null,
      },
    });

    await recoverStrandedGuestCheckouts(prisma, { now });

    // The ORDER still recovers — that part is not conditional on the ledger.
    assert.equal(
      (await prisma.orderMirror.findUniqueOrThrow({ where: { id: order.id } })).state,
      "SYNC_UNKNOWN",
    );
    assert.equal(
      (await prisma.variantCapacityReservation.findUniqueOrThrow({ where: { id: hold.id } })).state,
      state,
      `a ${state} hold must be left exactly as it was`,
    );
    await cleanup();
  }
});

test("I6b a fresh in-flight checkout is left alone entirely", async () => {
  // The threshold still governs. Sweeping a live checkout would free the units out from under a
  // buyer who is mid-submission.
  const variant = await seedVariant("fresh");
  const cart = await prisma.cart.create({
    data: {
      expiresAt: new Date(now.getTime() + 600_000),
      items: { create: { variantId: variant.id, quantity: 1 } },
    },
  });
  const order = await prisma.orderMirror.create({
    data: {
      publicCode: `${key}-fresh`,
      sourceCartId: cart.id,
      pancakeShopId: shopId,
      state: "POS_SUBMITTING",
      checkoutSnapshottedAt: now,
      guestName: "Nguyễn Văn A",
      guestPhone: "0901234567",
      provinceRef: "province-01",
      districtRef: "district-001",
      communeRef: "commune-0001",
      addressDetail: "12 Đường A",
      merchandiseSubtotalVnd: BigInt(500_000),
      shippingFeeVnd: BigInt(30_000),
      totalVnd: BigInt(530_000),
    },
  });
  const hold = await prisma.variantCapacityReservation.create({
    data: { orderId: order.id, variantId: variant.id, quantity: 1, state: "SUBMITTING" },
  });
  // `updatedAt` is `@updatedAt`, so Prisma stamps it with the real wall clock — which is behind
  // this fixture's `now` and would therefore read as stale. Pin it to `now` so this test is about
  // the threshold rather than about the gap between the two clocks.
  await prisma.$executeRaw`UPDATE "OrderMirror" SET "updatedAt" = ${now} WHERE id = ${order.id}`;

  const result = await recoverStrandedGuestCheckouts(prisma, { now });
  assert.equal(result.submittingUnknown, 0);
  assert.equal(
    (await prisma.variantCapacityReservation.findUniqueOrThrow({ where: { id: hold.id } })).state,
    "SUBMITTING",
    "a live submission's hold must not be touched",
  );
});
