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
  orderState: "DRAFT" | "VALIDATING" | "POS_SUBMITTING",
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

/**
 * ADR 0014 §8 expiry — the mechanism, exercised with an explicitly supplied window.
 *
 * The production window (`RESERVED_HOLD_WINDOW_MS`) is deliberately `null`: §8 says only that it
 * "belongs to I6a" and "must be long enough to cover a slow legitimate checkout", and neither it
 * nor the owner-approved facts authority names a number. Inventing one here would be choosing, in
 * a test, when real buyers lose units they are mid-way through buying.
 *
 * So these pass a window explicitly. They prove the path is correct and complete the day a number
 * is approved — and that until then it frees nothing.
 */

const EXPLICIT_TEST_WINDOW_MS = 30 * 60_000;

test("I6b an abandoned RESERVED hold stops counting once a window is supplied", async () => {
  // A DRAFT, which is exactly the abandoned-checkout shape: reserve, submission ends pre-write and
  // returns the order to DRAFT, buyer walks away. Crash recovery deliberately never sweeps DRAFT —
  // it is the one active state with no stranded-ness to infer — so expiry is the ONLY thing that
  // can ever free this hold. Using a VALIDATING order here would have proved nothing: recovery
  // would have released the hold on its own evidence and the sweep would have had nothing to do.
  const { hold } = await seedStranded("expiring", "DRAFT", "RESERVED");
  await prisma.$executeRaw`UPDATE "VariantCapacityReservation" SET "updatedAt" = ${stale} WHERE id = ${hold.id}`;

  const result = await recoverStrandedGuestCheckouts(prisma, {
    now,
    reservedHoldWindowMs: EXPLICIT_TEST_WINDOW_MS,
  });

  assert.equal(result.reservedExpired, 1);
  const expired = await prisma.variantCapacityReservation.findUniqueOrThrow({ where: { id: hold.id } });
  assert.equal(expired.state, "RELEASED");
  assert.notEqual(expired.releasedAt, null);
});

test("I6b no window means no hold is ever timer-released", async () => {
  // Today's production behaviour, and the reason it is not a bug: an unapproved duration is not a
  // licence to pick one. The facts authority is explicit that a pending value stays unset.
  const { hold } = await seedStranded("no-window", "DRAFT", "RESERVED");
  await prisma.$executeRaw`UPDATE "VariantCapacityReservation" SET "updatedAt" = ${stale} WHERE id = ${hold.id}`;

  const result = await recoverStrandedGuestCheckouts(prisma, { now });

  assert.equal(result.reservedExpired, 0, "no approved window must mean no expiry at all");
  assert.equal(
    (await prisma.variantCapacityReservation.findUniqueOrThrow({ where: { id: hold.id } })).state,
    "RESERVED",
    "without an approved window the hold keeps counting — the gap, stated honestly",
  );
});

test("I6b a clock never frees SUBMITTING, UNKNOWN or COMMITTED, however stale", async () => {
  // §8's hard line, and the whole reason expiry is scoped to one state. A timer cannot tell a slow
  // write from a landed one, so freeing on age is the oversell G2 proved Pancake will not prevent.
  for (const state of ["SUBMITTING", "UNKNOWN", "COMMITTED"] as const) {
    const variant = await seedVariant(`ageless-${state}`);
    // A CONFIRMED order so recovery's own state machine has nothing to say about it: this test is
    // about the clock, not about crash recovery.
    //
    // `sourceCartId` is set deliberately. The sweep is scoped through the order's cart, so an order
    // without one is excluded by the join before the state filter is ever consulted — and this test
    // would then pass even if expiry freed every state. It must be the STATE that saves these rows.
    const cart = await prisma.cart.create({
      data: {
        expiresAt: new Date(now.getTime() + 600_000),
        items: { create: { variantId: variant.id, quantity: 1 } },
      },
    });
    const order = await prisma.orderMirror.create({
      data: {
        publicCode: `${key}-ageless-${state}`,
        sourceCartId: cart.id,
        pancakeShopId: shopId,
        state: "CONFIRMED",
        pancakeOrderId: `${key}-pancake-${state}`,
      },
    });
    const hold = await prisma.variantCapacityReservation.create({
      data: {
        orderId: order.id,
        variantId: variant.id,
        quantity: 1,
        state,
        committedAt: state === "COMMITTED" ? stale : null,
      },
    });
    await prisma.$executeRaw`UPDATE "VariantCapacityReservation" SET "updatedAt" = ${stale} WHERE id = ${hold.id}`;

    const result = await recoverStrandedGuestCheckouts(prisma, {
      now,
      reservedHoldWindowMs: EXPLICIT_TEST_WINDOW_MS,
    });

    assert.equal(result.reservedExpired, 0, `a ${state} hold is not the clock's to free`);
    assert.equal(
      (await prisma.variantCapacityReservation.findUniqueOrThrow({ where: { id: hold.id } })).state,
      state,
      `a ${state} hold must survive any age`,
    );
    await cleanup();
  }
});

test("I6b a hold younger than the window is left alone", async () => {
  // The window has to actually govern, or "expiry" would just mean "release every sweep" — which
  // would strip a slow legitimate checkout mid-purchase, the one thing §8 says it must not do.
  const { hold } = await seedStranded("young", "DRAFT", "RESERVED");
  const recent = new Date(now.getTime() - 60_000);
  await prisma.$executeRaw`UPDATE "VariantCapacityReservation" SET "updatedAt" = ${recent} WHERE id = ${hold.id}`;

  const result = await recoverStrandedGuestCheckouts(prisma, {
    now,
    // A window far longer than the hold's age.
    reservedHoldWindowMs: EXPLICIT_TEST_WINDOW_MS,
  });

  assert.equal(result.reservedExpired, 0, "a hold inside its window must not be expired");
});
