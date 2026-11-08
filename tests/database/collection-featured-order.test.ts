import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { parseStorefrontDiscoverySearchParams } from "../../src/commerce/storefront-discovery.ts";
import { createStorefrontCatalogRepository } from "../../src/commerce/storefront-catalog.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

/**
 * A collection's pins are ranked in the query, before it cuts a page. Ranking them afterwards, inside
 * the page already cut, cannot bring a pin from what would be page two onto page one.
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const repository = createStorefrontCatalogRepository(prisma);

const SHOP_ID = 920_559;
const suffix = `${process.pid}`;
const collectionSlug = `featured-order-${suffix}`;
const syncedAt = new Date("2026-11-01T00:00:00.000Z");
const PAGE_SIZE = 24;
const slugOf = (n: number) => `fo-${String(n).padStart(2, "0")}-${suffix}`;

async function cleanup() {
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP_ID } });
  await prisma.collectionDefinition.deleteMany({ where: { slug: collectionSlug } });
}

async function seedProduct(n: number, stock: number) {
  const slug = slugOf(n);
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: `${slug}-product`,
      slug,
      // Names sort in the same order as `n`, so the collection's default order is `n` ascending.
      name: `Featured order ${String(n).padStart(2, "0")} ${suffix}`,
      isPresent: true,
      isActive: true,
      syncedAt,
      content: { create: { status: "PUBLISHED", editorialDescription: "x", collectionSlugs: [collectionSlug] } },
    },
  });
  const variant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `${slug}-variant`,
      productId: product.id,
      color: "Ink",
      size: "M",
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 500_000,
      pancakeRetailPriceAfterDiscount: 500_000,
      syncedAt,
    },
  });
  await prisma.warehouseStock.create({
    data: { variantId: variant.id, pancakeWarehouseId: `${slug}-warehouse`, quantity: stock, syncedAt },
  });
}

async function page(pageNumber: number, featuredProductSlugs?: readonly string[], inStockFirst = true) {
  const result = await repository.listDiscoveryPage({
    shopId: SHOP_ID,
    pageSize: PAGE_SIZE,
    discovery: parseStorefrontDiscoverySearchParams({ collection: collectionSlug, sort: "name-asc", page: String(pageNumber) }),
    allowCuratedComponents: true,
    inStockFirst,
    featuredProductSlugs,
    now: new Date("2026-11-08T00:00:00.000Z"),
  });
  return result.products.map((product) => product.slug);
}

test.before(async () => {
  await cleanup();
  await prisma.collectionDefinition.create({
    data: { slug: collectionSlug, title: "Featured order", description: "x", isPublished: true },
  });
  // 25 in-stock products: one more than a page holds.
  for (let n = 1; n <= 25; n += 1) await seedProduct(n, 3);
  // Two sold-out ones, which belong after every in-stock product however they are pinned.
  await seedProduct(26, 0);
  await seedProduct(27, 0);
});
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("without pins the collection keeps its own order, and page two holds what page one did not", async () => {
  const first = await page(1);
  assert.equal(first[0], slugOf(1));
  assert.equal(first.length, PAGE_SIZE);
  const second = await page(2);
  assert.deepEqual(second, [slugOf(25), slugOf(26), slugOf(27)]);
});

test("a product pinned on what would be page two leads page one", async () => {
  const pins = [slugOf(25), slugOf(24)];
  const first = await page(1, pins);
  assert.deepEqual(first.slice(0, 3), [slugOf(25), slugOf(24), slugOf(1)], "pins first, in pinned order, then the default order");

  const second = await page(2, pins);
  const all = [...first, ...second];
  assert.equal(new Set(all).size, all.length, "no product appears on two pages");
  assert.equal(all.length, 27, "none is skipped");
  assert.deepEqual([...all].sort(), Array.from({ length: 27 }, (_, index) => slugOf(index + 1)).sort());
});

test("sold-out products stay after every in-stock one, pinned or not", async () => {
  const first = await page(1, [slugOf(26), slugOf(3)]);
  assert.equal(first[0], slugOf(3), "the in-stock pin leads");
  const second = await page(2, [slugOf(26), slugOf(3)]);
  // The sold-out pin leads its own (sold-out) group, which is last.
  assert.deepEqual(second.slice(-2), [slugOf(26), slugOf(27)]);
  assert.ok(!first.includes(slugOf(26)));
});

test("the first mention of a repeated pin wins, and an unknown slug pins nothing", async () => {
  const first = await page(1, [slugOf(5), slugOf(4), slugOf(5), `no-such-product-${suffix}`]);
  assert.deepEqual(first.slice(0, 3), [slugOf(5), slugOf(4), slugOf(1)]);
});

test("an empty pin list changes nothing", async () => {
  assert.deepEqual(await page(1, []), await page(1));
  assert.deepEqual(await page(1, undefined), await page(1));
});
