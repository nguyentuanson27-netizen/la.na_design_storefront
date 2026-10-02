import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createCatalogMirrorRepository } from "../../src/commerce/catalog-mirror-repository.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";
import type { PancakeParsedCatalogVariation } from "../../src/integrations/pancake/catalog-contract.ts";
import {
  parsePancakeCompositeSnapshot,
  type PancakeCompositeSnapshot,
} from "../../src/integrations/pancake/composite-contract.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const repository = createCatalogMirrorRepository(prisma);
const shopId = 910_040;

function variation({
  id,
  productId,
  name,
  stock,
}: {
  id: string;
  productId: string;
  name: string;
  stock?: number;
}): PancakeParsedCatalogVariation {
  return {
    id,
    productId,
    displayId: id,
    barcode: id,
    fields: [{ id: `${id}-size`, keyValue: "size", name: "Size", value: "M" }],
    imageUrls: [],
    isHidden: false,
    isLocked: false,
    retailPrice: 500_000,
    retailPriceAfterDiscount: 500_000,
    product: { id: productId, name, sourceDescription: null, primaryImageUrl: null },
    warehouseStocks:
      stock === undefined
        ? []
        : [{ warehouseId: `${id}-warehouse`, remainQuantity: stock }],
    sellableStock: stock ?? 0,
  };
}

const variations = [
  variation({ id: "set-m", productId: "set-product", name: "Set A" }),
  variation({ id: "shirt-m", productId: "shirt-product", name: "Ao A" }),
  variation({ id: "pants-m", productId: "pants-product", name: "Quan A" }),
];

function snapshot(edges: PancakeCompositeSnapshot["edges"]): PancakeCompositeSnapshot {
  return {
    parentVariationIds: ["set-m"],
    componentVariationIds: ["pants-m", "shirt-m"],
    parentIdentities: [{ variationId: "set-m", productId: "set-product" }],
    componentIdentities: [
      { variationId: "pants-m", productId: "pants-product" },
      { variationId: "shirt-m", productId: "shirt-product" },
    ],
    edges,
  };
}

function parsedSnapshot({
  parentProductId = "set-product",
  componentProductId = "shirt-product",
}: {
  parentProductId?: string;
  componentProductId?: string;
} = {}): PancakeCompositeSnapshot {
  return parsePancakeCompositeSnapshot({
    shopId,
    parentEntries: [
      {
        id: "set-m",
        product_id: parentProductId,
        is_composite: true,
        composite_products: [
          {
            id: "edge-shirt",
            variation_id: "set-m",
            component_id: "shirt-m",
            quantity: 1,
            shop_id: shopId,
            measure_info: null,
            component: {
              id: "shirt-m",
              product_id: componentProductId,
              is_composite: false,
            },
          },
        ],
      },
    ],
    childEntries: [
      {
        id: "shirt-m",
        product_id: componentProductId,
        is_composite: false,
        composite_products: [],
      },
    ],
  });
}

async function cleanup() {
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: shopId } });
  await prisma.catalogSyncState.deleteMany({ where: { pancakeShopId: shopId } });
}

test.beforeEach(cleanup);
test.afterEach(cleanup);
test.after(async () => prisma.$disconnect());

test("catalog sync persists direct composite edges and replaces stale edges idempotently", async () => {
  const first = snapshot([
    { parentVariationId: "set-m", componentVariationId: "shirt-m", quantity: 1 },
    { parentVariationId: "set-m", componentVariationId: "pants-m", quantity: 1 },
  ]);

  await repository.syncSnapshot({
    shopId,
    variations,
    compositeSnapshot: first,
    syncedAt: new Date("2026-08-22T00:00:00.000Z"),
  });
  await repository.syncSnapshot({
    shopId,
    variations,
    compositeSnapshot: first,
    syncedAt: new Date("2026-08-22T00:00:00.000Z"),
  });

  const firstEdges = await prisma.compositeComponentMirror.findMany({
    where: { parentVariant: { product: { pancakeShopId: shopId } } },
    orderBy: { componentVariant: { pancakeVariationId: "asc" } },
    select: {
      quantity: true,
      parentVariant: { select: { pancakeVariationId: true } },
      componentVariant: { select: { pancakeVariationId: true } },
    },
  });
  assert.deepEqual(firstEdges, [
    {
      quantity: 1,
      parentVariant: { pancakeVariationId: "set-m" },
      componentVariant: { pancakeVariationId: "pants-m" },
    },
    {
      quantity: 1,
      parentVariant: { pancakeVariationId: "set-m" },
      componentVariant: { pancakeVariationId: "shirt-m" },
    },
  ]);

  await repository.syncSnapshot({
    shopId,
    variations,
    compositeSnapshot: snapshot([
      { parentVariationId: "set-m", componentVariationId: "shirt-m", quantity: 2 },
    ]),
    syncedAt: new Date("2026-08-22T01:00:00.000Z"),
  });

  const secondEdges = await prisma.compositeComponentMirror.findMany({
    where: { parentVariant: { product: { pancakeShopId: shopId } } },
    select: {
      quantity: true,
      componentVariant: { select: { pancakeVariationId: true } },
    },
  });
  assert.deepEqual(secondEdges, [
    { quantity: 2, componentVariant: { pancakeVariationId: "shirt-m" } },
  ]);
});

test("PREORDER composite availability cycle opens from component-ready capacity, not parent stock", async () => {
  const composite = snapshot([
    { parentVariationId: "set-m", componentVariationId: "shirt-m", quantity: 1 },
    { parentVariationId: "set-m", componentVariationId: "pants-m", quantity: 1 },
  ]);
  const readySnapshot = [
    variation({ id: "set-m", productId: "set-product", name: "Set A", stock: 0 }),
    variation({ id: "shirt-m", productId: "shirt-product", name: "Ao A", stock: 5 }),
    variation({ id: "pants-m", productId: "pants-product", name: "Quan A", stock: 5 }),
  ];

  await repository.syncSnapshot({
    shopId,
    variations: readySnapshot,
    compositeSnapshot: composite,
    syncedAt: new Date("2026-09-20T00:00:00.000Z"),
    availabilityObservedAt: new Date("2026-09-20T00:00:01.000Z"),
  });
  const parentProduct = await prisma.productMirror.findFirstOrThrow({
    where: { pancakeShopId: shopId, pancakeProductId: "set-product" },
    include: { variants: true },
  });
  await prisma.productSellingPolicy.create({
    data: {
      productId: parentProduct.id,
      sellingMode: "PREORDER",
      negativeStockLimit: -20,
    },
  });

  await repository.syncSnapshot({
    shopId,
    variations: readySnapshot,
    compositeSnapshot: composite,
    syncedAt: new Date("2026-09-20T01:00:00.000Z"),
    availabilityObservedAt: new Date("2026-09-20T01:00:01.000Z"),
  });
  const parentVariantId = parentProduct.variants[0]!.id;
  const ready = await prisma.variantAvailabilityCycle.findUniqueOrThrow({
    where: { variantId: parentVariantId },
  });
  assert.equal(ready.lastStockNonPositive, false, "parent stock 0 is not sold out while components make sets");
  assert.equal(ready.cycleStartDate, null);
  assert.equal(ready.availabilityDate, null);

  const exhaustedSnapshot = [
    variation({ id: "set-m", productId: "set-product", name: "Set A", stock: 0 }),
    variation({ id: "shirt-m", productId: "shirt-product", name: "Ao A", stock: 0 }),
    variation({ id: "pants-m", productId: "pants-product", name: "Quan A", stock: 5 }),
  ];
  await repository.syncSnapshot({
    shopId,
    variations: exhaustedSnapshot,
    compositeSnapshot: composite,
    syncedAt: new Date("2026-09-20T02:00:00.000Z"),
    availabilityObservedAt: new Date("2026-09-20T02:00:01.000Z"),
  });

  const soldOut = await prisma.variantAvailabilityCycle.findUniqueOrThrow({
    where: { variantId: parentVariantId },
  });
  assert.equal(soldOut.lastStockNonPositive, true);
  assert.ok(soldOut.cycleStartDate !== null);
  assert.ok(soldOut.availabilityDate !== null);
});

test("a combo whose component is missing from the catalog is quarantined, not a failed sync, and heals itself", async () => {
  // Complete first, and activated by an admin: this is the state a later incomplete report must
  // neither break nor leave sellable from the parent's own stock.
  await repository.syncSnapshot({
    shopId,
    variations,
    compositeSnapshot: snapshot([
      { parentVariationId: "set-m", componentVariationId: "shirt-m", quantity: 1 },
    ]),
    syncedAt: new Date("2026-08-22T00:00:00.000Z"),
  });
  await prisma.variantMirror.updateMany({
    where: { pancakeVariationId: "set-m" },
    data: { isActive: true },
  });

  // Pancake still lists the combo, but its pants component is hidden/deleted from the catalog.
  const result = await repository.syncSnapshot({
    shopId,
    variations: variations.filter((variation) => variation.id !== "pants-m"),
    compositeSnapshot: {
      parentVariationIds: ["set-m"],
      componentVariationIds: ["pants-m", "shirt-m"],
      parentIdentities: [{ variationId: "set-m", productId: "set-product" }],
      componentIdentities: [
        { variationId: "pants-m", productId: "pants-product" },
        { variationId: "shirt-m", productId: "shirt-product" },
      ],
      edges: [
        { parentVariationId: "set-m", componentVariationId: "pants-m", quantity: 1 },
        { parentVariationId: "set-m", componentVariationId: "shirt-m", quantity: 1 },
      ],
    },
    syncedAt: new Date("2026-08-22T01:00:00.000Z"),
  });

  assert.equal(result.compositeQuarantined, 1);
  // No partial graph: the shirt edge is not kept on its own.
  assert.equal(
    await prisma.compositeComponentMirror.count({
      where: { parentVariant: { product: { pancakeShopId: shopId } } },
    }),
    0,
  );
  const quarantined = await prisma.variantMirror.findUniqueOrThrow({
    where: { pancakeVariationId: "set-m" },
    select: { isPresent: true, isActive: true },
  });
  assert.deepEqual(quarantined, { isPresent: false, isActive: true }, "hidden, admin activation kept");
  // Every other variation synced normally.
  assert.equal(
    (await prisma.variantMirror.findUniqueOrThrow({ where: { pancakeVariationId: "shirt-m" } })).isPresent,
    true,
  );

  // Pancake reports the combo complete again: it comes back present with its full graph.
  const healed = await repository.syncSnapshot({
    shopId,
    variations,
    compositeSnapshot: snapshot([
      { parentVariationId: "set-m", componentVariationId: "shirt-m", quantity: 1 },
      { parentVariationId: "set-m", componentVariationId: "pants-m", quantity: 1 },
    ]),
    syncedAt: new Date("2026-08-22T02:00:00.000Z"),
  });
  assert.equal(healed.compositeQuarantined, 0);
  assert.equal(
    (await prisma.variantMirror.findUniqueOrThrow({ where: { pancakeVariationId: "set-m" } })).isPresent,
    true,
  );
  assert.equal(
    await prisma.compositeComponentMirror.count({
      where: { parentVariant: { product: { pancakeShopId: shopId } } },
    }),
    2,
  );
});

test("catalog sync rejects a composite parent whose product identity contradicts the flat catalog before writes", async () => {
  await assert.rejects(
    repository.syncSnapshot({
      shopId,
      variations,
      compositeSnapshot: parsedSnapshot({ parentProductId: "different-set-product" }),
      syncedAt: new Date("2026-08-22T00:00:00.000Z"),
    }),
    /composite snapshot/i,
  );

  assert.equal(await prisma.productMirror.count({ where: { pancakeShopId: shopId } }), 0);
});

test("catalog sync rejects a composite component whose product identity contradicts the flat catalog before writes", async () => {
  await assert.rejects(
    repository.syncSnapshot({
      shopId,
      variations,
      compositeSnapshot: parsedSnapshot({ componentProductId: "different-shirt-product" }),
      syncedAt: new Date("2026-08-22T00:00:00.000Z"),
    }),
    /composite snapshot/i,
  );

  assert.equal(await prisma.productMirror.count({ where: { pancakeShopId: shopId } }), 0);
});

test("omitting the composite snapshot cannot mutate a shop after a composite graph has been persisted", async () => {
  const first = snapshot([
    { parentVariationId: "set-m", componentVariationId: "shirt-m", quantity: 1 },
    { parentVariationId: "set-m", componentVariationId: "pants-m", quantity: 1 },
  ]);
  await repository.syncSnapshot({
    shopId,
    variations,
    compositeSnapshot: first,
    syncedAt: new Date("2026-08-22T00:00:00.000Z"),
  });

  await assert.rejects(
    repository.syncSnapshot({
      shopId,
      variations,
      syncedAt: new Date("2026-08-22T01:00:00.000Z"),
    }),
    /composite snapshot/i,
  );

  assert.equal(
    await prisma.compositeComponentMirror.count({
      where: { parentVariant: { product: { pancakeShopId: shopId } } },
    }),
    2,
  );
});
