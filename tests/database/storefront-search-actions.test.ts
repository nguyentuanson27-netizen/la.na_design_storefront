import assert from "node:assert/strict";
import test from "node:test";

import { searchStorefrontSuggestionsAction } from "../../src/commerce/storefront-search-actions.ts";
import { MAX_MEDIA_CANDIDATES_SCANNED } from "../../src/commerce/product-media.ts";
import {
  storefrontSearchMediaCandidatesSql,
  type StorefrontSearchMediaCandidateRow,
} from "../../src/commerce/storefront-search-media.ts";
import { prisma } from "../../src/db/prisma.ts";
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

test("search media candidates are bounded at the database boundary in deterministic order", async () => {
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: shopId,
      pancakeProductId,
      slug: "pr99-search-media-budget",
      name: searchToken,
      primaryImageUrl: "https://evil.example.com/primary.jpg",
      isPresent: true,
      isActive: true,
      syncedAt,
    },
  });
  const firstVariantImages = Array.from(
    { length: 60 },
    (_, index) => `https://evil.example.com/a-${String(index).padStart(3, "0")}.jpg`,
  );
  const secondVariantImages = Array.from(
    { length: 60 },
    (_, index) => `https://evil.example.com/b-${String(index).padStart(3, "0")}.jpg`,
  );
  await prisma.variantMirror.createMany({
    data: [
      {
        id: "pr99-search-budget-a",
        pancakeVariationId: "pr99-search-budget-a",
        productId: product.id,
        pancakeImageUrls: firstVariantImages,
        isPresent: true,
        isActive: true,
        syncedAt,
      },
      {
        id: "pr99-search-budget-b",
        pancakeVariationId: "pr99-search-budget-b",
        productId: product.id,
        pancakeImageUrls: secondVariantImages,
        isPresent: true,
        isActive: true,
        syncedAt,
      },
    ],
  });

  const rows = await prisma.$queryRaw<StorefrontSearchMediaCandidateRow[]>(
    storefrontSearchMediaCandidatesSql([product.id]),
  );

  assert.equal(rows.length, MAX_MEDIA_CANDIDATES_SCANNED);
  assert.equal(rows[0]?.url, "https://evil.example.com/primary.jpg");
  assert.equal(rows[1]?.url, firstVariantImages[0]);
  assert.equal(rows[60]?.url, firstVariantImages[59]);
  assert.equal(rows[61]?.url, secondVariantImages[0]);
  assert.equal(rows[99]?.url, secondVariantImages[38]);
  assert.equal(rows.some((row) => row.url === secondVariantImages[39]), false);
});

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
