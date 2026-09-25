import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createFlashSaleCatalogRepository } from "../../src/commerce/flash-sale-catalog.ts";
import { parseStorefrontDiscoverySearchParams } from "../../src/commerce/storefront-discovery.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const repository = createFlashSaleCatalogRepository(prisma);
const shopId = 910_060;
const now = new Date("2026-09-16T04:00:00.000Z");
const campaignIds = ["sale-catalog-promotion", "sale-catalog-flash"];

async function cleanup() {
  await prisma.promotionCampaign.deleteMany({ where: { id: { in: campaignIds } } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: shopId } });
}

async function createProduct(slug: string, priceVnd: number) {
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
  const variant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `${slug}-variant`,
      productId: product.id,
      color: "Black",
      size: "M",
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: priceVnd,
      pancakeRetailPriceAfterDiscount: priceVnd,
      syncedAt: now,
    },
  });
  await prisma.warehouseStock.create({
    data: {
      variantId: variant.id,
      pancakeWarehouseId: `${slug}-warehouse`,
      quantity: 2,
      syncedAt: now,
    },
  });
  return product;
}

test.beforeEach(cleanup);
test.afterEach(cleanup);
test.after(async () => prisma.$disconnect());

test("sale projection includes ordinary Promotion and Flash Sale while excluding products without a real discount", async () => {
  const promotionProduct = await createProduct("sale-promotion-product", 500_000);
  const flashProduct = await createProduct("sale-flash-product", 600_000);
  await createProduct("sale-regular-product", 700_000);

  await prisma.promotionCampaign.create({
    data: {
      id: campaignIds[0]!,
      kind: "PROMOTION",
      name: "Ordinary promotion",
      discountType: "PERCENTAGE",
      percentageValue: 20,
      isEnabled: true,
      enabledAt: new Date(now.getTime() - 60_000),
      targets: { create: { productId: promotionProduct.id } },
    },
  });
  await prisma.promotionCampaign.create({
    data: {
      id: campaignIds[1]!,
      kind: "FLASH_SALE",
      name: "Flash promotion",
      discountType: "PERCENTAGE",
      percentageValue: 30,
      startsAt: new Date(now.getTime() - 60_000),
      endsAt: new Date(now.getTime() + 3_600_000),
      isEnabled: true,
      enabledAt: new Date(now.getTime() - 60_000),
      targets: { create: { productId: flashProduct.id } },
    },
  });

  const result = await repository.listSalePage({
    shopId,
    discovery: parseStorefrontDiscoverySearchParams({}),
    pageSize: 12,
    now,
  });

  assert.deepEqual(
    result.products.map((product) => product.slug).sort(),
    ["sale-flash-product", "sale-promotion-product"],
  );
  assert.equal(result.totalCount, 2);

  const promotionResult = result.products.find(
    (product) => product.slug === "sale-promotion-product",
  );
  const flashResult = result.products.find(
    (product) => product.slug === "sale-flash-product",
  );
  assert.ok(promotionResult);
  assert.ok(flashResult);
  assert.equal("flashSale" in promotionResult, false);
  assert.equal("flashSale" in flashResult, true);

  // The Ưu đãi and Flash Sale sub-listings each narrow the same read to one campaign kind.
  const promotionOnly = await repository.listSalePage({
    shopId,
    discovery: parseStorefrontDiscoverySearchParams({}),
    pageSize: 12,
    kind: "PROMOTION",
    now,
  });
  assert.deepEqual(promotionOnly.products.map((product) => product.slug), ["sale-promotion-product"]);
  assert.equal(promotionOnly.totalCount, 1);
  assert.equal("flashSale" in promotionOnly.products[0]!, false);

  const flashOnly = await repository.listSalePage({
    shopId,
    discovery: parseStorefrontDiscoverySearchParams({}),
    pageSize: 12,
    kind: "FLASH_SALE",
    now,
  });
  assert.deepEqual(flashOnly.products.map((product) => product.slug), ["sale-flash-product"]);
  assert.equal(flashOnly.totalCount, 1);
  assert.equal("flashSale" in flashOnly.products[0]!, true);

  // Each listing refreshes on its own kind's boundary: only the flash campaign has an end.
  assert.equal(await repository.readNextSaleBoundary({ now, kind: "PROMOTION" }), null);
  assert.deepEqual(
    await repository.readNextSaleBoundary({ now, kind: "FLASH_SALE" }),
    new Date(now.getTime() + 3_600_000),
  );
});
