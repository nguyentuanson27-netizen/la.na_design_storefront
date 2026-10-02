import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createStorefrontSearchSuggestionFinder } from "../../src/commerce/storefront-search-repository.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const shopId = 930_101;
const findSuggestions = createStorefrontSearchSuggestionFinder(prisma, shopId);
const syncedAt = new Date("2026-10-02T02:00:00.000Z");

async function cleanup() {
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: shopId } });
}

async function seedProduct(input: {
  id: string;
  name: string;
  productCode?: string;
  displayId: string;
  variantActive?: boolean;
}) {
  await prisma.productMirror.create({
    data: {
      pancakeShopId: shopId,
      pancakeProductId: `search-suggest-${input.id}`,
      slug: `search-suggest-${input.id}`,
      name: input.name,
      productCode: input.productCode ?? null,
      isPresent: true,
      isActive: true,
      syncedAt,
      variants: {
        create: {
          pancakeVariationId: `search-suggest-${input.id}-variant`,
          pancakeDisplayId: input.displayId,
          isPresent: true,
          isActive: input.variantActive ?? true,
          pancakeRetailPrice: 787_000,
          pancakeRetailPriceAfterDiscount: 787_000,
          syncedAt,
        },
      },
    },
  });
}

test.beforeEach(async () => {
  await cleanup();
  await seedProduct({
    id: "dieu-lien-hoa",
    name: "Set váy Diệu Liên Hoa",
    productCode: "SV605",
    displayId: "SS-WHITE-M",
  });
  await seedProduct({ id: "hoa-sen", name: "Đầm Hoa Sen", displayId: "DH702-HONG-S" });
  await seedProduct({
    id: "retired-variant",
    name: "Áo Lụa",
    displayId: "AL909-DO-M",
    variantActive: false,
  });
});

test.afterEach(cleanup);
test.after(async () => prisma.$disconnect());

test("search suggestions find a product by the Pancake product code split off its name", async () => {
  const products = await findSuggestions("sv605");
  assert.deepEqual(products.map(({ name }) => name), ["Set váy Diệu Liên Hoa"]);
});

test("search suggestions find a product by an active variant display id", async () => {
  const products = await findSuggestions("dh702");
  assert.deepEqual(products.map(({ name }) => name), ["Đầm Hoa Sen"]);
});

test("search suggestions ignore display ids of inactive variants", async () => {
  assert.deepEqual(await findSuggestions("al909"), []);
});
