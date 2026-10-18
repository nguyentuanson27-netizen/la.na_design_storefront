import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../src/generated/prisma/client.ts";
import { PRODUCT_PROMOTION_OFFER_NOTES } from "../../src/commerce/product-promotion-offers.ts";
import {
  readProductPromotionOffers,
  type ProductPromotionOffersReadClient,
} from "../../src/commerce/product-promotion-offers-runtime.ts";

/**
 * The product page's promotion line against real rows: a gift campaign whose gift option exists but
 * cannot be granted (no READY stock, a set, a variant gone inactive) names nothing, exactly as the
 * cart's entitlement would grant nothing; a tier campaign is named with its own, different wording.
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const client = prisma as unknown as ProductPromotionOffersReadClient;
const P = "pdp-offers";
const SHOP = 920_955;
const NOW = new Date("2026-10-18T03:00:00.000Z");
const ENV = {
  LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true",
  PANCAKE_SHOP_ID: String(SHOP),
  LA_PANCAKE_LINE_LEVEL_PRICING_VERIFIED_SHOP_IDS: String(SHOP),
};
const syncedAt = new Date("2026-10-01T00:00:00.000Z");

async function cleanup() {
  await prisma.giftQuantityCampaign.deleteMany({ where: { id: { startsWith: `${P}-` } } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP } });
}

async function productWithVariant(suffix: string, stock: number) {
  const product = await prisma.productMirror.create({
    data: {
      id: `${P}-${suffix}`, pancakeShopId: SHOP, pancakeProductId: `${P}-${suffix}-ext`, slug: `${P}-${suffix}`,
      name: `PDP offers ${suffix}`, isPresent: true, isActive: true, syncedAt,
    },
  });
  const variant = await prisma.variantMirror.create({
    data: {
      id: `${P}-${suffix}-v`, pancakeVariationId: `${P}-${suffix}-v-ext`, productId: product.id, size: "M",
      isPresent: true, isActive: true, pancakeRetailPrice: 500_000, pancakeRetailPriceAfterDiscount: 500_000, syncedAt,
    },
  });
  await prisma.warehouseStock.create({
    data: { variantId: variant.id, pancakeWarehouseId: `${P}-${suffix}-wh`, quantity: stock, syncedAt },
  });
  return { productId: product.id, variantId: variant.id };
}

async function giftCampaign(id: string, giftVariantId: string) {
  await prisma.giftQuantityCampaign.create({
    data: {
      id: `${P}-${id}`, kind: "GIFT_ITEM", name: "Mua 2 tặng túi vải", scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["aoDai"],
      giftTrigger: "QUANTITY", minimumQuantity: 2, maxGiftsPerOrder: 1, allowDuplicateGifts: false,
      isEnabled: true, enabledAt: syncedAt, stackPriority: 1,
      giftOptions: { create: [{ variantId: giftVariantId }] },
    },
  });
}

const read = (productId: string) => readProductPromotionOffers({ productId, now: NOW, client, env: ENV });

test.before(cleanup);
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("a gift campaign whose only gift is out of READY stock is not named; restocked, it is", async () => {
  const paid = await productWithVariant("paid", 5);
  await prisma.productCategoryMembership.create({ data: { productId: paid.productId, categoryKey: "aoDai" } });
  const gift = await productWithVariant("gift", 0);
  await giftCampaign("gift", gift.variantId);

  assert.deepEqual(await read(paid.productId), [], "the option row exists, but nothing could be granted");

  await prisma.warehouseStock.updateMany({ where: { variantId: gift.variantId }, data: { quantity: 1 } });
  assert.deepEqual(await read(paid.productId), [
    { id: `${P}-gift`, kind: "GIFT", label: "Mua 2 tặng túi vải", note: PRODUCT_PROMOTION_OFFER_NOTES.GIFT },
  ]);

  // An inactive gift variant is not grantable either, whatever its stock.
  await prisma.variantMirror.update({ where: { id: gift.variantId }, data: { isActive: false } });
  assert.deepEqual(await read(paid.productId), []);
});

test("a tier campaign covering the product is named with the tier wording, not the gift one", async () => {
  const paid = await productWithVariant("tier-paid", 5);
  await prisma.productCategoryMembership.create({ data: { productId: paid.productId, categoryKey: "aoDai" } });
  await prisma.giftQuantityCampaign.create({
    data: {
      id: `${P}-tier`, kind: "QUANTITY_TIER", name: "Mua 2 giảm 10%", scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["aoDai"],
      tierBasis: "QUANTITY", tierUnit: "PERCENTAGE", tierDiscountedUnits: "ALL_ELIGIBLE_UNITS",
      isEnabled: true, enabledAt: syncedAt, stackPriority: 2,
      tiers: { create: [{ minQuantity: 2, discountValue: 10 }] },
    },
  });

  const offers = await read(paid.productId);
  const tier = offers.find((offer) => offer.id === `${P}-tier`);
  assert.deepEqual(tier, { id: `${P}-tier`, kind: "TIER", label: "Mua 2 giảm 10%", note: PRODUCT_PROMOTION_OFFER_NOTES.TIER });

  // Off unless the shop can take a benefit order.
  assert.deepEqual(
    await readProductPromotionOffers({
      productId: paid.productId, now: NOW, client, env: { ...ENV, LA_PANCAKE_LINE_LEVEL_PRICING_VERIFIED_SHOP_IDS: "" },
    }),
    [],
  );
});
