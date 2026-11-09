import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import {
  buildShopNextPageInput,
  shopDiscoveryFromInput,
  shopPlpFilters,
} from "../../src/commerce/listing-next-page-input.ts";
import { createStorefrontCatalogRepository } from "../../src/commerce/storefront-catalog.ts";
import {
  parseStorefrontDiscoverySearchParams,
  type StorefrontDiscoveryQuery,
  type StorefrontDiscoverySearchParams,
} from "../../src/commerce/storefront-discovery.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

/**
 * A page appended by "Xem thêm" is the page `?page=N` shows.
 *
 * It reads the real SQL with what the shop route reads (the page's own discovery) and with what the
 * infinite grid's server action reads (the discovery rebuilt from the grid's request), over a catalog
 * whose in-stock and out-of-stock products interleave by name. If the two disagree on the sort, the
 * ORDER BY changes between page 1 and page 2 and products are repeated or skipped at the boundary.
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const repository = createStorefrontCatalogRepository(prisma);
const shopId = 930_031;
const syncedAt = new Date("2026-11-09T02:00:00.000Z");
const PAGE_SIZE = 12;
const PRODUCT_COUNT = 30;

async function cleanup() {
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: shopId } });
}

async function seed() {
  for (let index = 1; index <= PRODUCT_COUNT; index += 1) {
    const label = String(index).padStart(2, "0");
    const product = await prisma.productMirror.create({
      data: {
        pancakeShopId: shopId,
        pancakeProductId: `p31-${label}`,
        slug: `p31-${label}`,
        name: `Scroll Item ${label}`,
        isPresent: true,
        isActive: true,
        syncedAt,
      },
    });
    const variant = await prisma.variantMirror.create({
      data: {
        pancakeVariationId: `p31-${label}-variant`,
        productId: product.id,
        color: "Ink",
        size: "M",
        isPresent: true,
        isActive: true,
        pancakeRetailPrice: 1_000_000,
        pancakeRetailPriceAfterDiscount: 1_000_000,
        syncedAt,
      },
    });
    // Every third product is sold out, so stock and name order disagree all down the list.
    if (index % 3 !== 0) {
      await prisma.warehouseStock.create({
        data: { variantId: variant.id, pancakeWarehouseId: `p31-${label}-warehouse`, quantity: 5, syncedAt },
      });
    }
  }
}

/** What `loadShopRoute` reads for one page of one URL. */
async function readLikeTheRoute(discovery: StorefrontDiscoveryQuery) {
  const page = await repository.listDiscoveryPage({
    shopId,
    discovery,
    pageSize: PAGE_SIZE,
    inStockFirst: discovery.sort === "name-asc",
    now: syncedAt,
  });
  return page.products.map((product) => product.id);
}

test.before(async () => {
  await cleanup();
  await seed();
});

test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

const SHOP_URLS: readonly Readonly<[string, StorefrontDiscoverySearchParams]>[] = [
  ["bare /shop (A-Z, in stock first)", {}],
  ["?sort=default (no in-stock-first)", { sort: "default" }],
  ["?sort=name-desc", { sort: "name-desc" }],
  ["?availability=in-stock", { availability: "in-stock" }],
];

for (const [name, params] of SHOP_URLS) {
  test(`/shop ${name}: pages appended by scrolling are the pages ?page=N shows, with nothing repeated or skipped`, async () => {
    const first = parseStorefrontDiscoverySearchParams(params);
    const everyId: string[] = [];
    let current = first;

    for (let pageNumber = 1; pageNumber <= 3; pageNumber += 1) {
      const direct = await readLikeTheRoute({ ...first, page: pageNumber });
      if (pageNumber === 1) {
        everyId.push(...direct);
        continue;
      }
      // The grid on page N asks for N+1 with what the page handed it.
      const input = buildShopNextPageInput(
        { query: current.query, collection: current.collection },
        shopPlpFilters(current),
        pageNumber,
      );
      const rebuilt = shopDiscoveryFromInput(input);
      const appended = await readLikeTheRoute(rebuilt);

      assert.deepEqual(appended, direct, `page ${pageNumber} appended must equal ?page=${pageNumber}`);
      everyId.push(...appended);
      current = rebuilt;
    }

    assert.equal(new Set(everyId).size, everyId.length, "no product is shown twice");
    const expected =
      params.availability === "in-stock" ? PRODUCT_COUNT - PRODUCT_COUNT / 3 : PRODUCT_COUNT;
    assert.equal(everyId.length, Math.min(expected, PAGE_SIZE * 3), "no product is skipped at a page boundary");
  });
}
