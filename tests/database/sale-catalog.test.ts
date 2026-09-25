import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createFlashSaleCatalogRepository } from "../../src/commerce/flash-sale-catalog.ts";
import { readApplicablePromotionCampaignsBatched } from "../../src/commerce/promotion-candidate-batching.ts";
import type { PromotionCandidateReadClient } from "../../src/commerce/promotion-candidate-repository.ts";
import { parseStorefrontDiscoverySearchParams } from "../../src/commerce/storefront-discovery.ts";
import { buildStorefrontProductImpressions } from "../../src/commerce/storefront-impressions.ts";
import { buildPromotionalStorefrontPricing } from "../../src/commerce/storefront-promotion-projection.ts";
import { buildProductCardModel } from "../../src/components/headless/build-product-card-model.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const repository = createFlashSaleCatalogRepository(prisma);
const shopId = 910_060;
const now = new Date("2026-09-16T04:00:00.000Z");
const campaignIds = [
  "sale-catalog-promotion",
  "sale-catalog-flash",
  "sale-catalog-flash-open-start",
  "sale-catalog-flash-no-window",
];

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

async function addVariant(productId: string, suffix: string, size: string, priceVnd: number) {
  const variant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `${suffix}-variant`,
      productId,
      color: "Black",
      size,
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: priceVnd,
      pancakeRetailPriceAfterDiscount: priceVnd,
      syncedAt: now,
    },
  });
  await prisma.warehouseStock.create({
    data: { variantId: variant.id, pancakeWarehouseId: `${suffix}-warehouse`, quantity: 2, syncedAt: now },
  });
  return variant;
}

test("Ưu đãi prices and reports a split product from its Promotion variant, never its Flash sibling", async () => {
  const product = await createProduct("sale-split-product", 500_000);
  const promotionVariant = await prisma.variantMirror.findFirstOrThrow({ where: { productId: product.id } });
  const flashVariant = await addVariant(product.id, "sale-split-flash", "L", 500_000);

  await prisma.promotionCampaign.create({
    data: {
      id: campaignIds[0]!,
      kind: "PROMOTION",
      name: "Promotion on M",
      discountType: "PERCENTAGE",
      percentageValue: 20,
      isEnabled: true,
      enabledAt: new Date(now.getTime() - 60_000),
      targets: { create: { variantId: promotionVariant.id } },
    },
  });
  await prisma.promotionCampaign.create({
    data: {
      id: campaignIds[1]!,
      kind: "FLASH_SALE",
      name: "Flash on L",
      discountType: "PERCENTAGE",
      percentageValue: 40,
      startsAt: new Date(now.getTime() - 60_000),
      endsAt: new Date(now.getTime() + 3_600_000),
      isEnabled: true,
      enabledAt: new Date(now.getTime() - 60_000),
      targets: { create: { variantId: flashVariant.id } },
    },
  });

  const page = await repository.listSalePage({
    shopId,
    discovery: parseStorefrontDiscoverySearchParams({}),
    pageSize: 12,
    kind: "PROMOTION",
    now,
  });
  assert.deepEqual(page.products.map((listed) => listed.slug), ["sale-split-product"]);
  const listed = page.products[0]!;
  assert.equal("flashSale" in listed, false);

  // The same pricing authority `/sale/uu-dai` uses: every applicable campaign, scoped to Promotion.
  const { campaignsByVariantId } = await readApplicablePromotionCampaignsBatched({
    variantIds: listed.variants.map((variant) => variant.id),
    client: prisma as unknown as PromotionCandidateReadClient,
  });
  const pricingRule = buildPromotionalStorefrontPricing({ campaignsByVariantId, now, onlyKind: "PROMOTION" });

  const card = buildProductCardModel({
    slug: listed.slug,
    name: listed.name,
    variants: listed.variants,
    pricingRule,
  });
  assert.match(card.price.displayText, /400\.000/);
  assert.doesNotMatch(card.price.displayText, /300\.000/);
  assert.equal(card.price.discountPercent, 20);

  const [impression] = buildStorefrontProductImpressions({ products: [listed], pricingRule });
  assert.equal(impression?.minimumPriceVnd, 400_000);
  assert.equal(impression?.maximumPriceVnd, 500_000);

  // Unscoped, the Flash sibling would have been the card's price: this is what the scope prevents.
  const unscoped = buildProductCardModel({
    slug: listed.slug,
    name: listed.name,
    variants: listed.variants,
    pricingRule: buildPromotionalStorefrontPricing({ campaignsByVariantId, now }),
  });
  assert.match(unscoped.price.displayText, /300\.000/);
});

test("Flash Sale sub-listing keeps the Flash window invariant: incomplete windows are not members", async () => {
  const openStart = await createProduct("sale-flash-open-start", 500_000);
  const noWindow = await createProduct("sale-flash-no-window", 600_000);

  await prisma.promotionCampaign.create({
    data: {
      id: campaignIds[2]!,
      kind: "FLASH_SALE",
      name: "Flash without a start",
      discountType: "PERCENTAGE",
      percentageValue: 30,
      startsAt: null,
      endsAt: new Date(now.getTime() + 3_600_000),
      isEnabled: true,
      enabledAt: new Date(now.getTime() - 60_000),
      targets: { create: { productId: openStart.id } },
    },
  });
  await prisma.promotionCampaign.create({
    data: {
      id: campaignIds[3]!,
      kind: "FLASH_SALE",
      name: "Flash without any window",
      discountType: "PERCENTAGE",
      percentageValue: 30,
      isEnabled: true,
      enabledAt: new Date(now.getTime() - 60_000),
      targets: { create: { productId: noWindow.id } },
    },
  });

  const discovery = parseStorefrontDiscoverySearchParams({});
  const flashListing = await repository.listSalePage({ shopId, discovery, pageSize: 12, kind: "FLASH_SALE", now });
  assert.deepEqual(flashListing.products, []);
  assert.equal(flashListing.totalCount, 0);

  // Same answer as the established Flash read for the same rows.
  const established = await repository.listFlashSalePage({ shopId, discovery, pageSize: 12, now });
  assert.equal(established.totalCount, 0);
});
