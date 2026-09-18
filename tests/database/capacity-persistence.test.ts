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
import { SellingPolicyError } from "../../src/commerce/capacity-policy-input.ts";
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
  // the ADR §13 `onDelete: Restrict` behaviour under test. The prefix, not the shop, is the scope:
  // I2's shop-scope test deliberately seeds a product into a second shop, and cleaning only
  // `testShopId` would leave it behind to collide with the next run.
  await prisma.variantCapacityReservation.deleteMany({
    where: { variant: { product: { pancakeProductId: { startsWith: externalPrefix } } } },
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

/**
 * I2 — the selling-policy writes.
 *
 * Three things a domain test cannot reach: that the shop scope is actually enforced (the table
 * carries no shop of its own), that the ADR §11 composite restriction is refused at the boundary
 * rather than only at the gate, and that a policy write leaves mirrored stock alone — §5's
 * "turning oversell off preserves the negative value" is a property of what is *not* written.
 */

const otherShopId = 920_081;

async function seedProductForShop(
  key: string,
  shopId: number,
): Promise<{ productId: string; variantId: string }> {
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: shopId,
      pancakeProductId: `${externalPrefix}${key}`,
      slug: `${externalPrefix}${key}`,
      name: key.toUpperCase(),
      syncedAt,
      isPresent: true,
      isActive: true,
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

test("I9 policy writes wait behind the catalog-sync advisory boundary", async () => {
  const { productId } = await seedProductForShop("availability-lock", testShopId);
  const blocker = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  let releaseLock!: () => void;
  let markLocked!: () => void;
  const locked = new Promise<void>((resolve) => {
    markLocked = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  const held = blocker.$transaction(
    async (tx) => {
      // Same existing shop-scoped lock catalog sync takes before reading/writing its mirror. I9
      // policy writes must join this boundary or a sync can read PREORDER and reopen a cycle after
      // an admin has already committed STANDARD.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${1_277_934_572}, ${testShopId})`;
      markLocked();
      await released;
    },
    { timeout: 5_000 },
  );

  await locked;
  let write:
    | Promise<Awaited<ReturnType<typeof repository.saveSellingPolicy>>>
    | null = null;
  try {
    write = repository.saveSellingPolicy({
      shopId: testShopId,
      productId,
      sellingMode: "PREORDER",
      negativeStockLimit: -5,
    });

    const state = await Promise.race([
      write.then(() => "settled" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 250)),
    ]);
    assert.equal(
      state,
      "blocked",
      "policy mutation must not pass the same serialization boundary while catalog sync owns it",
    );
  } finally {
    releaseLock();
    await Promise.allSettled([held, ...(write === null ? [] : [write])]);
    await blocker.$disconnect();
  }

  assert.equal((await repository.readSellingPolicy(productId)).sellingMode, "PREORDER");
});

test("I2 a policy write refuses a product that is not a visible product of this shop", async () => {
  // The foreign key proves the product exists; only this predicate proves whose it is.
  const foreign = await seedProductForShop("other-shop", otherShopId);
  const hidden = await seedProductForShop("withdrawn", testShopId);
  await prisma.productMirror.update({
    where: { id: hidden.productId },
    data: { isActive: false },
  });

  for (const productId of [foreign.productId, hidden.productId, "does-not-exist"]) {
    await assert.rejects(
      () =>
        repository.saveSellingPolicy({
          shopId: testShopId,
          productId,
          sellingMode: "OVERSELL",
          negativeStockLimit: -5,
        }),
      (error: unknown) =>
        error instanceof SellingPolicyError && error.reason === "selling-policy-invalid-product",
    );
    assert.equal(
      await prisma.productSellingPolicy.count({ where: { productId } }),
      0,
      "a refused write must leave no row behind",
    );
  }

  // Clearing is scoped the same way, so it cannot be used to delete another shop's configuration.
  await prisma.productSellingPolicy.create({
    data: { productId: foreign.productId, sellingMode: "PREORDER", negativeStockLimit: -3 },
  });
  await assert.rejects(() =>
    repository.clearSellingPolicy({ shopId: testShopId, productId: foreign.productId }),
  );
  assert.equal(await prisma.productSellingPolicy.count({ where: { productId: foreign.productId } }), 1);
});

test("I2 a composite parent is refused OVERSELL and PREORDER but may be set to STANDARD", async () => {
  const parent = await seedProductForShop("composite-parent", testShopId);
  const child = await seedProductForShop("composite-child", testShopId);
  await prisma.compositeComponentMirror.create({
    data: { parentVariantId: parent.variantId, componentVariantId: child.variantId, quantity: 1, syncedAt },
  });

  for (const sellingMode of ["OVERSELL", "PREORDER"] as const) {
    await assert.rejects(
      () =>
        repository.saveSellingPolicy({
          shopId: testShopId,
          productId: parent.productId,
          sellingMode,
          negativeStockLimit: -5,
        }),
      (error: unknown) =>
        error instanceof SellingPolicyError &&
        error.reason === "selling-policy-composite-restricted",
      `${sellingMode} must be refused for a composite parent`,
    );
  }
  assert.equal(await prisma.productSellingPolicy.count({ where: { productId: parent.productId } }), 0);

  // §11: composite in STANDARD is unaffected — it never goes below zero, so no component
  // accounting is needed. Refusing it too would be a restriction the ADR does not impose.
  const stored = await repository.saveSellingPolicy({
    shopId: testShopId,
    productId: parent.productId,
    sellingMode: "STANDARD",
    negativeStockLimit: -5,
  });
  assert.equal(stored.sellingMode, "STANDARD");

  // The child is an ordinary product and carries no restriction of its own.
  assert.equal(
    (
      await repository.saveSellingPolicy({
        shopId: testShopId,
        productId: child.productId,
        sellingMode: "OVERSELL",
        negativeStockLimit: -5,
      })
    ).sellingMode,
    "OVERSELL",
  );
});

test("I2 a second write replaces the whole row rather than patching it", async () => {
  const { productId } = await seedProductForShop("upsert", testShopId);

  await repository.saveSellingPolicy({
    shopId: testShopId,
    productId,
    sellingMode: "OVERSELL",
    negativeStockLimit: -15,
  });
  const changed = await repository.saveSellingPolicy({
    shopId: testShopId,
    productId,
    sellingMode: "PREORDER",
    negativeStockLimit: -3,
  });

  // The whole row, so a mode change can never land with the previous mode's limit still on it.
  assert.equal(changed.sellingMode, "PREORDER");
  assert.equal(changed.negativeStockLimit, -3);
  assert.equal(changed.isDefault, false);
  assert.equal(await prisma.productSellingPolicy.count({ where: { productId } }), 1);
});

test("I2 clearing returns a product to unconfigured, which is not configured-to-the-default", async () => {
  const { productId } = await seedProductForShop("clear", testShopId);

  await repository.saveSellingPolicy({
    shopId: testShopId,
    productId,
    sellingMode: "STANDARD",
    negativeStockLimit: DEFAULT_NEGATIVE_STOCK_LIMIT,
  });
  // Stored with the default values, and still "configured" — that is the distinction §5.1's
  // `isDefault` exists to carry, so an operator can see what they have actually reviewed.
  assert.equal((await repository.readSellingPolicy(productId)).isDefault, false);

  const cleared = await repository.clearSellingPolicy({ shopId: testShopId, productId });
  assert.equal(cleared.isDefault, true);
  assert.equal(cleared.sellingMode, "STANDARD");
  assert.equal(cleared.negativeStockLimit, DEFAULT_NEGATIVE_STOCK_LIMIT);
  assert.equal(await prisma.productSellingPolicy.count({ where: { productId } }), 0);

  // Idempotent: clearing something already unconfigured is not an error.
  assert.equal(
    (await repository.clearSellingPolicy({ shopId: testShopId, productId })).isDefault,
    true,
  );
});

test("I2 turning oversell off preserves negative mirrored stock", async () => {
  // ADR §5: switching a product back to STANDARD must not reset stock to zero. That holds because
  // this write touches `ProductSellingPolicy` and nothing else — a property of what is not written,
  // which is exactly the kind that decays silently, so it is asserted rather than assumed.
  const { productId, variantId } = await seedProductForShop("negative-stock", testShopId);
  await prisma.warehouseStock.create({
    data: { variantId, pancakeWarehouseId: `${externalPrefix}wh`, quantity: -7, syncedAt },
  });

  await repository.saveSellingPolicy({
    shopId: testShopId,
    productId,
    sellingMode: "OVERSELL",
    negativeStockLimit: -20,
  });
  await repository.saveSellingPolicy({
    shopId: testShopId,
    productId,
    sellingMode: "STANDARD",
    negativeStockLimit: -20,
  });
  await repository.clearSellingPolicy({ shopId: testShopId, productId });

  const stocks = await prisma.warehouseStock.findMany({ where: { variantId }, select: { quantity: true } });
  assert.deepEqual(
    stocks.map((row) => row.quantity),
    [-7],
    "the negative value survives; standard rules block new sales until it is sellable again",
  );
});
