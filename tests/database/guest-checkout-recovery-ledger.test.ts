import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import {
  RESERVED_HOLD_WINDOW_MS,
  recoverStrandedGuestCheckouts,
} from "../../src/commerce/guest-checkout-recovery.ts";
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
 * ADR 0014 §8 expiry.
 *
 * The window is **15 minutes**, approved by the repository owner on 2026-09-18. Until then it was
 * `null` and the path was inert, because §8 names no duration and inventing one would have meant
 * choosing, in a test, when real buyers lose units they are mid-way through buying.
 *
 * These pass a window explicitly so each case states the age it is about, rather than depending on
 * a constant that could change underneath them. The constant itself is asserted separately below:
 * without that, a future edit setting it back to `null` would turn expiry off in production and
 * every test here would still pass.
 */

const EXPLICIT_TEST_WINDOW_MS = 30 * 60_000;

test("I6b the approved expiry window is wired, so production actually expires holds", async () => {
  // The one assertion these specs cannot make with an injected window. Every other test here would
  // still pass if the constant were `null` — production would simply never expire anything, which
  // is precisely the gap the owner's approval closed.
  assert.equal(
    RESERVED_HOLD_WINDOW_MS,
    15 * 60_000,
    "the owner-approved RESERVED hold window is 15 minutes (facts authority, 2026-09-18)",
  );

  // And it is genuinely the default: a caller that supplies no window still expires a stale hold.
  const { hold } = await seedStranded("approved-window", "DRAFT", "RESERVED");
  const olderThanTheWindow = new Date(now.getTime() - 16 * 60_000);
  await prisma.$executeRaw`UPDATE "VariantCapacityReservation" SET "updatedAt" = ${olderThanTheWindow} WHERE id = ${hold.id}`;

  const result = await recoverStrandedGuestCheckouts(prisma, { now });

  assert.equal(result.reservedExpired, 1);
  assert.equal(
    (await prisma.variantCapacityReservation.findUniqueOrThrow({ where: { id: hold.id } })).state,
    "RELEASED",
  );
});

test("I6b a hold inside the approved window survives the default sweep", async () => {
  // The other side of the same constant: 14 minutes is still a live checkout, and §8's whole
  // requirement is that the window be long enough to cover a slow legitimate one.
  const { hold } = await seedStranded("inside-window", "DRAFT", "RESERVED");
  const insideTheWindow = new Date(now.getTime() - 14 * 60_000);
  await prisma.$executeRaw`UPDATE "VariantCapacityReservation" SET "updatedAt" = ${insideTheWindow} WHERE id = ${hold.id}`;

  const result = await recoverStrandedGuestCheckouts(prisma, { now });

  assert.equal(result.reservedExpired, 0, "a hold inside the approved window must not be expired");
  assert.equal(
    (await prisma.variantCapacityReservation.findUniqueOrThrow({ where: { id: hold.id } })).state,
    "RESERVED",
  );
});

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

test("I6b expiry is driven by the window, not by the sweep running", async () => {
  // Before the owner approved a duration, the constant was `null` and this proved nothing was ever
  // timer-released. That property still matters as a mechanism: expiry must be the WINDOW's doing,
  // so that a deployment which has not yet agreed a duration cannot free a buyer's units merely by
  // running recovery. A window of zero-length applicability is expressed by supplying none.
  const { hold } = await seedStranded("window-drives", "DRAFT", "RESERVED");
  await prisma.$executeRaw`UPDATE "VariantCapacityReservation" SET "updatedAt" = ${stale} WHERE id = ${hold.id}`;

  const result = await recoverStrandedGuestCheckouts(prisma, {
    now,
    reservedHoldWindowMs: 24 * 60 * 60_000,
  });

  assert.equal(result.reservedExpired, 0, "a hold inside the supplied window must not be expired");
  assert.equal(
    (await prisma.variantCapacityReservation.findUniqueOrThrow({ where: { id: hold.id } })).state,
    "RESERVED",
  );
});

test("I6b a clock never frees SUBMITTING, UNKNOWN or COMMITTED, however stale", async () => {
  // §8's hard line, and the whole reason expiry is scoped to one state. A timer cannot tell a slow
  // write from a landed one, so freeing on age is the oversell G2 proved Pancake will not prevent.
  for (const state of ["SUBMITTING", "UNKNOWN", "COMMITTED"] as const) {
    const variant = await seedVariant(`ageless-${state}`);
    // A DRAFT order, so nothing else in recovery has anything to say about these rows: DRAFT is
    // neither swept as stranded nor converged from a persisted outcome. This test is about the
    // CLOCK alone, and a CONFIRMED order would now (correctly) have its SUBMITTING hold settled to
    // COMMITTED by outcome convergence — which is evidence, not a timer, and a different rule.
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
        state: "DRAFT",
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

/**
 * The TOCTOU the guarded write exists to close.
 *
 * Recovery used to select stale candidate ids and then update them by id alone. Under READ
 * COMMITTED a live submission can advance an order between those two statements, so recovery would
 * retire an order that had *just* been claimed for submission, release its hold, and let the
 * submitter go on to call Pancake — an order that exists remotely, reads `REJECTED` locally, and
 * holds no capacity at all.
 *
 * The predicates now live on the `UPDATE` itself, re-checked under the row lock, with `RETURNING`
 * reporting only the rows this recovery actually won.
 */

test("I6b recovery never overwrites an order a submitter advanced first", async () => {
  // Deterministic half: the order is advanced BEFORE recovery runs, exactly as a racing submitter
  // would leave it. The stale `updatedAt` is preserved, so only the state predicate can save it.
  const { order, hold } = await seedStranded("advanced", "VALIDATING", "RESERVED");
  await prisma.variantCapacityReservation.update({
    where: { id: hold.id },
    data: { state: "SUBMITTING" },
  });
  await prisma.$executeRaw`UPDATE "OrderMirror" SET "state" = 'POS_SUBMITTING', "updatedAt" = ${stale} WHERE id = ${order.id}`;

  const result = await recoverStrandedGuestCheckouts(prisma, { now });

  // It is swept as a stale POS_SUBMITTING — which is correct and is a different rule — but it must
  // NEVER have been retired as VALIDATING, and its hold must never have been released.
  assert.equal(result.validatingRejected, 0, "the VALIDATING sweep must not claim an advanced order");
  const recovered = await prisma.orderMirror.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(recovered.state, "SYNC_UNKNOWN");
  assert.equal(
    (await prisma.variantCapacityReservation.findUniqueOrThrow({ where: { id: hold.id } })).state,
    "UNKNOWN",
    "a hold on an advanced order must never be released by the VALIDATING path",
  );
});

test("I6b a real race between recovery and a submitter has no interleaving that loses the write", async () => {
  // The genuine concurrency regression: recovery and a submitter's claim run at the same time,
  // repeatedly. Which one wins is nondeterministic; what must hold either way is that the two
  // outcomes stay CONSISTENT — the losing side must not have partially applied.
  //
  // The forbidden state is precise: an order retired to REJECTED whose hold was released, while the
  // submitter also believes it holds the claim. That is the state that puts a real order into
  // Pancake with no local record and no capacity held.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const { order, hold } = await seedStranded(`race-${attempt}`, "VALIDATING", "RESERVED");

    const [, claimed] = await Promise.all([
      recoverStrandedGuestCheckouts(prisma, { now }),
      // Exactly what `pancake-order-submit` does at its write boundary: a guarded CAS out of
      // VALIDATING. `count` tells the submitter whether it owns the write.
      prisma.orderMirror
        .updateMany({
          where: { id: order.id, state: "VALIDATING" },
          data: { state: "POS_SUBMITTING" },
        })
        .then(({ count }) => count === 1),
    ]);

    const finalOrder = await prisma.orderMirror.findUniqueOrThrow({ where: { id: order.id } });
    const finalHold = await prisma.variantCapacityReservation.findUniqueOrThrow({
      where: { id: hold.id },
    });

    if (claimed) {
      // The submitter won the claim, so recovery must not have retired the order underneath it and
      // must not have freed the units it is about to spend.
      assert.notEqual(
        finalOrder.state,
        "REJECTED",
        "an order claimed for submission must not be retired by recovery",
      );
      assert.notEqual(
        finalHold.state,
        "RELEASED",
        "capacity must not be freed under a submitter that owns the write",
      );
    } else {
      // Recovery won. The order is retired and its hold released together — never one without the
      // other, which is what running both in one transaction guarantees.
      assert.equal(finalOrder.state, "REJECTED");
      assert.equal(finalHold.state, "RELEASED");
    }
    await cleanup();
  }
});

/**
 * The crash window after an outcome is persisted and before the ledger is settled.
 *
 * Submission writes the order's outcome, then settles its holds. A crash between the two leaves a
 * decided order with an in-flight hold, and nothing swept those: the order is no longer in a state
 * the stranded paths look at, so a confirmed order could keep a hold counting forever even though
 * its outcome had been known locally all along.
 */

test("I6b a persisted outcome converges its unsettled hold", async () => {
  for (const [orderState, holdState, expected] of [
    // Pancake accepted, so the hold is committed rather than freed — §4.1 retires it by the mirror
    // rule, not this.
    ["CONFIRMED", "SUBMITTING", "COMMITTED"],
    // The ambiguous write stays ambiguous. §8: never released on anything but evidence.
    ["SYNC_UNKNOWN", "SUBMITTING", "UNKNOWN"],
    // A refusal is evidence nothing landed — from Pancake, so the boundary had been crossed.
    ["REJECTED", "SUBMITTING", "RELEASED"],
    // ...and from local validation, where the hold never left RESERVED.
    ["REJECTED", "RESERVED", "RELEASED"],
  ] as const) {
    const variant = await seedVariant(`settled-${orderState}-${holdState}`);
    const cart = await prisma.cart.create({
      data: {
        expiresAt: new Date(now.getTime() + 600_000),
        items: { create: { variantId: variant.id, quantity: 1 } },
      },
    });
    const order = await prisma.orderMirror.create({
      data: {
        publicCode: `${key}-settled-${orderState}-${holdState}`,
        sourceCartId: cart.id,
        pancakeShopId: shopId,
        state: orderState,
        pancakeOrderId: orderState === "CONFIRMED" ? `${key}-pk-${holdState}` : null,
      },
    });
    const hold = await prisma.variantCapacityReservation.create({
      data: { orderId: order.id, variantId: variant.id, quantity: 1, state: holdState },
    });
    await prisma.$executeRaw`UPDATE "OrderMirror" SET "updatedAt" = ${stale} WHERE id = ${order.id}`;

    const result = await recoverStrandedGuestCheckouts(prisma, { now });
    assert.equal(result.settledConverged, 1, `${orderState} + ${holdState} must converge`);

    const converged = await prisma.variantCapacityReservation.findUniqueOrThrow({
      where: { id: hold.id },
    });
    assert.equal(converged.state, expected, `${orderState} + ${holdState} -> ${expected}`);
    if (expected === "COMMITTED") {
      // The CHECK constraint demands it, and the value matters: a recovery-time `committedAt` is
      // LATER than the true commit, so §4.1 demands a fresher stock observation before retiring the
      // hold. The error is a hold that counts slightly too long, never one that stops counting
      // while Pancake's decrement is still unobserved.
      assert.notEqual(converged.committedAt, null);
    }
    await cleanup();
  }
});

test("I6b a decided order whose hold was already settled is not converged again", async () => {
  // Convergence must be idempotent, or a second sweep would rewrite a decision with its own.
  const variant = await seedVariant("settled-idempotent");
  const cart = await prisma.cart.create({
    data: {
      expiresAt: new Date(now.getTime() + 600_000),
      items: { create: { variantId: variant.id, quantity: 1 } },
    },
  });
  const order = await prisma.orderMirror.create({
    data: {
      publicCode: `${key}-settled-idempotent`,
      sourceCartId: cart.id,
      pancakeShopId: shopId,
      state: "CONFIRMED",
      pancakeOrderId: `${key}-pk-idempotent`,
    },
  });
  const committedAt = new Date(now.getTime() - 120_000);
  const hold = await prisma.variantCapacityReservation.create({
    data: {
      orderId: order.id,
      variantId: variant.id,
      quantity: 1,
      state: "COMMITTED",
      committedAt,
    },
  });
  await prisma.$executeRaw`UPDATE "OrderMirror" SET "updatedAt" = ${stale} WHERE id = ${order.id}`;

  const result = await recoverStrandedGuestCheckouts(prisma, { now });

  assert.equal(result.settledConverged, 0);
  const untouched = await prisma.variantCapacityReservation.findUniqueOrThrow({
    where: { id: hold.id },
  });
  assert.equal(untouched.state, "COMMITTED");
  assert.deepEqual(
    untouched.committedAt,
    committedAt,
    "a settled hold keeps the timestamp its own settlement wrote",
  );
});
