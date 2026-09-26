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
  "sale-catalog-clearance",
  "sale-catalog-last-sizes-flash",
  "sale-catalog-last-sizes-flash-no-window",
  "sale-catalog-last-sizes-clearance",
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

test("Xả hàng lẻ size lists CLEARANCE campaigns only, marks them, and /sale includes them", async () => {
  const clearanceProduct = await createProduct("sale-clearance-product", 800_000);
  // A second size that has sold out, so the remaining pieces (2, from createProduct) are "lẻ size".
  await addVariant(clearanceProduct.id, "sale-clearance-sold-out", "L", 800_000);
  await prisma.warehouseStock.updateMany({
    where: { variant: { pancakeVariationId: "sale-clearance-sold-out-variant" } },
    data: { quantity: 0 },
  });
  const promotionProduct = await createProduct("sale-clearance-neighbour", 500_000);

  await prisma.promotionCampaign.create({
    data: {
      id: campaignIds[4]!,
      kind: "CLEARANCE",
      name: "Xả hàng lẻ size",
      discountType: "PERCENTAGE",
      percentageValue: 50,
      isEnabled: true,
      enabledAt: new Date(now.getTime() - 60_000),
      targets: { create: { productId: clearanceProduct.id } },
    },
  });
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

  const discovery = parseStorefrontDiscoverySearchParams({});
  const clearance = await repository.listSalePage({ shopId, discovery, pageSize: 12, kind: "CLEARANCE", now });
  assert.deepEqual(clearance.products.map((listed) => listed.slug), ["sale-clearance-product"]);
  const listed = clearance.products[0]!;
  assert.equal("isClearance" in listed && listed.isClearance, true);
  assert.equal("flashSale" in listed, false);

  const promotionOnly = await repository.listSalePage({ shopId, discovery, pageSize: 12, kind: "PROMOTION", now });
  assert.deepEqual(promotionOnly.products.map((product) => product.slug), ["sale-clearance-neighbour"]);

  const all = await repository.listSalePage({ shopId, discovery, pageSize: 12, now });
  assert.deepEqual(all.products.map((product) => product.slug).sort(), [
    "sale-clearance-neighbour",
    "sale-clearance-product",
  ]);

  // Priced like a Promotion, and the card carries the clearance tag beside its discount.
  const { campaignsByVariantId } = await readApplicablePromotionCampaignsBatched({
    variantIds: listed.variants.map((variant) => variant.id),
    client: prisma as unknown as PromotionCandidateReadClient,
  });
  const card = buildProductCardModel({
    slug: listed.slug,
    name: listed.name,
    variants: listed.variants,
    isClearance: true,
    pricingRule: buildPromotionalStorefrontPricing({ campaignsByVariantId, now, onlyKind: "CLEARANCE" }),
  });
  assert.match(card.price.displayText, /400\.000/);
  assert.equal(card.price.discountPercent, 50);
  assert.equal(card.lastSizesLeft, true, "one size sold out and 2 pieces left proves the tag");

  assert.equal(await repository.readNextSaleBoundary({ now, kind: "CLEARANCE" }), null);
});

/**
 * A product whose options are exactly `options` (colour × size × pieces in stock), each at `priceVnd`.
 */
async function createStockedProduct(
  slug: string,
  priceVnd: number,
  options: readonly Readonly<{ color: string; size: string; quantity: number }>[],
) {
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
  const variants = [];
  for (const [index, option] of options.entries()) {
    const variant = await prisma.variantMirror.create({
      data: {
        pancakeVariationId: `${slug}-variant-${index}`,
        productId: product.id,
        color: option.color,
        size: option.size,
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
        pancakeWarehouseId: `${slug}-warehouse-${index}`,
        quantity: option.quantity,
        syncedAt: now,
      },
    });
    variants.push(variant);
  }
  return { product, variants };
}

function flashCampaign(id: string, productIds: readonly string[]) {
  return prisma.promotionCampaign.create({
    data: {
      id,
      kind: "FLASH_SALE",
      name: id,
      discountType: "PERCENTAGE",
      percentageValue: 30,
      startsAt: new Date(now.getTime() - 60_000),
      endsAt: new Date(now.getTime() + 3_600_000),
      isEnabled: true,
      enabledAt: new Date(now.getTime() - 60_000),
      targets: { create: productIds.map((productId) => ({ productId })) },
    },
  });
}

test("Xả hàng lẻ size also lists a Flash Sale product only when its stock proves it is lẻ size", async () => {
  // Proven: size L is sold out, and S + M leave 3 + 4 = 7 pieces, fewer than 10.
  const proven = await createStockedProduct("last-sizes-proven", 1_000_000, [
    { color: "Đen", size: "S", quantity: 3 },
    { color: "Đen", size: "M", quantity: 4 },
    { color: "Đen", size: "L", quantity: 0 },
  ]);
  // Every size still sells: nothing is missing, however little is left.
  const noMissingSize = await createStockedProduct("last-sizes-no-missing-size", 1_000_000, [
    { color: "Đen", size: "S", quantity: 1 },
    { color: "Đen", size: "M", quantity: 1 },
  ]);
  // A size is missing, but 6 + 4 = 10 pieces are left: not fewer than 10.
  const tooMuchStock = await createStockedProduct("last-sizes-too-much-stock", 1_000_000, [
    { color: "Đen", size: "S", quantity: 6 },
    { color: "Đen", size: "M", quantity: 4 },
    { color: "Đen", size: "L", quantity: 0 },
  ]);
  // Đen / L is gone but Trắng / L still sells, so size L is not missing.
  const colourOnly = await createStockedProduct("last-sizes-colour-only", 1_000_000, [
    { color: "Đen", size: "S", quantity: 2 },
    { color: "Đen", size: "L", quantity: 0 },
    { color: "Trắng", size: "L", quantity: 2 },
  ]);
  // The same stock as `proven`, but OVERSELL may still sell size L: stock proves nothing.
  const oversell = await createStockedProduct("last-sizes-oversell", 1_000_000, [
    { color: "Đen", size: "S", quantity: 3 },
    { color: "Đen", size: "M", quantity: 4 },
    { color: "Đen", size: "L", quantity: 0 },
  ]);
  await prisma.productSellingPolicy.create({
    data: { productId: oversell.product.id, sellingMode: "OVERSELL", negativeStockLimit: -20 },
  });

  await flashCampaign("sale-catalog-last-sizes-flash", [
    proven.product.id,
    noMissingSize.product.id,
    tooMuchStock.product.id,
    colourOnly.product.id,
    oversell.product.id,
  ]);

  const discovery = parseStorefrontDiscoverySearchParams({});
  const clearance = await repository.listSalePage({ shopId, discovery, pageSize: 12, kind: "CLEARANCE", now });
  assert.deepEqual(clearance.products.map((listed) => listed.slug), ["last-sizes-proven"]);
  assert.equal(clearance.totalCount, 1);

  // The campaign is still a Flash Sale: the card keeps the Flash price and countdown, and is not
  // re-labelled as a Clearance product.
  const listed = clearance.products[0]!;
  // Admitted on exactly its purchasable Flash variants: S and M. Sold-out L sells nothing.
  assert.ok("admittedFlashVariantIds" in listed);
  assert.deepEqual(
    [...listed.admittedFlashVariantIds].sort(),
    [proven.variants[0]!.id, proven.variants[1]!.id].sort(),
  );
  assert.equal("isClearance" in listed, false);
  assert.ok("flashSale" in listed && listed.flashSale);
  assert.equal(listed.flashSale.effectivePriceVnd, 700_000);

  // And it stays on the Flash Sale listing, beside every other Flash product.
  const flash = await repository.listSalePage({ shopId, discovery, pageSize: 12, kind: "FLASH_SALE", now });
  assert.deepEqual(flash.products.map((product) => product.slug).sort(), [
    "last-sizes-colour-only",
    "last-sizes-no-missing-size",
    "last-sizes-oversell",
    "last-sizes-proven",
    "last-sizes-too-much-stock",
  ]);
  assert.equal(flash.products.some((product) => "admittedFlashVariantIds" in product), false);

  // The Flash window now moves the clearance listing too, so it refreshes on the Flash boundary.
  assert.deepEqual(
    await repository.readNextSaleBoundary({ now, kind: "CLEARANCE" }),
    new Date(now.getTime() + 3_600_000),
  );

  // The card on Xả hàng lẻ size shows the Flash price under the listing's per-product scope.
  const { campaignsByVariantId } = await readApplicablePromotionCampaignsBatched({
    variantIds: listed.variants.map((variant) => variant.id),
    client: prisma as unknown as PromotionCandidateReadClient,
  });
  const admitted = new Set(listed.admittedFlashVariantIds);
  const pricingRule = buildPromotionalStorefrontPricing({
    campaignsByVariantId,
    now,
    onlyKind: (variantId) => (admitted.has(variantId) ? ["CLEARANCE", "FLASH_SALE"] : ["CLEARANCE"]),
  });
  const card = buildProductCardModel({
    slug: listed.slug,
    name: listed.name,
    variants: listed.variants,
    pricingRule,
    flashSale: listed.flashSale,
  });
  assert.match(card.price.displayText, /700\.000/);
  assert.equal(card.price.discountPercent, 30);
  assert.ok(card.flashSale);
  // Tracking reports the same Flash price the card shows.
  const [impression] = buildStorefrontProductImpressions({ products: [listed], pricingRule });
  assert.equal(impression?.exactPriceVnd, 700_000);
});

test("Xả hàng lẻ size keeps the Flash window invariant and never shows a Flash sibling on a Clearance-only product", async () => {
  // Lẻ size stock, but its Flash campaign has no window: not a valid Flash Sale, so not admitted.
  const noWindow = await createStockedProduct("last-sizes-flash-no-window", 1_000_000, [
    { color: "Đen", size: "S", quantity: 2 },
    { color: "Đen", size: "L", quantity: 0 },
  ]);
  await prisma.promotionCampaign.create({
    data: {
      id: "sale-catalog-last-sizes-flash-no-window",
      kind: "FLASH_SALE",
      name: "Flash without a window",
      discountType: "PERCENTAGE",
      percentageValue: 30,
      isEnabled: true,
      enabledAt: new Date(now.getTime() - 60_000),
      targets: { create: { productId: noWindow.product.id } },
    },
  });

  // Clearance on S, Flash on M, with plenty of stock: listed for its Clearance variant only.
  const split = await createStockedProduct("last-sizes-split", 1_000_000, [
    { color: "Đen", size: "S", quantity: 20 },
    { color: "Đen", size: "M", quantity: 20 },
  ]);
  await prisma.promotionCampaign.create({
    data: {
      id: "sale-catalog-last-sizes-clearance",
      kind: "CLEARANCE",
      name: "Clearance on S",
      discountType: "PERCENTAGE",
      percentageValue: 10,
      isEnabled: true,
      enabledAt: new Date(now.getTime() - 60_000),
      targets: { create: { variantId: split.variants[0]!.id } },
    },
  });
  await prisma.promotionCampaign.create({
    data: {
      id: "sale-catalog-last-sizes-flash",
      kind: "FLASH_SALE",
      name: "Flash on M",
      discountType: "PERCENTAGE",
      percentageValue: 40,
      startsAt: new Date(now.getTime() - 60_000),
      endsAt: new Date(now.getTime() + 3_600_000),
      isEnabled: true,
      enabledAt: new Date(now.getTime() - 60_000),
      targets: { create: { variantId: split.variants[1]!.id } },
    },
  });

  const discovery = parseStorefrontDiscoverySearchParams({});
  const clearance = await repository.listSalePage({ shopId, discovery, pageSize: 12, kind: "CLEARANCE", now });
  assert.deepEqual(clearance.products.map((listed) => listed.slug), ["last-sizes-split"]);
  const listed = clearance.products[0]!;
  assert.equal("isClearance" in listed && listed.isClearance, true);
  assert.equal("admittedFlashVariantIds" in listed, false);
  assert.equal("flashSale" in listed, false);
});
