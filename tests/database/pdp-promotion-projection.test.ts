/**
 * U15 / P6 — the product page priced through the central authority, against a real database.
 *
 * Two properties need a database to mean anything.
 *
 * Ownership: a composite parent displays components that belong to *other* products. Those
 * components must be priced by their own owning product's campaign, never by the parent's. Getting
 * this wrong is invisible in a unit test with hand-built inputs, because the mistake is in which
 * rows the query attributes to whom.
 *
 * Cost: the product page is the busiest storefront surface. A per-option candidate lookup would
 * leave every behavioural assertion green while degrading the page, so query growth is asserted
 * directly.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../src/generated/prisma/client.ts";
import { createStorefrontProductDetailRepository } from "../../src/commerce/storefront-product-detail.ts";
import { prisma as sharedPrisma } from "../../src/db/prisma.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const P = "u15-pdp";
const SHOP = 920_944;
const NOW = new Date("2026-09-15T00:00:00.000Z");

async function cleanup() {
  await prisma.$executeRaw`DELETE FROM "PromotionTarget" WHERE "campaignId" LIKE ${`${P}-%`}`;
  await prisma.$executeRaw`DELETE FROM "PromotionCampaign" WHERE "id" LIKE ${`${P}-%`}`;
  await prisma.$executeRaw`DELETE FROM "ProductMirror" WHERE "pancakeProductId" LIKE ${`${P}-%`}`;
}

async function seedProduct(key: string, name: string) {
  return prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP,
      pancakeProductId: `${P}-${key}`,
      slug: `${P}-${key}`,
      name,
      isPresent: true,
      isActive: true,
      syncedAt: NOW,
    },
  });
}

async function seedVariant(
  productId: string,
  key: string,
  size: string,
  price: number,
  sku: string | null = null,
) {
  const variant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `${P}-pv-${key}`,
      productId,
      sku,
      color: "Đen",
      size,
      pancakeRetailPrice: price,
      // Deliberately lower, which the old equality gate treated as unpriceable. W3's accepted
      // evidence says this field is not authoritative, so the page must price anyway.
      pancakeRetailPriceAfterDiscount: price - 1,
      isPresent: true,
      isActive: true,
      syncedAt: NOW,
    },
  });
  await prisma.warehouseStock.create({
    data: {
      variantId: variant.id,
      pancakeWarehouseId: `${P}-wh`,
      quantity: 10,
      syncedAt: NOW,
    },
  });
  return variant;
}

async function seedProductCampaign(key: string, productId: string, percentageValue: number) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "PromotionCampaign"
       ("id","kind","name","discountType","percentageValue","isEnabled","enabledAt","createdAt","updatedAt")
     VALUES ($1,'PROMOTION'::"PromotionCampaignKind",$2,'PERCENTAGE'::"PromotionDiscountType",$3,true,$4,$4,$4)`,
    `${P}-${key}`, `U15 ${key}`, percentageValue, NOW,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "PromotionTarget" ("id","campaignId","productId","createdAt") VALUES ($1,$2,$3,$4)`,
    `${P}-t-${key}`, `${P}-${key}`, productId, NOW,
  );
}

test("U15 a standalone PDP prices through the central resolver and past the old equality gate", async () => {
  await cleanup();
  const product = await seedProduct("standalone", "U15 Standalone");
  await seedVariant(product.id, "sa-m", "M", 500_000);
  await seedProductCampaign("camp-standalone", product.id, 10);

  const detail = await createStorefrontProductDetailRepository(prisma).getProductBySlug({
    shopId: SHOP,
    slug: `${P}-standalone`,
    now: NOW,
  });

  const option = detail!.projection.options.find((entry) => entry.size === "M")!;
  assert.equal(option.price, 450_000, "effective price comes from the central resolver");
  assert.equal(option.basePriceVnd, 500_000);
  assert.equal(option.isDiscounted, true);
  // The old gate would have made this null because the after-discount field differs.
  assert.equal(option.purchasable, true);
  await cleanup();
});

test("U15 a composite component is priced by its own owning product, not the parent's campaign", async () => {
  await cleanup();
  const parentProduct = await seedProduct("parent", "U15 Parent Set");
  const componentProduct = await seedProduct("component-owner", "U15 Component Owner");

  const parentVariant = await seedVariant(parentProduct.id, "parent-m", "M", 1_000_000);
  const componentVariant = await seedVariant(
    componentProduct.id,
    "component-m",
    "M",
    400_000,
    "AO-U15",
  );

  await prisma.compositeComponentMirror.create({
    data: {
      parentVariantId: parentVariant.id,
      componentVariantId: componentVariant.id,
      quantity: 1,
      syncedAt: NOW,
    },
  });

  // Two different campaigns so an ownership mix-up produces a visibly wrong number rather than a
  // coincidentally equal one.
  await seedProductCampaign("camp-parent", parentProduct.id, 10);
  await seedProductCampaign("camp-component", componentProduct.id, 25);

  const detail = await createStorefrontProductDetailRepository(prisma).getProductBySlug({
    shopId: SHOP,
    slug: `${P}-parent`,
    now: NOW,
  });

  assert.equal(detail!.projection.mode, "composite");

  const parentOption = detail!.projection.options.find((entry) => entry.kindKey === "parent")!;
  assert.equal(parentOption.price, 900_000, "the parent takes the parent product's 10%");

  const componentOption = detail!.projection.options.find(
    (entry) => entry.kindKey !== "parent" && entry.pancakeVariationId === `${P}-pv-component-m`,
  )!;
  assert.equal(
    componentOption.price,
    300_000,
    "the component takes its own owner's 25%, not the parent's 10%",
  );
  assert.equal(componentOption.basePriceVnd, 400_000);
  assert.equal(componentOption.isDiscounted, true);
  await cleanup();
});

/**
 * Counts the round-trips the detail repository makes, in the same shape as the P3 guard, so a
 * refactor into a per-option lookup is caught by growth rather than by an exact number alone.
 */
function countRoundTrips() {
  const restore: Array<() => void> = [];
  let count = 0;

  const wrap = (owner: Record<string, unknown>, key: string) => {
    const original = owner[key];
    if (typeof original !== "function") return;
    const previous = original as (...args: unknown[]) => unknown;
    owner[key] = (...args: unknown[]) => {
      count += 1;
      return previous.apply(owner, args);
    };
    restore.push(() => {
      owner[key] = previous;
    });
  };

  const client = sharedPrisma as unknown as Record<string, Record<string, unknown>>;
  for (const model of ["variantMirror", "promotionTarget", "promotionCampaign", "productMirror"]) {
    for (const method of ["findMany", "findFirst", "findUnique"]) {
      wrap(client[model] as Record<string, unknown>, method);
    }
  }

  return {
    get count() { return count; },
    reset() { count = 0; },
    restore() { for (const undo of restore) undo(); },
  };
}

test("U15 the PDP candidate lookup does not grow with the number of options", async () => {
  await cleanup();
  const small = await seedProduct("budget-small", "U15 Budget Small");
  await seedVariant(small.id, "small-m", "M", 500_000);
  await seedProductCampaign("camp-small", small.id, 10);

  const large = await seedProduct("budget-large", "U15 Budget Large");
  const sizes = ["S", "M", "L", "XL", "XXL", "3XL", "4XL", "5XL"];
  for (const [index, size] of sizes.entries()) {
    await seedVariant(large.id, `large-${index}`, size, 500_000 + index);
  }
  await seedProductCampaign("camp-large", large.id, 10);

  // The shared client is the one the runtime repository uses, so the meter observes the real path.
  const repository = createStorefrontProductDetailRepository(sharedPrisma);
  const meter = countRoundTrips();
  try {
    meter.reset();
    await repository.getProductBySlug({ shopId: SHOP, slug: `${P}-budget-small`, now: NOW });
    const forOneOption = meter.count;

    meter.reset();
    await repository.getProductBySlug({ shopId: SHOP, slug: `${P}-budget-large`, now: NOW });
    const forEightOptions = meter.count;

    assert.ok(forOneOption > 0, "the meter must actually be observing the repository");
    assert.equal(
      forEightOptions,
      forOneOption,
      `query count grew with option count (${forOneOption} -> ${forEightOptions}); PDP pricing has drifted into N+1`,
    );
  } finally {
    meter.restore();
    await cleanup();
  }
});

test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});
