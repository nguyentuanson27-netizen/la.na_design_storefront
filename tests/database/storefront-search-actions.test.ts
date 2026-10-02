import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { searchStorefrontSuggestionsAction } from "../../src/commerce/storefront-search-actions.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const shopId = 920_299;
const syncedAt = new Date("2026-10-02T00:00:00.000Z");
const pancakeProductId = "pr99-search-media-fallback";
const searchToken = "pr99searchmediafallback";
const trustedFallback =
  "https://content.pancake.vn/web-media-263/aa/bb/cc/dd/photo.jpeg";

async function cleanup() {
  await prisma.productMirror.deleteMany({ where: { pancakeProductId } });
}

test.beforeEach(cleanup);
test.afterEach(cleanup);
test.after(async () => prisma.$disconnect());

test("search suggestions scan active variants in deterministic media order for the first trusted image", async () => {
  const previousShopId = process.env.PANCAKE_SHOP_ID;
  process.env.PANCAKE_SHOP_ID = String(shopId);
  try {
    const product = await prisma.productMirror.create({
      data: {
        pancakeShopId: shopId,
        pancakeProductId,
        slug: "pr99-search-media-fallback",
        name: searchToken,
        primaryImageUrl: null,
        isPresent: true,
        isActive: true,
        syncedAt,
      },
    });
    await prisma.variantMirror.createMany({
      data: [
        {
          id: "pr99-search-variant-a",
          pancakeVariationId: "pr99-search-variant-a",
          productId: product.id,
          pancakeImageUrls: ["https://evil.example.com/not-trusted.jpg"],
          pancakeRetailPrice: 100_000,
          pancakeRetailPriceAfterDiscount: 100_000,
          isPresent: true,
          isActive: true,
          syncedAt,
        },
        {
          id: "pr99-search-variant-b",
          pancakeVariationId: "pr99-search-variant-b",
          productId: product.id,
          pancakeImageUrls: [trustedFallback],
          pancakeRetailPrice: 200_000,
          pancakeRetailPriceAfterDiscount: 200_000,
          isPresent: true,
          isActive: true,
          syncedAt,
        },
      ],
    });

    const result = await searchStorefrontSuggestionsAction(searchToken);
    const suggestion = result.products.find((item) => item.id === product.id);
    assert.ok(suggestion);
    assert.equal(
      suggestion.primaryImageUrl,
      trustedFallback,
      "an invalid first variant must not hide a trusted image on the next active variant",
    );
  } finally {
    if (previousShopId === undefined) delete process.env.PANCAKE_SHOP_ID;
    else process.env.PANCAKE_SHOP_ID = previousShopId;
  }
});
