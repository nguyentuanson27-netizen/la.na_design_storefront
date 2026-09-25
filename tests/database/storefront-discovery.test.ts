import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createStorefrontCatalogRepository } from "../../src/commerce/storefront-catalog.ts";
import { parseStorefrontDiscoverySearchParams } from "../../src/commerce/storefront-discovery.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const repository = createStorefrontCatalogRepository(prisma);
const shopId = 930_013;
const otherShopId = 930_014;
const syncedAt = new Date("2026-08-13T02:00:00.000Z");

async function cleanup() {
  await prisma.productMirror.deleteMany({
    where: { pancakeShopId: { in: [shopId, otherShopId] } },
  });
  await prisma.collectionDefinition.deleteMany({
    where: { slug: { in: ["city-uniform", "essentials", "unpub-col"] } },
  });
}

async function seedProduct(input: {
  shopId?: number;
  id: string;
  name: string;
  collectionSlugs?: string[];
  contentStatus?: "DRAFT" | "REVIEWED" | "PUBLISHED";
  color: string;
  size: string;
  price: number;
  discountedPrice?: number;
  stock: number;
  active?: boolean;
}) {
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: input.shopId ?? shopId,
      pancakeProductId: `t13-${input.id}`,
      slug: `t13-${input.id}`,
      name: input.name,
      isPresent: true,
      isActive: input.active ?? true,
      syncedAt,
      content: input.collectionSlugs
        ? {
            create: {
              status: input.contentStatus ?? "PUBLISHED",
              collectionSlugs: input.collectionSlugs,
            },
          }
        : undefined,
    },
  });
  const variant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `t13-${input.id}-variant`,
      productId: product.id,
      color: input.color,
      size: input.size,
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: input.price,
      pancakeRetailPriceAfterDiscount: input.discountedPrice ?? input.price,
      syncedAt,
    },
  });
  if (input.stock > 0) {
    await prisma.warehouseStock.create({
      data: {
        variantId: variant.id,
        pancakeWarehouseId: `t13-${input.id}-warehouse`,
        quantity: input.stock,
        syncedAt,
      },
    });
  }
  return product;
}

async function seedVariant(input: {
  productId: string;
  id: string;
  color: string;
  size: string;
  price: number;
  stock: number;
}) {
  const variant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `t13-${input.id}-variant`,
      productId: input.productId,
      color: input.color,
      size: input.size,
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: input.price,
      pancakeRetailPriceAfterDiscount: input.price,
      syncedAt,
    },
  });

  if (input.stock > 0) {
    await prisma.warehouseStock.create({
      data: {
        variantId: variant.id,
        pancakeWarehouseId: `t13-${input.id}-warehouse`,
        quantity: input.stock,
        syncedAt,
      },
    });
  }
}

test.beforeEach(async () => {
  await cleanup();
  await prisma.collectionDefinition.upsert({
    where: { slug: "city-uniform" },
    create: {
      slug: "city-uniform",
      title: "City Uniform",
      description: "City uniform collection.",
      seoTitle: "City Uniform",
      seoDescription: "City uniform",
      isPublished: true,
      pancakeCategoryIds: [],
    },
    update: { isPublished: true, title: "City Uniform" },
  });
  await prisma.collectionDefinition.upsert({
    where: { slug: "essentials" },
    create: {
      slug: "essentials",
      title: "Essentials",
      description: "Essentials collection.",
      seoTitle: "Essentials",
      seoDescription: "Essentials",
      isPublished: true,
      pancakeCategoryIds: [],
    },
    update: { isPublished: true, title: "Essentials" },
  });
  await seedProduct({
    id: "linen-overshirt",
    name: "Linen Overshirt",
    collectionSlugs: ["city-uniform"],
    color: "Black",
    size: "M",
    price: 600_000,
    stock: 2,
  });
  await seedProduct({
    id: "stone-trouser",
    name: "Stone Trouser",
    collectionSlugs: ["essentials"],
    color: "Stone",
    size: "L",
    price: 450_000,
    stock: 0,
  });
  await seedProduct({
    id: "olive-shirt",
    name: "Olive Shirt",
    collectionSlugs: ["city-uniform"],
    color: "Olive",
    size: "M",
    price: 700_000,
    discountedPrice: 650_000,
    stock: 3,
  });
  await seedProduct({
    id: "other-shop",
    shopId: otherShopId,
    name: "Other Shop Black Shirt",
    collectionSlugs: ["city-uniform"],
    color: "Black",
    size: "M",
    price: 100_000,
    stock: 5,
  });
  await seedProduct({
    id: "inactive",
    name: "Inactive Black Shirt",
    collectionSlugs: ["city-uniform"],
    color: "Black",
    size: "M",
    price: 200_000,
    stock: 5,
    active: false,
  });
});

test.afterEach(cleanup);
test.after(async () => prisma.$disconnect());

test("discovery combines search, same-variant filters and website-owned collection membership", async () => {
  const discovery = parseStorefrontDiscoverySearchParams({
    q: "linen",
    color: "Black",
    size: "M",
    availability: "in-stock",
    minPrice: "500000",
    maxPrice: "700000",
    collection: "city-uniform",
  });

  const page = await repository.listDiscoveryPage({ shopId, pageSize: 24, discovery });
  assert.equal(page.totalCount, 1);
  assert.deepEqual(page.products.map(({ name }) => name), ["Linen Overshirt"]);
  assert.equal(page.hasPrevious, false);
  assert.equal(page.hasNext, false);
});

test("discovery requires color, size, stock and price to match the same live variant", async () => {
  const splitMatchProduct = await seedProduct({
    id: "split-match",
    name: "Split Match Jacket",
    collectionSlugs: ["city-uniform"],
    color: "Black",
    size: "L",
    price: 400_000,
    stock: 0,
  });
  await seedVariant({
    productId: splitMatchProduct.id,
    id: "split-match-stocked-medium",
    color: "Navy",
    size: "M",
    price: 600_000,
    stock: 3,
  });

  const colorOnly = await repository.listDiscoveryPage({
    shopId,
    pageSize: 24,
    discovery: parseStorefrontDiscoverySearchParams({ color: "Black" }),
  });
  assert.equal(colorOnly.products.some(({ name }) => name === "Split Match Jacket"), true);

  const sizeStockAndPrice = await repository.listDiscoveryPage({
    shopId,
    pageSize: 24,
    discovery: parseStorefrontDiscoverySearchParams({
      size: "M",
      availability: "in-stock",
      minPrice: "500000",
      maxPrice: "700000",
    }),
  });
  assert.equal(
    sizeStockAndPrice.products.some(({ name }) => name === "Split Match Jacket"),
    true,
  );

  const combined = await repository.listDiscoveryPage({
    shopId,
    pageSize: 24,
    discovery: parseStorefrontDiscoverySearchParams({
      color: "Black",
      size: "M",
      availability: "in-stock",
      minPrice: "500000",
      maxPrice: "700000",
      collection: "city-uniform",
    }),
  });

  assert.deepEqual(combined.products.map(({ name }) => name), ["Linen Overshirt"]);
  assert.equal(combined.products.some(({ name }) => name === "Split Match Jacket"), false);
});

test("U16 price discovery selects on the website-owned effective price", async () => {
  // Olive Shirt carries a Pancake after-discount field (650,000) below its retail price
  // (700,000). The old equality gate treated that as unpriceable, so it was invisible to every
  // price filter. W3's accepted evidence established the after-discount field is not authoritative
  // for website pricing, so the product now filters at its real 700,000 base and appears here.
  const discovery = parseStorefrontDiscoverySearchParams({
    minPrice: "600000",
    maxPrice: "800000",
    collection: "city-uniform",
    sort: "price-asc",
  });

  const page = await repository.listDiscoveryPage({ shopId, pageSize: 24, discovery });
  assert.deepEqual(page.products.map(({ name }) => name), ["Linen Overshirt", "Olive Shirt"]);
});

test("U16 price sorting ranks every priceable product on its effective price", async () => {
  const ascending = await repository.listDiscoveryPage({
    shopId,
    pageSize: 24,
    discovery: parseStorefrontDiscoverySearchParams({ sort: "price-asc" }),
  });
  assert.deepEqual(ascending.products.map(({ name }) => name), [
    "Stone Trouser",
    "Linen Overshirt",
    "Olive Shirt",
  ]);

  const descending = await repository.listDiscoveryPage({
    shopId,
    pageSize: 24,
    discovery: parseStorefrontDiscoverySearchParams({ sort: "price-desc" }),
  });
  // Descending now leads with Olive Shirt at its real 700,000 rather than stranding it behind the
  // priced products, which is the same W3 consequence seen from the other end of the sort.
  assert.deepEqual(descending.products.map(({ name }) => name), [
    "Olive Shirt",
    "Linen Overshirt",
    "Stone Trouser",
  ]);
});

test("the default sort orders overlapping categories differently behind their hand-set positions", async () => {
  // Áo dài, Áo dài cách tân and Áo dài Tết share most of their products; each falls back to a
  // different order so moving between them does not show the same grid three times.
  const createdAt = {
    "t13-linen-overshirt": new Date("2026-08-01T00:00:00.000Z"),
    "t13-stone-trouser": new Date("2026-08-03T00:00:00.000Z"),
    "t13-olive-shirt": new Date("2026-08-02T00:00:00.000Z"),
  };
  for (const [slug, at] of Object.entries(createdAt)) {
    await prisma.productMirror.update({ where: { slug }, data: { createdAt: at } });
  }

  const namesFor = async (categoryKey: string) =>
    (
      await repository.listDiscoveryPage({
        shopId,
        pageSize: 24,
        discovery: { ...parseStorefrontDiscoverySearchParams({}), sort: "default", categoryKey },
      })
    ).products.map(({ name }) => name);

  assert.deepEqual(await namesFor("aoDai"), ["Stone Trouser", "Olive Shirt", "Linen Overshirt"]);
  assert.deepEqual(await namesFor("aoDaiCachTan"), ["Linen Overshirt", "Olive Shirt", "Stone Trouser"]);

  // Tết is shuffled: every product once, in an order that is stable between requests and follows
  // the category-keyed hash rather than any column.
  const products = await prisma.productMirror.findMany({
    where: { pancakeShopId: shopId, isActive: true },
    select: { id: true, name: true },
  });
  const md5 = (text: string) => createHash("md5").update(text).digest("hex");
  const shuffled = products
    .map((product) => ({ name: product.name, hash: md5(`aoDaiTet:${product.id}`) }))
    .sort((left, right) => (left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0))
    .map(({ name }) => name);
  assert.deepEqual(await namesFor("aoDaiTet"), shuffled);
  assert.deepEqual(await namesFor("aoDaiTet"), shuffled);

  // A hand-set position still leads; the configured order only ranks what is left.
  const lead = shuffled.at(-1)!;
  const leadProduct = products.find(({ name }) => name === lead)!;
  await prisma.categoryProductOrder.create({
    data: { categoryKey: "aoDaiTet", productId: leadProduct.id, position: 0 },
  });
  assert.deepEqual(await namesFor("aoDaiTet"), [lead, ...shuffled.slice(0, -1)]);
});

test("discovery facets stay scoped to visible products in the configured shop", async () => {
  const facets = await repository.listDiscoveryFacets({ shopId });
  assert.deepEqual(facets.colors, ["Black", "Olive", "Stone"]);
  assert.deepEqual(facets.sizes, ["M", "L"]);
  assert.deepEqual(facets.collections, ["city-uniform", "essentials"]);
});

test("discovery collection filter requires published CollectionDefinition while preserving draft content membership", async () => {
  await prisma.collectionDefinition.upsert({
    where: { slug: "unpub-col" },
    create: {
      slug: "unpub-col",
      title: "Unpublished Collection",
      description: "Unpublished.",
      seoTitle: "Unpub",
      seoDescription: "Unpub",
      isPublished: false,
      pancakeCategoryIds: [],
    },
    update: { isPublished: false, title: "Unpublished Collection" },
  });

  // (a) DRAFT ProductContent with valid published collection slug -> participates in collection membership
  await seedProduct({
    id: "draft-content-product",
    name: "Draft Content Product",
    collectionSlugs: ["city-uniform"],
    contentStatus: "DRAFT",
    color: "Black",
    size: "M",
    price: 500_000,
    stock: 2,
  });

  // (b) PUBLISHED ProductContent referencing an unpublished collection -> must not match
  await seedProduct({
    id: "unpub-col-product",
    name: "Unpublished Collection Product",
    collectionSlugs: ["unpub-col"],
    contentStatus: "PUBLISHED",
    color: "Black",
    size: "M",
    price: 500_000,
    stock: 2,
  });

  // (a) check: draft content with published collection slug is included in collection filter
  const cityFiltered = await repository.listDiscoveryPage({
    shopId,
    pageSize: 24,
    discovery: parseStorefrontDiscoverySearchParams({ collection: "city-uniform" }),
  });
  assert.equal(
    cityFiltered.products.some(({ name }) => name === "Draft Content Product"),
    true,
  );
  assert.equal(
    cityFiltered.products.some(({ name }) => name === "Linen Overshirt"),
    true,
  );

  // (b) check: content referencing unpublished collection returns 0 products and is omitted from facets
  const unpubFiltered = await repository.listDiscoveryPage({
    shopId,
    pageSize: 24,
    discovery: parseStorefrontDiscoverySearchParams({ collection: "unpub-col" }),
  });
  assert.equal(unpubFiltered.totalCount, 0);
  assert.equal(unpubFiltered.products.length, 0);

  const facets = await repository.listDiscoveryFacets({ shopId });
  assert.equal(facets.collections.includes("unpub-col"), false);

  // (c) check: published collection filters normally
  const essentialsFiltered = await repository.listDiscoveryPage({
    shopId,
    pageSize: 24,
    discovery: parseStorefrontDiscoverySearchParams({ collection: "essentials" }),
  });
  assert.equal(essentialsFiltered.totalCount, 1);
  assert.deepEqual(essentialsFiltered.products.map(({ name }) => name), ["Stone Trouser"]);
});
