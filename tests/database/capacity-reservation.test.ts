/**
 * I6a — the atomic capacity primitive against a real database (ADR 0014 §6.2, §6.4, §7).
 *
 * The concurrency test is the reason this file exists. Everything else here could be a domain test;
 * "two checkouts cannot both spend the same unit" cannot, because the claim is about what PostgreSQL
 * does when two transactions interleave, and no in-memory double proves it.
 *
 * The case it drives is §6.1's: a variant with an **empty ledger**. That is the state every variant
 * is in before its first sale, and it is exactly where the obvious implementation — lock the ledger
 * rows, then sum them — locks nothing, because `SELECT … FOR UPDATE` locks the rows it returns and
 * there are none.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createCapacityReservationRepository } from "../../src/commerce/capacity-reservation.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required for database smoke tests");
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const repository = createCapacityReservationRepository(prisma);

const testShopId = 920_082;
const externalPrefix = "reservation-";
const syncedAt = new Date("2026-09-17T00:00:00.000Z");

async function cleanup() {
  await prisma.variantCapacityReservation.deleteMany({
    where: { variant: { product: { pancakeProductId: { startsWith: externalPrefix } } } },
  });
  await prisma.orderMirror.deleteMany({ where: { publicCode: { startsWith: externalPrefix } } });
  await prisma.productMirror.deleteMany({
    where: { pancakeProductId: { startsWith: externalPrefix } },
  });
}

async function seedVariant(
  key: string,
  options: Readonly<{ stock?: number; sellingMode?: "STANDARD" | "OVERSELL" | "PREORDER"; negativeStockLimit?: number }> = {},
): Promise<string> {
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: testShopId,
      pancakeProductId: `${externalPrefix}${key}`,
      slug: `${externalPrefix}${key}`,
      name: key.toUpperCase(),
      syncedAt,
      ...(options.sellingMode
        ? {
            sellingPolicy: {
              create: {
                sellingMode: options.sellingMode,
                negativeStockLimit: options.negativeStockLimit ?? -20,
              },
            },
          }
        : {}),
    },
    select: { id: true },
  });
  const variant = await prisma.variantMirror.create({
    data: { pancakeVariationId: `${externalPrefix}${key}-v`, productId: product.id, syncedAt },
    select: { id: true },
  });
  if (options.stock !== undefined) {
    await prisma.warehouseStock.create({
      data: {
        variantId: variant.id,
        pancakeWarehouseId: `${externalPrefix}${key}-wh`,
        quantity: options.stock,
        syncedAt,
      },
    });
  }
  return variant.id;
}

async function seedOrder(key: string): Promise<string> {
  const order = await prisma.orderMirror.create({
    data: { publicCode: `${externalPrefix}${key}` },
    select: { id: true },
  });
  return order.id;
}

test.beforeEach(cleanup);
test.afterEach(cleanup);
test.after(async () => {
  await prisma.$disconnect();
});

test("I6a eight concurrent checkouts for one unit produce exactly one hold", async () => {
  // §6.1 in one test: the ledger starts EMPTY, which is where a ledger-row lock locks nothing.
  const variantId = await seedVariant("last-unit", { stock: 1 });
  const orderIds = await Promise.all(
    Array.from({ length: 8 }, (_, index) => seedOrder(`race-${index}`)),
  );

  const outcomes = await Promise.all(
    orderIds.map((orderId) =>
      repository.reserveOrderCapacity({ orderId, lines: [{ variantId, quantity: 1 }] }),
    ),
  );

  const accepted = outcomes.filter((outcome) => outcome.ok);
  const refused = outcomes.filter((outcome) => !outcome.ok);

  assert.equal(accepted.length, 1, "exactly one checkout may spend the last unit");
  assert.equal(refused.length, 7);
  for (const outcome of refused) {
    assert.equal(
      outcome.ok === false && outcome.reason,
      "standard-would-go-negative",
      "a loser is refused by the capacity rule, not by a crash or a unique-key collision",
    );
  }

  // The ledger is the real assertion: a refusal that still inserted would be an overshoot the
  // return value hid.
  const rows = await prisma.variantCapacityReservation.findMany({ where: { variantId } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.quantity, 1);
  assert.equal(rows[0]?.state, "RESERVED");
});

test("I6a concurrency holds at an OVERSELL limit, not only at zero", async () => {
  // Stock 0 at a limit of -3 leaves exactly three units. Six concurrent single-unit checkouts must
  // take three and refuse three — a floor that is not zero, so the test cannot pass by a rule that
  // merely refuses everything below zero.
  const variantId = await seedVariant("oversell-floor", {
    stock: 0,
    sellingMode: "OVERSELL",
    negativeStockLimit: -3,
  });
  const orderIds = await Promise.all(
    Array.from({ length: 6 }, (_, index) => seedOrder(`floor-${index}`)),
  );

  const outcomes = await Promise.all(
    orderIds.map((orderId) =>
      repository.reserveOrderCapacity({ orderId, lines: [{ variantId, quantity: 1 }] }),
    ),
  );

  assert.equal(outcomes.filter((outcome) => outcome.ok).length, 3);
  for (const outcome of outcomes.filter((entry) => !entry.ok)) {
    assert.equal(outcome.ok === false && outcome.reason, "negative-limit-reached");
  }

  const held = await prisma.variantCapacityReservation.aggregate({
    where: { variantId },
    _sum: { quantity: true },
  });
  assert.equal(held._sum.quantity, 3, "the owner's -3 allowance is spent exactly once");
});

test("I6a a retry on the same order finds its own hold instead of reserving twice", async () => {
  // §3 — the order is the idempotency key. This is also why a caller's own rows are excluded from
  // activeReservedQuantity: counting them would make a retry refuse its own basket.
  const variantId = await seedVariant("idempotent", { stock: 1 });
  const orderId = await seedOrder("idempotent");

  const first = await repository.reserveOrderCapacity({ orderId, lines: [{ variantId, quantity: 1 }] });
  assert.equal(first.ok, true);
  assert.equal(first.ok === true && first.alreadyHeld, false);

  const retry = await repository.reserveOrderCapacity({ orderId, lines: [{ variantId, quantity: 1 }] });
  assert.equal(retry.ok, true, "a retry must not be refused by its own hold");
  assert.equal(retry.ok === true && retry.alreadyHeld, true);

  assert.equal(await prisma.variantCapacityReservation.count({ where: { variantId } }), 1);
});

test("I6a a basket fails as a unit and leaves no partial hold", async () => {
  const roomy = await seedVariant("multi-roomy", { stock: 5 });
  const empty = await seedVariant("multi-empty", { stock: 0 });
  const orderId = await seedOrder("multi");

  const outcome = await repository.reserveOrderCapacity({
    orderId,
    lines: [
      { variantId: roomy, quantity: 2 },
      { variantId: empty, quantity: 1 },
    ],
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.refusedVariantId, empty);
  assert.equal(
    await prisma.variantCapacityReservation.count({ where: { orderId } }),
    0,
    "the line that fitted must not be held while the order is refused",
  );
});

test("I6a duplicate lines for one variant are merged before the capacity rule sees them", async () => {
  // §7's precondition. Unmerged, each line would see the other excluded from the held quantity and
  // two units could be taken from a one-unit variant.
  const variantId = await seedVariant("duplicate-lines", { stock: 1 });
  const orderId = await seedOrder("duplicate-lines");

  const outcome = await repository.reserveOrderCapacity({
    orderId,
    lines: [
      { variantId, quantity: 1 },
      { variantId, quantity: 1 },
    ],
  });

  assert.equal(outcome.ok, false, "two units from a one-unit variant is a refusal, not two rows");
  assert.equal(await prisma.variantCapacityReservation.count({ where: { orderId } }), 0);

  // Merged and within capacity, it is one row carrying the summed quantity — not two rows, which
  // the (orderId, variantId) key would reject anyway.
  const roomy = await seedVariant("duplicate-roomy", { stock: 4 });
  const roomyOrder = await seedOrder("duplicate-roomy");
  const merged = await repository.reserveOrderCapacity({
    orderId: roomyOrder,
    lines: [
      { variantId: roomy, quantity: 1 },
      { variantId: roomy, quantity: 2 },
    ],
  });
  assert.equal(merged.ok, true);
  assert.equal(merged.ok === true && merged.reservations.length, 1);
  assert.equal(merged.ok === true && merged.reservations[0]?.quantity, 3);
});

test("I6a an unknown variant and an empty basket are fail-closed refusals", async () => {
  const orderId = await seedOrder("fail-closed");
  const variantId = await seedVariant("fail-closed", { stock: 5 });

  const emptyBasket = await repository.reserveOrderCapacity({ orderId, lines: [] });
  assert.equal(emptyBasket.ok, false);
  assert.equal(emptyBasket.ok === false && emptyBasket.reason, "empty-basket");

  // A variant that cannot be locked is never a silently skipped lock — and the line that *could*
  // have been held is not held either.
  const outcome = await repository.reserveOrderCapacity({
    orderId,
    lines: [
      { variantId, quantity: 1 },
      { variantId: "does-not-exist", quantity: 1 },
    ],
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.reason, "variant-missing");
  assert.equal(await prisma.variantCapacityReservation.count({ where: { orderId } }), 0);
});

test("I6a every state change is a guarded compare-and-set", async () => {
  // §6.4 — the enum constrains a value and the §13 CHECKs are intra-row, so nothing in SQL stops an
  // UPDATE moving COMMITTED -> RESERVED. The guard is the only thing that does.
  const variantId = await seedVariant("transitions", { stock: 5 });
  const orderId = await seedOrder("transitions");
  const reserved = await repository.reserveOrderCapacity({
    orderId,
    lines: [{ variantId, quantity: 1 }],
  });
  assert.equal(reserved.ok, true);
  const id = reserved.ok === true ? reserved.reservations[0]!.id : "";

  // A stale expectation loses. RESERVED -> SUBMITTING -> COMMITTED is a legal path, so this is
  // purely the "another worker moved it first" case: a reported conflict, not a silent no-op, and
  // not an error either, because re-reading could legitimately make it succeed.
  assert.equal(
    await repository.transitionReservation({ id, from: "SUBMITTING", to: "COMMITTED" }),
    false,
    "a transition from a state the row is not in must not apply",
  );
  assert.equal(
    (await prisma.variantCapacityReservation.findUniqueOrThrow({ where: { id } })).state,
    "RESERVED",
  );

  assert.equal(await repository.transitionReservation({ id, from: "RESERVED", to: "SUBMITTING" }), true);
  const committedAt = new Date("2026-09-17T02:00:00.000Z");
  assert.equal(
    await repository.transitionReservation({ id, from: "SUBMITTING", to: "COMMITTED", at: committedAt }),
    true,
  );

  const row = await prisma.variantCapacityReservation.findUniqueOrThrow({ where: { id } });
  assert.equal(row.state, "COMMITTED");
  assert.deepEqual(row.committedAt, committedAt, "a terminal state carries its timestamp");
  assert.equal(row.releasedAt, null);

  // Terminal means terminal. This is reported as an ERROR rather than as a lost race, and the
  // difference matters: a lost race is worth re-reading, while COMMITTED -> RESERVED can never
  // succeed however many times it is retried. My first version of this function guarded only
  // staleness and left legality to callers, so `from: "COMMITTED"` resurrected the row — the guard
  // matched, and the update applied.
  for (const to of ["RESERVED", "SUBMITTING", "RELEASED"] as const) {
    await assert.rejects(
      () => repository.transitionReservation({ id, from: "COMMITTED", to }),
      /Illegal reservation transition COMMITTED -> /,
      `COMMITTED -> ${to} must not apply`,
    );
  }
  assert.equal(
    (await prisma.variantCapacityReservation.findUniqueOrThrow({ where: { id } })).state,
    "COMMITTED",
  );
});
