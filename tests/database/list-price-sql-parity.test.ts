import assert from "node:assert/strict";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../../src/generated/prisma/client.ts";
import { buildVariantStockCte } from "../../src/commerce/storefront-catalog.ts";
import { resolvePromotionPricing } from "../../src/commerce/promotion-pricing.ts";
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});
const prefix = "list-price-sql",
  now = new Date("2026-10-30T00:00:00Z");
async function cleanup() {
  await db.promotionCampaign.deleteMany({ where: { name: prefix } });
  await db.productMirror.deleteMany({ where: { pancakeProductId: prefix } });
}
test.after(async () => {
  await cleanup();
  await db.$disconnect();
  delete process.env.LIST_PRICE_DISPLAY;
  delete process.env.LIST_PRICE_CAMPAIGN_BASIS;
});
test("sanctioned listing SQL exactly matches central pricing across old/new basis and money boundaries", async () => {
  await cleanup();
  const product = await db.productMirror.create({
    data: {
      pancakeShopId: 925228,
      pancakeProductId: prefix,
      slug: prefix,
      name: prefix,
      syncedAt: now,
      variants: {
        create: [
          1,
          10000,
          429000,
          565000,
          590000,
          582500,
          123456,
          Number.MAX_SAFE_INTEGER,
          4503599627370495,
        ].map((price, i) => ({
          pancakeVariationId: prefix + i,
          size: "M" + i,
          pancakeRetailPrice: price,
          syncedAt: now,
        })),
      },
    },
  });
  const variants = await db.variantMirror.findMany({
    where: { productId: product.id },
  });
  const campaign = await db.promotionCampaign.create({
    data: {
      name: prefix,
      kind: "PROMOTION",
      discountType: "PERCENTAGE",
      percentageValue: 25,
      isEnabled: true,
      enabledAt: now,
      targets: { create: { productId: product.id } },
    },
  });
  for (const basis of [false, true]) {
    process.env.LIST_PRICE_DISPLAY = "true";
    process.env.LIST_PRICE_CAMPAIGN_BASIS = String(basis);
    for (const p of [1, 10, 20, 22, 25, 50, 99]) {
      const current = await db.promotionCampaign.update({
        where: { id: campaign.id },
        data: { percentageValue: p },
      });
      const sql = await db.$queryRaw<
        Array<{ id: string; resolvedPrice: number }>
      >(
        Prisma.sql`${buildVariantStockCte(now)} SELECT "id", "resolvedPrice" FROM "variant_stock" WHERE "productId"=${product.id}`,
      );
      assert.equal(sql.length, variants.length);
      for (const variant of variants) {
        const expected = resolvePromotionPricing({
          basePriceVnd: variant.pancakeRetailPrice,
          campaigns: [current],
          now,
          campaignBasis: basis,
        });
        assert.equal(
          sql.find((row) => row.id === variant.id)?.resolvedPrice,
          expected.effectivePriceVnd,
          `POS=${variant.pancakeRetailPrice}, p=${p}, basis=${basis}`,
        );
      }
    }
  }
});
