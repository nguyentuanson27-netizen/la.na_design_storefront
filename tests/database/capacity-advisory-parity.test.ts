/**
 * The advisory capacity read model (`capacity-advisory.ts`) against a real database.
 *
 * The claim under test is agreement: a listing card, the `/shop` in-stock SQL filter, a PDP option
 * and a cart line must all see the holds the checkout authority (`reserveOrderCapacity()`) sees, so
 * a unit another order already holds is not advertised as buyable and then refused at checkout. The
 * last test pins the SQL projection to the TypeScript model on shared fixtures, the same way the
 * pricing projection is pinned.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { withAdvisorySellableStock } from "../../src/commerce/capacity-advisory.ts";
import { createCapacityReservationRepository } from "../../src/commerce/capacity-reservation.ts";
import { buildVariantStockCte, createStorefrontCatalogRepository } from "../../src/commerce/storefront-catalog.ts";
import { createStorefrontCartRepository } from "../../src/commerce/storefront-cart-repository.ts";
import type { StorefrontDiscoveryQuery } from "../../src/commerce/storefront-discovery.ts";
import { createStorefrontProductDetailRepository } from "../../src/commerce/storefront-product-detail.ts";
import { Prisma, PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const reservations = createCapacityReservationRepository(prisma);
const catalog = createStorefrontCatalogRepository(prisma);
const detail = createStorefrontProductDetailRepository(prisma);
const cart = createStorefrontCartRepository(prisma);

const P = "advisory-cap";
const SHOP = 920_417;
const OBSERVED = new Date("2026-09-20T00:00:00.000Z");
const NOW = new Date("2026-09-21T00:00:00.000Z");

async function cleanup() {
  await prisma.variantCapacityReservation.deleteMany({
    where: { variant: { product: { pancakeShopId: SHOP } } },
  });
  await prisma.orderMirror.deleteMany({ where: { publicCode: { startsWith: P } } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP } });
}

test.beforeEach(cleanup);
test.afterEach(cleanup);
test.after(async () => prisma.$disconnect());

function query(overrides: Partial<StorefrontDiscoveryQuery> = {}): StorefrontDiscoveryQuery {
  return {
    query: null,
    color: null,
    size: null,
    availability: null,
    minPriceVnd: null,
    maxPriceVnd: null,
    collection: null,
    sort: "name-asc",
    page: 1,
    ...overrides,
  };
}

async function seedProduct(
  key: string,
  options: Readonly<{ isActive?: boolean; sellingMode?: "STANDARD" | "OVERSELL" }> = {},
) {
  return prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP,
      pancakeProductId: `${P}-${key}`,
      slug: `${P}-${key}`,
      name: key.toUpperCase(),
      isPresent: true,
      isActive: options.isActive ?? true,
      syncedAt: OBSERVED,
      ...(options.sellingMode
        ? { sellingPolicy: { create: { sellingMode: options.sellingMode, negativeStockLimit: -20 } } }
        : {}),
    },
    select: { id: true, slug: true },
  });
}

async function seedVariant(
  productId: string,
  key: string,
  stocks: readonly number[],
  options: Readonly<{ isActive?: boolean; isPresent?: boolean }> = {},
) {
  const variant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `${P}-${key}`,
      productId,
      size: "M",
      pancakeRetailPrice: 500_000,
      pancakeRetailPriceAfterDiscount: 500_000,
      isPresent: options.isPresent ?? true,
      isActive: options.isActive ?? true,
      syncedAt: OBSERVED,
    },
    select: { id: true },
  });
  for (const [index, quantity] of stocks.entries()) {
    await prisma.warehouseStock.create({
      data: {
        variantId: variant.id,
        pancakeWarehouseId: `${P}-${key}-wh${index}`,
        quantity,
        syncedAt: OBSERVED,
      },
    });
  }
  return variant.id;
}

async function seedOrder(key: string) {
  const order = await prisma.orderMirror.create({
    data: { publicCode: `${P}-${key}` },
    select: { id: true },
  });
  return order.id;
}

async function hold(key: string, variantId: string, quantity: number) {
  const outcome = await reservations.reserveOrderCapacity({
    orderId: await seedOrder(key),
    lines: [{ variantId, quantity }],
  });
  assert.equal(outcome.ok, true, `fixture hold ${key} must be accepted`);
  return outcome.ok ? outcome.reservations[0]!.id : "";
}

/** What each surface currently says about one variant of one product. */
async function surfaces(slug: string, variantId: string) {
  const card = await catalog.getProductBySlug({ shopId: SHOP, slug });
  const inStock = await catalog.listDiscoveryPage({
    shopId: SHOP,
    pageSize: 24,
    now: NOW,
    discovery: query({ availability: "in-stock" }),
  });
  const pdp = await detail.getProductBySlug({ shopId: SHOP, slug, now: NOW });
  const [line] = await cart.getLines({ shopId: SHOP, items: [{ variantId, quantity: 1 }], now: NOW });
  return {
    cardStock: card?.variants.find((variant) => variant.id === variantId)?.sellableStock,
    listedInStock: inStock.products.some((product) => product.slug === slug),
    pdpPurchasable: pdp?.projection.options.find((option) => option.id === variantId)?.purchasable,
    cartAvailable: line?.available,
  };
}

test("a unit another order holds is sold out on every surface, as the checkout authority says", async () => {
  const product = await seedProduct("tee");
  const variantId = await seedVariant(product.id, "tee-m", [1]);

  assert.deepEqual(await surfaces(product.slug, variantId), {
    cardStock: 1,
    listedInStock: true,
    pdpPurchasable: true,
    cartAvailable: true,
  });

  const heldId = await hold("buyer-a", variantId, 1);

  assert.deepEqual(await surfaces(product.slug, variantId), {
    cardStock: 0,
    listedInStock: false,
    pdpPurchasable: false,
    cartAvailable: false,
  });
  const second = await reservations.reserveOrderCapacity({
    orderId: await seedOrder("buyer-b"),
    lines: [{ variantId, quantity: 1 }],
  });
  assert.equal(second.ok, false, "the authority refuses exactly what the surfaces stopped offering");

  // Releasing the hold gives the unit back everywhere; nothing about it was cached or duplicated.
  assert.equal(
    await reservations.transitionReservation({ id: heldId, from: "RESERVED", to: "RELEASED" }),
    true,
  );
  assert.deepEqual(await surfaces(product.slug, variantId), {
    cardStock: 1,
    listedInStock: true,
    pdpPurchasable: true,
    cartAvailable: true,
  });
});

test("a COMMITTED hold keeps counting until a stock observation that began after the commit", async () => {
  const product = await seedProduct("dress");
  const variantId = await seedVariant(product.id, "dress-m", [1]);
  const heldId = await hold("buyer-a", variantId, 1);
  const committedAt = new Date("2026-09-20T06:00:00.000Z");
  assert.equal(await reservations.transitionReservation({ id: heldId, from: "RESERVED", to: "SUBMITTING" }), true);
  assert.equal(
    await reservations.transitionReservation({ id: heldId, from: "SUBMITTING", to: "COMMITTED", at: committedAt }),
    true,
  );

  // The mirror still carries the pre-order unit: the confirmed order keeps holding it.
  assert.equal((await surfaces(product.slug, variantId)).cardStock, 0);

  // A read that began exactly at the commit proves nothing about it (ties keep holding).
  await prisma.warehouseStock.updateMany({ where: { variantId }, data: { syncedAt: committedAt } });
  assert.equal((await surfaces(product.slug, variantId)).cardStock, 0);

  // A sync that began after the commit observed Pancake's decrement: the mirror now owns it, and the
  // hold stops counting at the same moment the reservation authority stops counting it.
  await prisma.warehouseStock.updateMany({
    where: { variantId },
    data: { quantity: 0, syncedAt: new Date(committedAt.getTime() + 1_000) },
  });
  assert.equal((await surfaces(product.slug, variantId)).cardStock, 0, "no double subtraction");

  // A Pancake restock observed by a later sync reaches every surface.
  await prisma.warehouseStock.updateMany({
    where: { variantId },
    data: { quantity: 2, syncedAt: new Date(committedAt.getTime() + 60_000) },
  });
  assert.deepEqual(await surfaces(product.slug, variantId), {
    cardStock: 2,
    listedInStock: true,
    pdpPurchasable: true,
    cartAvailable: true,
  });
});

test("a FULL SET is offered from its components' free units on the card, PDP, cart and SQL filter", async () => {
  const set = await seedProduct("set");
  const top = await seedProduct("top", { isActive: false });
  const skirt = await seedProduct("skirt", { isActive: false });
  // The parent's own mirrored stock is not what a set sale spends; it must not be advertised.
  const setVariant = await seedVariant(set.id, "set-m", [9]);
  const topVariant = await seedVariant(top.id, "top-m", [3]);
  const skirtVariant = await seedVariant(skirt.id, "skirt-m", [5]);
  await prisma.compositeComponentMirror.createMany({
    data: [
      { parentVariantId: setVariant, componentVariantId: topVariant, quantity: 1, syncedAt: OBSERVED },
      { parentVariantId: setVariant, componentVariantId: skirtVariant, quantity: 1, syncedAt: OBSERVED },
    ],
  });

  assert.equal((await surfaces(set.slug, setVariant)).cardStock, 3);

  // Two other orders hold two tops between them: one as a set, one as a standalone top.
  await hold("set-buyer", setVariant, 1);
  await hold("top-buyer", topVariant, 1);
  assert.deepEqual(await surfaces(set.slug, setVariant), {
    cardStock: 1,
    listedInStock: true,
    pdpPurchasable: true,
    cartAvailable: true,
  });

  await hold("last-top-buyer", topVariant, 1);
  assert.deepEqual(await surfaces(set.slug, setVariant), {
    cardStock: 0,
    listedInStock: false,
    pdpPurchasable: false,
    cartAvailable: false,
  });
  const refused = await reservations.reserveOrderCapacity({
    orderId: await seedOrder("late-set-buyer"),
    lines: [{ variantId: setVariant, quantity: 1 }],
  });
  assert.equal(refused.ok, false);
});

test("the SQL capacity projection agrees with the TypeScript read model", async () => {
  const committedAt = new Date("2026-09-20T06:00:00.000Z");
  const product = await seedProduct("parity", { sellingMode: "OVERSELL" });
  const plain = await seedVariant(product.id, "plain", [4, 2]);
  const released = await seedVariant(product.id, "released", [3]);
  const unknown = await seedVariant(product.id, "unknown", [3]);
  const committedFresh = await seedVariant(product.id, "committed-fresh", [3]);
  const committedStale = await seedVariant(product.id, "committed-stale", [3]);
  const noRows = await seedVariant(product.id, "no-rows", []);
  const fractional = await seedVariant(product.id, "fractional", [2.5]);

  const setProduct = await seedProduct("parity-set");
  const componentProduct = await seedProduct("parity-parts", { isActive: false });
  const setDouble = await seedVariant(setProduct.id, "set-double", [0]);
  const setAbsent = await seedVariant(setProduct.id, "set-absent", [7]);
  const setFractional = await seedVariant(setProduct.id, "set-fractional", [7]);
  const partA = await seedVariant(componentProduct.id, "part-a", [9], { isActive: false });
  const partGone = await seedVariant(componentProduct.id, "part-gone", [9], {
    isActive: false,
    isPresent: false,
  });
  await prisma.compositeComponentMirror.createMany({
    data: [
      { parentVariantId: setDouble, componentVariantId: partA, quantity: 2, syncedAt: OBSERVED },
      { parentVariantId: setAbsent, componentVariantId: partA, quantity: 1, syncedAt: OBSERVED },
      { parentVariantId: setAbsent, componentVariantId: partGone, quantity: 1, syncedAt: OBSERVED },
      { parentVariantId: setFractional, componentVariantId: fractional, quantity: 1, syncedAt: OBSERVED },
    ],
  });

  async function ledger(
    key: string,
    variantId: string,
    quantity: number,
    state: "RELEASED" | "UNKNOWN" | "COMMITTED",
  ) {
    await prisma.variantCapacityReservation.create({
      data: {
        orderId: await seedOrder(key),
        variantId,
        quantity,
        state,
        committedAt: state === "COMMITTED" ? committedAt : null,
        releasedAt: state === "RELEASED" ? committedAt : null,
        resources: { create: [{ variantId, quantity }] },
      },
    });
  }
  await ledger("released", released, 2, "RELEASED");
  await ledger("unknown", unknown, 2, "UNKNOWN");
  await ledger("committed-fresh", committedFresh, 1, "COMMITTED");
  await ledger("committed-stale", committedStale, 1, "COMMITTED");
  await ledger("no-rows", noRows, 2, "COMMITTED");
  await ledger("part-a", partA, 4, "UNKNOWN");
  await prisma.warehouseStock.updateMany({
    where: { variantId: committedStale },
    data: { syncedAt: new Date(committedAt.getTime() + 1_000) },
  });

  const ids = [plain, released, unknown, committedFresh, committedStale, noRows, setDouble, setAbsent, setFractional];
  const sqlRows = await prisma.$queryRaw<{ id: string; sellableStock: number | null }[]>(Prisma.sql`
    ${buildVariantStockCte(NOW)}
    SELECT vb."id", vb."sellableStock" FROM "variant_base" vb WHERE vb."id" IN (${Prisma.join(ids)})
  `);
  const sql = new Map(sqlRows.map((row) => [row.id, row.sellableStock]));

  const mirrored = await prisma.variantMirror.findMany({
    where: { id: { in: ids } },
    select: { id: true, warehouseStocks: { select: { quantity: true } } },
  });
  const [model] = await withAdvisorySellableStock(prisma, SHOP, [
    {
      variants: mirrored.map((variant) => ({
        id: variant.id,
        sellableStock: variant.warehouseStocks.reduce((total, row) => total + row.quantity, 0),
      })),
    },
  ]);
  const ts = new Map(model!.variants.map((variant) => [variant.id, variant.sellableStock]));

  const expected = new Map([
    [plain, 6],
    [released, 3],
    [unknown, 1],
    [committedFresh, 2],
    [committedStale, 3],
    [noRows, -2],
    [setDouble, 2],
    [setAbsent, 0],
    [setFractional, 0],
  ]);
  for (const [id, value] of expected) {
    assert.equal(ts.get(id), value, `TypeScript model for ${id}`);
    assert.equal(sql.get(id), value, `SQL projection for ${id}`);
  }
});
