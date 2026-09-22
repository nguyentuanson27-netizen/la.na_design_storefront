/**
 * U16 / P7a — `/shop` filters and orders by *effective* price, before pagination.
 *
 * The reason this must happen in SQL is the ordering of operations: a TypeScript pass can only
 * reprice the page it was given, so a discounted product that belongs on page 1 would already have
 * been left on page 3 by the time it was seen. These tests assert the decision is made on the
 * promoted price, not the base one.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../src/generated/prisma/client.ts";
import { createStorefrontCatalogRepository } from "../../src/commerce/storefront-catalog.ts";
import { buildStorefrontVariantOptions, getStorefrontResolvedPriceRange } from "../../src/commerce/storefront-product.ts";
import type { StorefrontDiscoveryQuery } from "../../src/commerce/storefront-discovery.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const repository = createStorefrontCatalogRepository(prisma);

const P = "u16-disc";
const SHOP = 920_952;
const NOW = new Date("2026-09-15T00:00:00.000Z");

function query(overrides: Partial<StorefrontDiscoveryQuery> = {}): StorefrontDiscoveryQuery {
  return {
    query: null, collection: null, color: null, size: null,
    inStockOnly: false, minPriceVnd: null, maxPriceVnd: null,
    page: 1, sort: "name-asc", ...overrides,
  } as StorefrontDiscoveryQuery;
}

async function cleanup() {
  await prisma.$executeRaw`DELETE FROM "PromotionTarget" WHERE "id" LIKE ${`${P}-%`}`;
  await prisma.$executeRaw`DELETE FROM "PromotionCampaign" WHERE "id" LIKE ${`${P}-%`}`;
  await prisma.$executeRaw`DELETE FROM "ProductMirror" WHERE "pancakeProductId" LIKE ${`${P}-%`}`;
}

async function seedProduct(key: string, name: string, price: number) {
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP, pancakeProductId: `${P}-${key}`, slug: `${P}-${key}`,
      name, isPresent: true, isActive: true, syncedAt: NOW,
    },
  });
  const variant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `${P}-pv-${key}`, productId: product.id, color: "Đen", size: "M",
      pancakeRetailPrice: price, pancakeRetailPriceAfterDiscount: price - 1,
      isPresent: true, isActive: true, syncedAt: NOW,
    },
  });
  await prisma.warehouseStock.create({
    data: { variantId: variant.id, pancakeWarehouseId: `${P}-wh`, quantity: 9, syncedAt: NOW },
  });
  return { product, variant };
}

async function discount(key: string, productId: string, percentageValue: number) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "PromotionCampaign"
       ("id","kind","name","discountType","percentageValue","isEnabled","enabledAt","createdAt","updatedAt")
     VALUES ($1,'PROMOTION'::"PromotionCampaignKind",$2,'PERCENTAGE'::"PromotionDiscountType",$3,true,$4,$4,$4)`,
    `${P}-${key}`, `U16 ${key}`, percentageValue, NOW,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "PromotionTarget" ("id","campaignId","productId","createdAt") VALUES ($1,$2,$3,$4)`,
    `${P}-t-${key}`, `${P}-${key}`, productId, NOW,
  );
}

/**
 * "Expensive" is 900,000 with a 50% campaign, so its effective price is 450,000 — below "Cheap"
 * at 500,000. Every assertion below distinguishes the two orderings.
 */
async function seedDiscountedCatalog() {
  const cheap = await seedProduct("cheap", "U16 AAA Cheap", 500_000);
  const expensive = await seedProduct("expensive", "U16 BBB Expensive", 900_000);
  await discount("camp-expensive", expensive.product.id, 50);
  return { cheap, expensive };
}

test("U16 price sorting ranks by effective price, not by base price", async () => {
  await cleanup();
  await seedDiscountedCatalog();
  try {
    const page = await repository.listDiscoveryPage({
      shopId: SHOP, pageSize: 24, now: NOW, discovery: query({ sort: "price-asc" }),
    });

    const slugs = page.products.map((product) => product.slug);
    assert.deepEqual(
      slugs,
      [`${P}-expensive`, `${P}-cheap`],
      "the discounted 900,000 product sorts first at its effective 450,000",
    );
  } finally {
    await cleanup();
  }
});

test("U16 a price filter selects on the effective price", async () => {
  await cleanup();
  await seedDiscountedCatalog();
  try {
    // 450,000 (effective) is inside this band; the 900,000 base is not.
    const inBand = await repository.listDiscoveryPage({
      shopId: SHOP, pageSize: 24, now: NOW,
      discovery: query({ minPriceVnd: 400_000, maxPriceVnd: 460_000 }),
    });
    assert.deepEqual(
      inBand.products.map((product) => product.slug),
      [`${P}-expensive`],
      "the discounted product is found at its effective price",
    );
    assert.equal(inBand.totalCount, 1, "the count is computed on the same projection as the page");

    // Filtering at the undiscounted base must now find nothing.
    const atBase = await repository.listDiscoveryPage({
      shopId: SHOP, pageSize: 24, now: NOW,
      discovery: query({ minPriceVnd: 890_000, maxPriceVnd: 910_000 }),
    });
    assert.deepEqual(atBase.products, [], "the base price is no longer what the filter sees");
  } finally {
    await cleanup();
  }
});

test("U16 sale filtering uses the same effective-price projection as listing count", async () => {
  await cleanup();
  await seedDiscountedCatalog();
  try {
    const page = await repository.listDiscoveryPage({
      shopId: SHOP,
      pageSize: 24,
      now: NOW,
      discovery: query({ sale: true }),
    });

    assert.deepEqual(
      page.products.map((product) => product.slug),
      [`${P}-expensive`],
      "sale filtering must keep only products whose resolved price is below their base price",
    );
    assert.equal(page.totalCount, 1, "sale count must use the same effective-price predicate");
  } finally {
    await cleanup();
  }
});

test("U16 filtering happens before pagination, so a discounted product reaches page one", async () => {
  await cleanup();
  try {
    // Three cheap products would fill a one-per-page listing ahead of the expensive one if the
    // sort used base prices; with effective pricing the discounted product leads.
    for (const [index, name] of ["AAA", "BBB", "CCC"].entries()) {
      await seedProduct(`filler-${index}`, `U16 ${name} Filler`, 600_000 + index);
    }
    const { product } = await seedProduct("promoted", "U16 ZZZ Promoted", 1_000_000);
    await discount("camp-promoted", product.id, 90); // effective 100,000

    const firstPage = await repository.listDiscoveryPage({
      shopId: SHOP, pageSize: 1, now: NOW, discovery: query({ sort: "price-asc", page: 1 }),
    });

    assert.equal(firstPage.totalCount, 4);
    assert.deepEqual(
      firstPage.products.map((entry) => entry.slug),
      [`${P}-promoted`],
      "the deepest discount must occupy page one of a price-ascending listing",
    );
  } finally {
    await cleanup();
  }
});

test("U16 a scheduled campaign does not move the listing until its window opens", async () => {
  await cleanup();
  await seedDiscountedCatalog();
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE "PromotionCampaign" SET "startsAt" = $1, "endsAt" = $2 WHERE "id" = $3`,
      new Date("2026-09-20T00:00:00.000Z"), new Date("2026-09-25T00:00:00.000Z"), `${P}-camp-expensive`,
    );

    const before = await repository.listDiscoveryPage({
      shopId: SHOP, pageSize: 24, now: NOW, discovery: query({ sort: "price-asc" }),
    });
    assert.deepEqual(
      before.products.map((entry) => entry.slug),
      [`${P}-cheap`, `${P}-expensive`],
      "outside the window the base price orders the listing",
    );

    const during = await repository.listDiscoveryPage({
      shopId: SHOP, pageSize: 24,
      now: new Date("2026-09-21T00:00:00.000Z"),
      discovery: query({ sort: "price-asc" }),
    });
    assert.deepEqual(
      during.products.map((entry) => entry.slug),
      [`${P}-expensive`, `${P}-cheap`],
      "the same facts reorder once the window is open",
    );
  } finally {
    await cleanup();
  }
});

test("U16 the card price the page hydrates matches the projection that ranked it", async () => {
  await cleanup();
  await seedDiscountedCatalog();
  try {
    const page = await repository.listDiscoveryPage({
      shopId: SHOP, pageSize: 24, now: NOW, discovery: query({ sort: "price-asc" }),
    });

    const promoted = page.products.find((entry) => entry.slug === `${P}-expensive`)!;
    const options = buildStorefrontVariantOptions(promoted.variants, page.pricingRule);
    const range = getStorefrontResolvedPriceRange(options);

    assert.equal(
      range?.minimum,
      450_000,
      "the card must show the effective price the sort used, not the base",
    );
    assert.equal(options[0]!.isDiscounted, true);
    assert.equal(options[0]!.basePriceVnd, 900_000);
  } finally {
    await cleanup();
  }
});

test("U16 a card stays a product-level impression even when a sale variant supplies its price", async () => {
  await cleanup();
  const { expensive } = await seedDiscountedCatalog();
  try {
    const page = await repository.listDiscoveryPage({
      shopId: SHOP, pageSize: 24, now: NOW, discovery: query({ sort: "price-asc" }),
    });
    const promoted = page.products.find((entry) => entry.slug === `${P}-expensive`)!;

    // T4: one card is one product impression. The representative display price coming from a
    // discounted variation must not promote that variation's id to the card's identity.
    assert.equal(promoted.pancakeProductId, `${P}-expensive`);
    assert.notEqual(
      promoted.pancakeProductId as string,
      `${P}-pv-expensive`,
      "a variation id must never become the product-level analytics identity",
    );
    assert.equal(expensive.variant.pancakeVariationId, `${P}-pv-expensive`);
  } finally {
    await cleanup();
  }
});

test("U16 a genuinely unpriceable product stays browseable and sorts last in both directions", async () => {
  // The shared discovery fixture no longer contains an unresolved product now that the equality
  // gate is gone, so the NULLS LAST guarantee is re-covered here with a base price that is
  // genuinely unusable rather than merely drifted.
  await cleanup();
  try {
    await seedProduct("priced", "U16 AAA Priced", 500_000);

    const product = await prisma.productMirror.create({
      data: {
        pancakeShopId: SHOP, pancakeProductId: `${P}-unpriced`, slug: `${P}-unpriced`,
        name: "U16 ZZZ Unpriced", isPresent: true, isActive: true, syncedAt: NOW,
      },
    });
    const variant = await prisma.variantMirror.create({
      data: {
        pancakeVariationId: `${P}-pv-unpriced`, productId: product.id, color: "Đen", size: "M",
        pancakeRetailPrice: null, pancakeRetailPriceAfterDiscount: null,
        isPresent: true, isActive: true, syncedAt: NOW,
      },
    });
    await prisma.warehouseStock.create({
      data: { variantId: variant.id, pancakeWarehouseId: `${P}-wh`, quantity: 4, syncedAt: NOW },
    });

    for (const sort of ["price-asc", "price-desc"] as const) {
      const page = await repository.listDiscoveryPage({
        shopId: SHOP, pageSize: 24, now: NOW, discovery: query({ sort }),
      });
      assert.equal(page.totalCount, 2, `${sort}: an unpriceable product stays browseable`);
      assert.equal(
        page.products.at(-1)!.slug,
        `${P}-unpriced`,
        `${sort}: an unpriceable product sorts last rather than first`,
      );
    }
  } finally {
    await cleanup();
  }
});

test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});
