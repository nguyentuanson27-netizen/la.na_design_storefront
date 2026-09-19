/**
 * Review regression: the homepage's two priced grids each own a freshness window.
 *
 * `listConfiguredHomepageFeaturedWithPricing()` resolved a promotion refresh and then dropped it,
 * so `loadHomeRoute()` could only seal the `Hàng mới về` window. Whenever a campaign boundary fell
 * inside Featured and nowhere near new arrivals -- which is the normal case, since Featured is a
 * hand-picked list and new arrivals is a recency read -- the page held the stale Featured price
 * until the 60s ceiling instead of refreshing at the boundary.
 *
 * This pins the halves the pure tests cannot see: that the Featured read *reports* a window at
 * all, and that the two reads genuinely disagree on the same data.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { MAX_STOREFRONT_PROMOTION_REFRESH_MS } from "../../src/commerce/storefront-promotion-freshness.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const P = "home-fresh";
const SHOP = 920_961;
const NOW = new Date("2026-09-15T00:00:00.000Z");
const NEW_ARRIVALS_LIMIT = 8;

// Read at call time by `readPancakeShopId()`, so the homepage runtime reads the shop seeded here.
process.env.PANCAKE_SHOP_ID = String(SHOP);

const { listConfiguredHomepageFeaturedWithPricing, listConfiguredHomepageNewArrivals } =
  await import("../../src/commerce/storefront-catalog-runtime.ts");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

async function cleanup() {
  await prisma.$executeRaw`DELETE FROM "PromotionTarget" WHERE "id" LIKE ${`${P}-%`}`;
  await prisma.$executeRaw`DELETE FROM "PromotionCampaign" WHERE "id" LIKE ${`${P}-%`}`;
  // `HomepageFeaturedProduct` and `VariantMirror` both cascade from the product.
  await prisma.productMirror.deleteMany({ where: { pancakeProductId: { startsWith: `${P}-` } } });
}

async function seedProduct(key: string, createdAt: Date) {
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP,
      pancakeProductId: `${P}-${key}`,
      slug: `${P}-${key}`,
      name: `Homepage freshness ${key}`,
      isPresent: true,
      isActive: true,
      syncedAt: NOW,
      createdAt,
    },
  });

  await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `${P}-pv-${key}`,
      productId: product.id,
      color: "Đen",
      size: "S",
      pancakeRetailPrice: 900_000,
      pancakeRetailPriceAfterDiscount: 900_000,
      isPresent: true,
      isActive: true,
      syncedAt: NOW,
    },
  });

  return product;
}

test("a Featured-only campaign boundary is reported by the Featured read, not swallowed", async () => {
  await cleanup();
  try {
    // The Featured product is the oldest, and enough newer products exist to fill the new-arrivals
    // limit. So the campaign below touches Featured and nothing the other grid reads -- the exact
    // shape where sealing one window silently staled the other.
    const featuredProduct = await seedProduct("featured", new Date(NOW.getTime() - 86_400_000));
    for (let index = 0; index < NEW_ARRIVALS_LIMIT; index += 1) {
      await seedProduct(`new-${index}`, new Date(NOW.getTime() - index * 1_000));
    }

    await prisma.homepageFeaturedProduct.create({
      data: { productId: featuredProduct.id, position: 9_610 },
    });

    await prisma.promotionCampaign.create({
      data: {
        id: `${P}-campaign`,
        kind: "PROMOTION",
        name: "Homepage Featured boundary",
        discountType: "PERCENTAGE",
        percentageValue: 20,
        startsAt: new Date(NOW.getTime() + 5_000),
        endsAt: new Date(NOW.getTime() + 3_600_000),
        isEnabled: true,
        enabledAt: NOW,
        targets: { create: { id: `${P}-target`, productId: featuredProduct.id, createdAt: NOW } },
      },
    });

    const featured = await listConfiguredHomepageFeaturedWithPricing(NOW);
    const newArrivals = await listConfiguredHomepageNewArrivals(NEW_ARRIVALS_LIMIT, NOW);

    assert.deepEqual(
      featured.products.map((product) => product.slug),
      [`${P}-featured`],
      "the campaign must be scoped to the Featured grid for this regression to mean anything",
    );
    assert.ok(
      !newArrivals.products.some((product) => product.slug === `${P}-featured`),
      "the Featured product must be off the new-arrivals grid, or both reads see one boundary",
    );

    assert.equal(
      featured.refreshAfterMs,
      5_000,
      "Featured must report its own boundary rather than dropping it",
    );
    assert.equal(
      newArrivals.refreshAfterMs,
      MAX_STOREFRONT_PROMOTION_REFRESH_MS,
      "new arrivals have no boundary here, so sealing only their window would miss Featured's",
    );
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
});
