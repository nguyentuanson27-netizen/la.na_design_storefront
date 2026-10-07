import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { MAX_MEDIA_CANDIDATES_SCANNED } from "../../src/commerce/product-media.ts";
import { createStorefrontCatalogRepository } from "../../src/commerce/storefront-catalog.ts";
import {
  storefrontComponentMediaSql,
  type StorefrontComponentMediaRow,
} from "../../src/commerce/storefront-component-media.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

/**
 * Composite parents aggregate their components' photography. The component JSON image arrays are
 * external Pancake payloads, so the candidate budget has to hold at the database boundary: a
 * component's raw array must never cross into the application in full, and imageless components
 * must not crowd image-bearing ones out of the budget.
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required for database smoke tests");
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

const repository = createStorefrontCatalogRepository(prisma);
const shopId = 910_111;
const syncedAt = new Date("2026-10-07T00:00:00.000Z");
const parentSlug = "pr111-composite-parent";

const imageUrl = (name: string) => `https://content.pancake.vn/web-media-263/aa/bb/cc/dd/${name}.jpeg`;
const parentVariantIds = ["pr111-parent-l", "pr111-parent-m", "pr111-parent-s"];

async function cleanup() {
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: shopId } });
}

test.beforeEach(cleanup);
test.afterEach(cleanup);
test.after(async () => prisma.$disconnect());

type ComponentSeed = Readonly<{ id: string; images: readonly string[]; isActive?: boolean }>;

async function seedComposite(components: readonly ComponentSeed[]) {
  const parent = await prisma.productMirror.create({
    data: {
      pancakeShopId: shopId,
      pancakeProductId: "pr111-composite-parent",
      slug: parentSlug,
      name: "Composite parent",
      isPresent: true,
      isActive: true,
      syncedAt,
    },
  });
  const componentProduct = await prisma.productMirror.create({
    data: {
      pancakeShopId: shopId,
      pancakeProductId: "pr111-composite-components",
      slug: "pr111-composite-components",
      name: "Composite components",
      isPresent: true,
      isActive: true,
      syncedAt,
    },
  });
  await prisma.variantMirror.createMany({
    data: [
      ...parentVariantIds.map((id) => ({
        id,
        pancakeVariationId: id,
        productId: parent.id,
        pancakeImageUrls: [],
        isPresent: true,
        isActive: true,
        syncedAt,
      })),
      ...components.map((component) => ({
        id: component.id,
        pancakeVariationId: component.id,
        productId: componentProduct.id,
        pancakeImageUrls: [...component.images],
        isPresent: true,
        isActive: component.isActive ?? true,
        syncedAt,
      })),
    ],
  });
  await prisma.compositeComponentMirror.createMany({
    data: parentVariantIds.flatMap((parentVariantId) =>
      components.map((component) => ({
        parentVariantId,
        componentVariantId: component.id,
        quantity: 1,
        syncedAt,
      })),
    ),
  });
  return parent;
}

const imagelessComponents = Array.from({ length: 120 }, (_, index) => ({
  id: `pr111-c-${String(index).padStart(3, "0")}`,
  images: [] as string[],
}));

test("component media is bounded in SQL and imageless components do not consume the budget", async () => {
  const oversized = Array.from({ length: 500 }, (_, index) => imageUrl(`big-${index}`));
  const parent = await seedComposite([
    ...imagelessComponents,
    { id: "pr111-c-zzz-big", images: oversized },
  ]);

  const rows = await prisma.$queryRaw<StorefrontComponentMediaRow[]>(
    storefrontComponentMediaSql([parent.id]),
  );

  assert.equal(rows.length, MAX_MEDIA_CANDIDATES_SCANNED);
  assert.ok(rows.every((row) => row.componentVariantId === "pr111-c-zzz-big"));
  assert.deepEqual(
    rows.map((row) => row.url),
    oversized.slice(0, MAX_MEDIA_CANDIDATES_SCANNED),
  );
});

test("catalog aggregates image-bearing components that sit beyond the first 100 edges", async () => {
  await seedComposite([
    ...imagelessComponents,
    { id: "pr111-c-valid", images: [imageUrl("valid-1"), imageUrl("valid-2")] },
    { id: "pr111-c-inactive", images: [imageUrl("inactive")], isActive: false },
  ]);

  const product = await repository.getProductBySlug({ shopId, slug: parentSlug });

  assert.ok(product);
  assert.deepEqual(
    product.media.gallery.map((image) => image.url),
    [imageUrl("valid-1"), imageUrl("valid-2")],
  );
  for (const variantId of parentVariantIds) {
    assert.equal(product.galleryIndexByVariantId[variantId], 0);
  }
});
