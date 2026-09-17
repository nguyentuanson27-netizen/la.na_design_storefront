import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createStorefrontCartRepository } from "../../src/commerce/storefront-cart-repository.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const repository = createStorefrontCartRepository(prisma);
const shopId = 910_060;
const otherShopId = 910_061;
const syncedAt = new Date("2026-08-11T05:30:00.000Z");

async function cleanup() {
  await prisma.productMirror.deleteMany({
    where: { pancakeShopId: { in: [shopId, otherShopId] } },
  });
}

test.beforeEach(cleanup);
test.afterEach(cleanup);
test.after(async () => prisma.$disconnect());

test("storefront cart resolves current lines only from the configured shop and preserves stale lines as unavailable", async () => {
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: shopId,
      pancakeProductId: "cart-storefront-product",
      slug: "cart-storefront-product",
      name: "Cart Storefront Product",
      isPresent: true,
      isActive: true,
      syncedAt,
    },
  });

  const available = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: "cart-storefront-available",
      productId: product.id,
      color: "Black",
      size: "M",
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 590_000,
      pancakeRetailPriceAfterDiscount: 590_000,
      syncedAt,
    },
  });
  await prisma.warehouseStock.createMany({
    data: [
      {
        variantId: available.id,
        pancakeWarehouseId: "cart-storefront-warehouse-a",
        quantity: 2,
        syncedAt,
      },
      {
        variantId: available.id,
        pancakeWarehouseId: "cart-storefront-warehouse-b",
        quantity: 1,
        syncedAt,
      },
    ],
  });

  const stale = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: "cart-storefront-stale",
      productId: product.id,
      color: "Stone",
      size: "L",
      isPresent: false,
      isActive: false,
      pancakeRetailPrice: 620_000,
      pancakeRetailPriceAfterDiscount: 620_000,
      syncedAt,
    },
  });

  const otherProduct = await prisma.productMirror.create({
    data: {
      pancakeShopId: otherShopId,
      pancakeProductId: "cart-other-shop-product",
      slug: "cart-other-shop-product",
      name: "Other Shop Product",
      isPresent: true,
      isActive: true,
      syncedAt,
    },
  });
  const otherShopVariant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: "cart-other-shop-variant",
      productId: otherProduct.id,
      color: "Olive",
      size: "S",
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 490_000,
      pancakeRetailPriceAfterDiscount: 490_000,
      syncedAt,
    },
  });

  const lines = await repository.getLines({
    shopId,
    items: [
      { variantId: available.id, quantity: 2 },
      { variantId: stale.id, quantity: 1 },
      { variantId: otherShopVariant.id, quantity: 1 },
    ],
  });

  assert.deepEqual(lines, [
    {
      variantId: available.id,
      pancakeVariationId: "cart-storefront-available",
      pancakeProductId: "cart-storefront-product",
      productSlug: "cart-storefront-product",
      productName: "Cart Storefront Product",
      color: "Black",
      size: "M",
      quantity: 2,
      price: 590_000,
      available: true,
      unavailableReason: null,
      media: { primary: null, gallery: [] },
    },
    {
      variantId: stale.id,
      // The variant is stale but real, so its committed identity is still reported.
      pancakeVariationId: "cart-storefront-stale",
      pancakeProductId: "cart-storefront-product",
      productSlug: "cart-storefront-product",
      productName: "Cart Storefront Product",
      color: "Stone",
      size: "L",
      quantity: 1,
      price: null,
      available: false,
      unavailableReason: "VARIANT_UNAVAILABLE",
      media: { primary: null, gallery: [] },
    },
    {
      variantId: otherShopVariant.id,
      // Out of the configured shop scope: nothing resolved, so nothing is invented.
      pancakeVariationId: null,
      pancakeProductId: null,
      productSlug: null,
      productName: null,
      color: null,
      size: null,
      quantity: 1,
      price: null,
      available: false,
      unavailableReason: "VARIANT_UNAVAILABLE",
      media: { primary: null, gallery: [] },
    },
  ]);
});

test("storefront cart resolves trusted product media from database mirror", async () => {
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: shopId,
      pancakeProductId: "cart-media-product",
      slug: "cart-media-product",
      name: "Cart Media Product",
      primaryImageUrl: "https://content.pancake.vn/images/1/2/3/cart-product.jpg",
      isPresent: true,
      isActive: true,
      syncedAt,
    },
  });

  const variant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: "cart-media-variant",
      productId: product.id,
      color: "Ink",
      size: "M",
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 850_000,
      pancakeRetailPriceAfterDiscount: 850_000,
      pancakeImageUrls: ["https://content.pancake.vn/images/1/2/3/cart-variant.jpg"],
      syncedAt,
    },
  });

  const [line] = await repository.getLines({
    shopId,
    items: [{ variantId: variant.id, quantity: 1 }],
  });

  assert.equal(line?.media.primary?.url, "https://content.pancake.vn/images/1/2/3/cart-product.jpg");
  assert.equal(line?.media.primary?.alt, "Cart Media Product");
  assert.equal(line?.media.gallery.length, 2);
});

test("storefront cart read model rejects requests larger than the cart line ceiling", async () => {
  await assert.rejects(
    () =>
      repository.getLines({
        shopId,
        items: Array.from({ length: 51 }, (_, index) => ({
          variantId: `cart-overflow-${index}`,
          quantity: 1,
        })),
      }),
    /50/,
  );
});

/**
 * I5 — the cart's eligibility comes from **server truth**.
 *
 * The domain tests pin what the rule decides given a policy; only this can show the policy is
 * actually read from the database rather than defaulted. That distinction is the task: a
 * client-supplied policy would be exactly the browser-reported availability ADR 0014 §2 forbids.
 */
test("I5 cart eligibility reads the stored selling policy, not a client claim", async () => {
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: shopId,
      pancakeProductId: "cart-policy-product",
      slug: "cart-policy-product",
      name: "Cart Policy Product",
      isPresent: true,
      isActive: true,
      syncedAt,
    },
  });
  const variant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: "cart-policy-variant",
      productId: product.id,
      color: "Black",
      size: "M",
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 500_000,
      pancakeRetailPriceAfterDiscount: 500_000,
      syncedAt,
    },
  });
  // Stock exactly 0: sellable under an OVERSELL allowance, sold out under STANDARD. The row below
  // is the only thing that decides which, so the assertion cannot pass by accident.
  await prisma.warehouseStock.create({
    data: {
      variantId: variant.id,
      pancakeWarehouseId: "cart-policy-warehouse",
      quantity: 0,
      syncedAt,
    },
  });

  // No policy row — the §5.1 missing-row answer, which is today's behaviour exactly.
  const [unconfigured] = await repository.getLines({
    shopId,
    items: [{ variantId: variant.id, quantity: 1 }],
  });
  assert.equal(unconfigured?.available, false);
  assert.equal(unconfigured?.unavailableReason, "OUT_OF_STOCK");

  // The owner configures the allowance. Nothing about the request changes — only the database.
  await prisma.productSellingPolicy.create({
    data: { productId: product.id, sellingMode: "OVERSELL", negativeStockLimit: -20 },
  });
  const [configured] = await repository.getLines({
    shopId,
    items: [{ variantId: variant.id, quantity: 1 }],
  });
  assert.equal(configured?.available, true, "the stored allowance must reach the cart");
  assert.equal(configured?.unavailableReason, null);

  // And the limit is still enforced from the same stored row: 21 units from stock 0 lands at −21.
  const [pastLimit] = await repository.getLines({
    shopId,
    items: [{ variantId: variant.id, quantity: 21 }],
  });
  assert.equal(pastLimit?.available, false);
  assert.equal(pastLimit?.unavailableReason, "INSUFFICIENT_STOCK");
  const [atLimit] = await repository.getLines({
    shopId,
    items: [{ variantId: variant.id, quantity: 20 }],
  });
  assert.equal(atLimit?.available, true, "the unit that lands on the floor is still sold");
});

test("I5 a composite parent is refused an oversell allowance the cart read from the database", async () => {
  // ADR §11, end to end: I2 refuses to store this, but a row written around that boundary (a repair
  // query, a fixture) must still not sell here. The restriction is the rule's, not the writer's.
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: shopId,
      pancakeProductId: "cart-composite-parent",
      slug: "cart-composite-parent",
      name: "Cart Composite Parent",
      isPresent: true,
      isActive: true,
      syncedAt,
      sellingPolicy: { create: { sellingMode: "OVERSELL", negativeStockLimit: -20 } },
    },
  });
  const parentVariant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: "cart-composite-parent-variant",
      productId: product.id,
      color: "Black",
      size: "M",
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 900_000,
      pancakeRetailPriceAfterDiscount: 900_000,
      syncedAt,
    },
  });
  await prisma.warehouseStock.create({
    data: {
      variantId: parentVariant.id,
      pancakeWarehouseId: "cart-composite-warehouse",
      quantity: 0,
      syncedAt,
    },
  });

  // Before it has components it is an ordinary product, and the allowance applies.
  const [standalone] = await repository.getLines({
    shopId,
    items: [{ variantId: parentVariant.id, quantity: 1 }],
  });
  assert.equal(standalone?.available, true);

  // Giving it a component makes it a composite parent, and the same stored allowance stops applying
  // — the only change is the graph, which is what proves the restriction is what fired.
  const childProduct = await prisma.productMirror.create({
    data: {
      pancakeShopId: shopId,
      pancakeProductId: "cart-composite-child",
      slug: "cart-composite-child",
      name: "Cart Composite Child",
      isPresent: true,
      isActive: true,
      syncedAt,
    },
  });
  const childVariant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: "cart-composite-child-variant",
      productId: childProduct.id,
      isPresent: true,
      isActive: true,
      syncedAt,
    },
  });
  await prisma.compositeComponentMirror.create({
    data: {
      parentVariantId: parentVariant.id,
      componentVariantId: childVariant.id,
      quantity: 1,
      syncedAt,
    },
  });

  const [composite] = await repository.getLines({
    shopId,
    items: [{ variantId: parentVariant.id, quantity: 1 }],
  });
  assert.equal(composite?.available, false, "ADR §11 refuses OVERSELL for a composite parent");
  assert.equal(composite?.unavailableReason, "OUT_OF_STOCK");
});
