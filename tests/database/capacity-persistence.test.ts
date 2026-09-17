/**
 * I1 — the ADR 0014 §13 capacity persistence against a real database.
 *
 * Two things are worth pinning here that a domain test cannot reach: that **no backfill** is safe
 * because the resolver answers absence (not because of a column default, which never fires for a row
 * that does not exist), and that the intra-row CHECK constraints actually reject the rows the ADR
 * says they reject.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { DEFAULT_NEGATIVE_STOCK_LIMIT } from "../../src/commerce/capacity-policy.ts";
import { createCapacityRepository } from "../../src/commerce/capacity-repository.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required for database smoke tests");
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const repository = createCapacityRepository(prisma);

const testShopId = 920_080;
const externalPrefix = "capacity-";
const syncedAt = new Date("2026-09-17T00:00:00.000Z");

async function cleanup() {
  // Reservations restrict deletion of their order and variant, so they go first — which is itself
  // the ADR §13 `onDelete: Restrict` behaviour under test.
  await prisma.variantCapacityReservation.deleteMany({
    where: { variant: { product: { pancakeShopId: testShopId } } },
  });
  await prisma.orderMirror.deleteMany({ where: { publicCode: { startsWith: externalPrefix } } });
  await prisma.productMirror.deleteMany({
    where: { pancakeProductId: { startsWith: externalPrefix } },
  });
}

async function seedProduct(key: string): Promise<{ productId: string; variantId: string }> {
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: testShopId,
      pancakeProductId: `${externalPrefix}${key}`,
      slug: `${externalPrefix}${key}`,
      name: key.toUpperCase(),
      syncedAt,
    },
    select: { id: true },
  });
  const variant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `${externalPrefix}${key}-variant`,
      productId: product.id,
      syncedAt,
    },
    select: { id: true },
  });
  return { productId: product.id, variantId: variant.id };
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

test("I1 a product with no stored policy resolves to STANDARD at the default limit", async () => {
  // The whole basis of "no backfill". The column defaults in the migration never ran for this
  // product, because no row was ever inserted for it.
  const { productId } = await seedProduct("no-policy");

  assert.equal(
    await prisma.productSellingPolicy.count({ where: { productId } }),
    0,
    "the fixture must genuinely have no row",
  );

  const resolved = await repository.readSellingPolicy(productId);
  assert.equal(resolved.sellingMode, "STANDARD");
  assert.equal(resolved.negativeStockLimit, DEFAULT_NEGATIVE_STOCK_LIMIT);
  assert.equal(resolved.isDefault, true);
});

test("I1 a stored policy is returned as stored and is distinguishable from the default", async () => {
  const { productId } = await seedProduct("stored-policy");
  await prisma.productSellingPolicy.create({
    data: { productId, sellingMode: "PREORDER", negativeStockLimit: -5 },
  });

  const resolved = await repository.readSellingPolicy(productId);
  assert.equal(resolved.sellingMode, "PREORDER");
  assert.equal(resolved.negativeStockLimit, -5);
  assert.equal(resolved.isDefault, false);

  // A row written with the same values as the default is still "configured", so an admin surface
  // can show which products an operator has actually reviewed.
  const other = await seedProduct("explicit-default");
  await prisma.productSellingPolicy.create({
    data: {
      productId: other.productId,
      sellingMode: "STANDARD",
      negativeStockLimit: DEFAULT_NEGATIVE_STOCK_LIMIT,
    },
  });
  assert.equal((await repository.readSellingPolicy(other.productId)).isDefault, false);
});

test("I1 a batch read answers for every requested product, including ones with no row", async () => {
  // Built from the requested ids rather than the rows found, so absence cannot silently drop a line
  // from a basket.
  const configured = await seedProduct("batch-configured");
  const bare = await seedProduct("batch-bare");
  await prisma.productSellingPolicy.create({
    data: { productId: configured.productId, sellingMode: "OVERSELL", negativeStockLimit: -3 },
  });

  const policies = await repository.readSellingPolicies([
    configured.productId,
    bare.productId,
    "does-not-exist",
  ]);

  assert.equal(policies.size, 3);
  assert.equal(policies.get(configured.productId)?.sellingMode, "OVERSELL");
  assert.equal(policies.get(bare.productId)?.sellingMode, "STANDARD");
  assert.equal(policies.get("does-not-exist")?.negativeStockLimit, DEFAULT_NEGATIVE_STOCK_LIMIT);
});

test("I1 a positive negative-stock limit is refused by the database", async () => {
  // The limit is an oversell allowance, so a positive value is meaningless. Refused at the gate by
  // `evaluateVariantCapacity` and here as well, because this predicate is intra-row.
  const { productId } = await seedProduct("bad-limit");
  await assert.rejects(() =>
    prisma.productSellingPolicy.create({
      data: { productId, sellingMode: "OVERSELL", negativeStockLimit: 5 },
    }),
  );
});

test("I1 the reservation CHECKs reject every state/timestamp contradiction", async () => {
  const { variantId } = await seedProduct("reservation");
  const orderId = await seedOrder("order-1");
  const committedAt = new Date("2026-09-17T01:00:00.000Z");

  // Biconditional, so BOTH directions are rejected: a terminal state without its timestamp, and a
  // non-terminal state carrying one. The reverse direction is what stops a stale `committedAt`
  // surviving into a non-terminal row and being read later as evidence of a commit.
  const rejected: { label: string; data: Record<string, unknown> }[] = [
    { label: "COMMITTED without committedAt", data: { state: "COMMITTED" } },
    { label: "RELEASED without releasedAt", data: { state: "RELEASED" } },
    { label: "RESERVED carrying committedAt", data: { state: "RESERVED", committedAt } },
    { label: "SUBMITTING carrying releasedAt", data: { state: "SUBMITTING", releasedAt: committedAt } },
    {
      label: "both outcomes at once",
      data: { state: "COMMITTED", committedAt, releasedAt: committedAt },
    },
    { label: "zero quantity", data: { state: "RESERVED", quantity: 0 } },
    { label: "negative quantity", data: { state: "RESERVED", quantity: -1 } },
  ];

  for (const { label, data } of rejected) {
    await assert.rejects(
      () =>
        prisma.variantCapacityReservation.create({
          data: { orderId, variantId, quantity: 1, ...data } as never,
        }),
      `${label} must be refused`,
    );
  }

  // The legitimate shapes are accepted.
  const reserved = await prisma.variantCapacityReservation.create({
    data: { orderId, variantId, quantity: 2, state: "RESERVED" },
    select: { id: true },
  });
  await prisma.variantCapacityReservation.update({
    where: { id: reserved.id },
    data: { state: "COMMITTED", committedAt },
  });
});

test("I1 one order may hold at most one reservation per variant", async () => {
  // The §3 idempotency backstop and the §7 duplicate-line backstop are the same unique key: a retry
  // that reuses the order finds its own row instead of creating a second hold.
  const { variantId } = await seedProduct("idempotent");
  const orderId = await seedOrder("order-idem");

  await prisma.variantCapacityReservation.create({ data: { orderId, variantId, quantity: 1 } });
  await assert.rejects(() =>
    prisma.variantCapacityReservation.create({ data: { orderId, variantId, quantity: 1 } }),
  );
});

test("I1 a held reservation blocks deletion of its order and its variant", async () => {
  // `onDelete: Restrict` on both sides. Cascading would silently free capacity that is still
  // counting — the outcome §15 prohibits when it rules out dropping the ledger as a rollback.
  const { productId, variantId } = await seedProduct("restrict");
  const orderId = await seedOrder("order-restrict");
  await prisma.variantCapacityReservation.create({
    data: { orderId, variantId, quantity: 1, state: "UNKNOWN" },
  });

  await assert.rejects(
    () => prisma.orderMirror.delete({ where: { id: orderId } }),
    "a hard-deleted order must not take a live hold with it",
  );
  await assert.rejects(
    () => prisma.variantMirror.delete({ where: { id: variantId } }),
    "a deleted variant must not silently free capacity",
  );
  // The product cascades to the variant, so it is refused for the same reason.
  await assert.rejects(() => prisma.productMirror.delete({ where: { id: productId } }));
});

test("I1 the held-quantity read counts the unambiguous holds only", async () => {
  const { variantId } = await seedProduct("held");
  const committedAt = new Date("2026-09-17T01:00:00.000Z");

  for (const [key, data] of [
    ["reserved", { quantity: 2, state: "RESERVED" as const }],
    ["submitting", { quantity: 3, state: "SUBMITTING" as const }],
    ["unknown", { quantity: 4, state: "UNKNOWN" as const }],
    ["released", { quantity: 5, state: "RELEASED" as const, releasedAt: committedAt }],
    ["committed", { quantity: 6, state: "COMMITTED" as const, committedAt }],
  ] as const) {
    await prisma.variantCapacityReservation.create({
      data: { orderId: await seedOrder(`order-${key}`), variantId, ...data },
    });
  }

  // 2 + 3 + 4. `RELEASED` never holds; `COMMITTED` is excluded here on purpose — whether it still
  // holds depends on the mirror catching up (§4.1), which is `reservationHoldsCapacity()`'s call,
  // not a SQL filter's. Reporting only the unambiguous holds is honest; rounding would not be.
  assert.equal(await repository.sumUnambiguouslyHeldQuantity(variantId), 9);
});
