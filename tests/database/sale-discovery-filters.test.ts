import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import {
  createFlashSaleCatalogRepository,
  type SaleIdPage,
} from "../../src/commerce/flash-sale-catalog.ts";
import { createSaleListingCache } from "../../src/commerce/sale-listing-cache.ts";
import { parseSaleDiscoverySearchParams } from "../../src/commerce/category-discovery-url.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const repository = createFlashSaleCatalogRepository(prisma);
const shopId = 910_061;
const now = new Date("2026-09-16T04:00:00.000Z");
const campaignId = "sale-filters-promotion";

type VariantSpec = Readonly<{ size: string; color: string; priceVnd: number }>;

async function cleanup() {
  await prisma.promotionCampaign.deleteMany({ where: { id: campaignId } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: shopId } });
}

async function createProduct(slug: string, variants: readonly VariantSpec[]) {
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: shopId,
      pancakeProductId: `${slug}-external`,
      slug,
      name: slug,
      isPresent: true,
      isActive: true,
      syncedAt: now,
    },
  });
  for (const [index, spec] of variants.entries()) {
    const suffix = `${slug}-${index}`;
    const variant = await prisma.variantMirror.create({
      data: {
        pancakeVariationId: `${suffix}-variant`,
        productId: product.id,
        color: spec.color,
        size: spec.size,
        isPresent: true,
        isActive: true,
        pancakeRetailPrice: spec.priceVnd,
        pancakeRetailPriceAfterDiscount: spec.priceVnd,
        syncedAt: now,
      },
    });
    await prisma.warehouseStock.create({
      data: { variantId: variant.id, pancakeWarehouseId: `${suffix}-warehouse`, quantity: 2, syncedAt: now },
    });
  }
  return product;
}

/**
 * Four products, all 20% off, so a variant's sale price is 80% of what is written here:
 *   A: M Black 500k (400k)   L Black 500k (400k)
 *   B: S White 300k (240k)
 *   C: M White 900k (720k)
 *   D: M Black 200k (160k)   L Black 1,000k (800k)
 */
async function seed() {
  const a = await createProduct("sale-filter-a", [
    { size: "M", color: "Black", priceVnd: 500_000 },
    { size: "L", color: "Black", priceVnd: 500_000 },
  ]);
  const b = await createProduct("sale-filter-b", [{ size: "S", color: "White", priceVnd: 300_000 }]);
  const c = await createProduct("sale-filter-c", [{ size: "M", color: "White", priceVnd: 900_000 }]);
  const d = await createProduct("sale-filter-d", [
    { size: "M", color: "Black", priceVnd: 200_000 },
    { size: "L", color: "Black", priceVnd: 1_000_000 },
  ]);
  await prisma.promotionCampaign.create({
    data: {
      id: campaignId,
      kind: "PROMOTION",
      name: "Filters promotion",
      discountType: "PERCENTAGE",
      percentageValue: 20,
      isEnabled: true,
      enabledAt: new Date(now.getTime() - 60_000),
      targets: { create: [a, b, c, d].map((product) => ({ productId: product.id })) },
    },
  });
}

async function list(
  params: Record<string, string>,
  { pageSize = 24, repo = repository }: { pageSize?: number; repo?: typeof repository } = {},
) {
  const result = await repo.listSalePage({
    shopId,
    discovery: parseSaleDiscoverySearchParams(params),
    pageSize,
    now,
  });
  return { slugs: result.products.map((product) => product.slug), totalCount: result.totalCount };
}

async function sizes(params: Record<string, string>, repo = repository) {
  return (await repo.listSaleFacets({ shopId, discovery: parseSaleDiscoverySearchParams(params), now })).sizes;
}

test.beforeEach(async () => {
  await cleanup();
  await seed();
});
test.afterEach(cleanup);
test.after(async () => prisma.$disconnect());

test("with no choice the listing is what it always was: every sale product, cheapest representative first", async () => {
  const result = await list({});
  assert.deepEqual(result.slugs, ["sale-filter-d", "sale-filter-b", "sale-filter-a", "sale-filter-c"]);
  assert.equal(result.totalCount, 4);
  assert.deepEqual(await sizes({}), ["S", "M", "L"]);
});

test("size narrows to products with a sale variant of that size, and the count agrees with the page", async () => {
  assert.deepEqual((await list({ size: "M" })).slugs.sort(), ["sale-filter-a", "sale-filter-c", "sale-filter-d"]);
  assert.equal((await list({ size: "M" })).totalCount, 3);
  assert.deepEqual((await list({ size: "s" })).slugs, ["sale-filter-b"]);
  assert.deepEqual((await list({ size: "XXL" })), { slugs: [], totalCount: 0 });
});

test("colour narrows the same way, ignoring case", async () => {
  assert.deepEqual((await list({ color: "white" })).slugs.sort(), ["sale-filter-b", "sale-filter-c"]);
});

test("the price band applies to a variant's sale price, not its list price", async () => {
  // 300k..450k holds A's 400k sale price (list price 500k) and nothing else.
  assert.deepEqual((await list({ minPrice: "300000", maxPrice: "450000" })).slugs, ["sale-filter-a"]);
  assert.deepEqual((await list({ maxPrice: "250000" })).slugs.sort(), ["sale-filter-b", "sale-filter-d"]);
});

test("every choice has to hold on the SAME variant", async () => {
  // M exists on A, C, D and White on B, C: only C is both. L + White matches nothing even though
  // both facts are true of the shop.
  assert.deepEqual((await list({ size: "M", color: "white" })).slugs, ["sale-filter-c"]);
  assert.deepEqual((await list({ size: "L", color: "white" })).slugs, []);
  // D's cheap variant is M; the band that only its L variant could fill still counts D for L...
  assert.deepEqual((await list({ size: "L", minPrice: "700000" })).slugs, ["sale-filter-d"]);
  // ...and does not for M.
  assert.deepEqual((await list({ size: "M", minPrice: "700000" })).slugs, ["sale-filter-c"]);
});

test("the representative price, and so the order, follows the chosen variant", async () => {
  // D's cheapest variant is M (160k), but under size=L it is represented by L (800k), after A's 400k.
  assert.deepEqual((await list({ size: "L" })).slugs, ["sale-filter-a", "sale-filter-d"]);
  assert.deepEqual((await list({ size: "M" })).slugs, ["sale-filter-d", "sale-filter-a", "sale-filter-c"]);
});

test("sort changes the order, and a page boundary never repeats or skips a product", async () => {
  assert.deepEqual((await list({ sort: "price-desc" })).slugs, ["sale-filter-c", "sale-filter-a", "sale-filter-b", "sale-filter-d"]);
  assert.deepEqual((await list({ sort: "name-asc" })).slugs, ["sale-filter-a", "sale-filter-b", "sale-filter-c", "sale-filter-d"]);
  assert.deepEqual((await list({ sort: "name-desc" })).slugs, ["sale-filter-d", "sale-filter-c", "sale-filter-b", "sale-filter-a"]);
  assert.deepEqual((await list({ sort: "price-asc" })).slugs, (await list({})).slugs);

  const pages = [
    ...(await list({ sort: "price-desc", page: "1" }, { pageSize: 3 })).slugs,
    ...(await list({ sort: "price-desc", page: "2" }, { pageSize: 3 })).slugs,
  ];
  assert.deepEqual(pages, ["sale-filter-c", "sale-filter-a", "sale-filter-b", "sale-filter-d"]);
});

test("the size facet leaves its own choice out and keeps the others", async () => {
  // Under White only S and M exist; L is not offered.
  assert.deepEqual(await sizes({ color: "white" }), ["S", "M"]);
  // Picking a size does not narrow the sizes offered, so it can be switched or cleared.
  assert.deepEqual(await sizes({ size: "S" }), ["S", "M", "L"]);
  // A price band that only L variants satisfy offers only L.
  assert.deepEqual(await sizes({ minPrice: "700000", maxPrice: "850000" }), ["M", "L"]);
  // A selected size nothing matches stays offered, so its chip can be switched off.
  assert.deepEqual(await sizes({ size: "XXL", color: "white" }), ["S", "M", "XXL"]);
});

test("a sub-listing narrows the filters to its own campaign kind", async () => {
  const promotion = await repository.listSalePage({
    shopId,
    discovery: parseSaleDiscoverySearchParams({ size: "M" }),
    pageSize: 24,
    kind: "PROMOTION",
    now,
  });
  assert.equal(promotion.totalCount, 3);
  const flash = await repository.listSalePage({
    shopId,
    discovery: parseSaleDiscoverySearchParams({ size: "M" }),
    pageSize: 24,
    kind: "FLASH_SALE",
    now,
  });
  assert.equal(flash.totalCount, 0);
  assert.deepEqual(
    (await repository.listSaleFacets({ shopId, discovery: parseSaleDiscoverySearchParams({}), kind: "FLASH_SALE", now })).sizes,
    [],
  );
});

test("the Xả hàng lẻ size listing accepts the same filters and facets (its extra stock projection is in the statement)", async () => {
  // Nothing in this fixture is CLEARANCE or provably lẻ size, so both are empty; the point is that the
  // wider statement still runs with a size, a colour, a price band and a sort in it.
  const discovery = parseSaleDiscoverySearchParams({ size: "M", color: "black", minPrice: "1", sort: "name-desc" });
  const page = await repository.listSalePage({ shopId, discovery, pageSize: 24, kind: "CLEARANCE", now });
  assert.equal(page.totalCount, 0);
  assert.deepEqual(page.products, []);
  const facets = await repository.listSaleFacets({ shopId, discovery, kind: "CLEARANCE", now });
  assert.deepEqual(facets.sizes, ["M"], "only the selected size, kept so it can be switched off");
});

test("the cache never serves one filter's page or facets to another", async () => {
  const cached = createFlashSaleCatalogRepository(prisma, {
    saleIdPageCache: createSaleListingCache<SaleIdPage>(),
    saleFacetsCache: createSaleListingCache<readonly string[]>(),
  });
  const first = await list({ size: "M" }, { repo: cached });
  const second = await list({ size: "L" }, { repo: cached });
  const third = await list({ size: "M" }, { repo: cached });
  assert.equal(first.totalCount, 3);
  assert.equal(second.totalCount, 2);
  assert.deepEqual(third, first);

  assert.deepEqual(await sizes({ color: "white" }, cached), ["S", "M"]);
  assert.deepEqual(await sizes({}, cached), ["S", "M", "L"]);
  assert.deepEqual(await sizes({ color: "white" }, cached), ["S", "M"]);
});
