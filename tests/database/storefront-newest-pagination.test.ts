import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createStorefrontCatalogRepository } from "../../src/commerce/storefront-catalog.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

/**
 * `/new-arrivals` reads the catalog in recency order (master spec §10: "shows newest products
 * automatically"). The route used to render an editorial page with no products at all, so what is
 * pinned here is the read it now depends on: newest first, paged, and the same ordering the
 * homepage `Hàng mới về` grid takes its slice from.
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required for database smoke tests");
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

const repository = createStorefrontCatalogRepository(prisma);
const shopId = 910_077;
const syncedAt = new Date("2026-09-11T04:10:00.000Z");

async function cleanup() {
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: shopId } });
}

test.beforeEach(cleanup);
test.afterEach(cleanup);
test.after(async () => prisma.$disconnect());

/** Rows created oldest-first, so insertion order is the reverse of the expected page order. */
async function seedProducts(count: number) {
  for (let index = 0; index < count; index += 1) {
    const ordinal = String(index + 1).padStart(2, "0");
    await prisma.productMirror.create({
      data: {
        pancakeShopId: shopId,
        pancakeProductId: `newest-product-${ordinal}`,
        slug: `newest-product-${ordinal}`,
        name: `Product ${ordinal}`,
        isPresent: true,
        isActive: true,
        syncedAt,
        createdAt: new Date(Date.UTC(2026, 0, index + 1)),
      },
    });
  }
}

test("new-arrivals paging returns the catalog newest first, across pages", async () => {
  await seedProducts(25);

  const firstPage = await repository.listNewestProductPage({ shopId, page: 1, pageSize: 24 });
  assert.equal(firstPage.totalProducts, 25);
  assert.equal(firstPage.totalPages, 2);
  assert.equal(firstPage.page, 1);
  assert.equal(firstPage.products.length, 24);

  // Newest first: the last row created is the first row returned.
  assert.equal(firstPage.products[0]?.slug, "newest-product-25");
  assert.equal(firstPage.products[1]?.slug, "newest-product-24");
  assert.equal(firstPage.products[23]?.slug, "newest-product-02");

  const secondPage = await repository.listNewestProductPage({ shopId, page: 2, pageSize: 24 });
  assert.equal(secondPage.page, 2);
  assert.equal(secondPage.products.length, 1);
  assert.equal(secondPage.products[0]?.slug, "newest-product-01");

  // No product is both on page 1 and page 2, and together they are the whole catalog.
  const slugs = [...firstPage.products, ...secondPage.products].map((product) => product.slug);
  assert.equal(new Set(slugs).size, 25);
});

test("new-arrivals paging agrees with the homepage grid about what newest means", async () => {
  await seedProducts(6);

  const page = await repository.listNewestProductPage({ shopId, page: 1, pageSize: 4 });
  const homepageGrid = await repository.listNewestProducts({ shopId, limit: 4 });

  assert.deepEqual(
    page.products.map((product) => product.slug),
    homepageGrid.map((product) => product.slug),
    "one definition of newest, or the grid and the listing disagree about the same catalog",
  );
});

test("new-arrivals paging hides products the catalog does not publish", async () => {
  await seedProducts(3);
  await prisma.productMirror.updateMany({
    where: { pancakeShopId: shopId, pancakeProductId: "newest-product-03" },
    data: { isActive: false },
  });

  const page = await repository.listNewestProductPage({ shopId, page: 1, pageSize: 24 });
  assert.equal(page.totalProducts, 2, "an inactive product is not a new arrival");
  assert.deepEqual(
    page.products.map((product) => product.slug),
    ["newest-product-02", "newest-product-01"],
  );
});

test("an empty catalog is an empty first page, not a missing one", async () => {
  const page = await repository.listNewestProductPage({ shopId, page: 1, pageSize: 24 });
  assert.equal(page.totalProducts, 0);
  assert.equal(page.totalPages, 0);
  assert.deepEqual(page.products, []);
});
