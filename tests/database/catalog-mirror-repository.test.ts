import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createCatalogMirrorRepository } from "../../src/commerce/catalog-mirror-repository.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";
import type {
  PancakeCatalogField,
  PancakeParsedCatalogVariation,
} from "../../src/integrations/pancake/catalog-contract.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required for database smoke tests");
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});
const repository = createCatalogMirrorRepository(prisma);
const shopId = 910_039;

const defaultFields: PancakeCatalogField[] = [
  { id: "field-color", keyValue: "color", name: "Color", value: "Black" },
  { id: "field-size", keyValue: "size", name: "Size", value: "M" },
];

function variation({
  id,
  productName = "Mirror Product",
  sourceDescription = null,
  primaryImageUrl = null,
  displayId,
  barcode,
  fields = defaultFields,
  retailPrice = 500_000,
  retailPriceAfterDiscount = 450_000,
  stocks,
}: {
  id: string;
  productName?: string;
  sourceDescription?: string | null;
  primaryImageUrl?: string | null;
  displayId: string;
  barcode: string;
  fields?: PancakeCatalogField[];
  retailPrice?: number;
  retailPriceAfterDiscount?: number;
  stocks: Array<{ warehouseId: string; remainQuantity: number }>;
}): PancakeParsedCatalogVariation {
  return {
    id,
    productId: "mirror-product-1",
    displayId,
    barcode,
    fields,
    imageUrls: ["https://example.test/mirror-product.jpg"],
    isHidden: false,
    isLocked: false,
    retailPrice,
    retailPriceAfterDiscount,
    product: { id: "mirror-product-1", name: productName, sourceDescription, primaryImageUrl },
    warehouseStocks: stocks,
    sellableStock: stocks.reduce((total, stock) => total + stock.remainQuantity, 0),
  };
}

async function cleanup() {
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: shopId } });
  await prisma.catalogSyncState.deleteMany({ where: { pancakeShopId: shopId } });
}

test.beforeEach(cleanup);
test.afterEach(cleanup);
test.after(async () => {
  await prisma.$disconnect();
});

test("catalog mirror sync is idempotent, maps Pancake options, preserves local activation/sku, and aggregates all warehouses", async () => {
  const firstSyncAt = new Date("2026-08-11T00:00:00.000Z");
  const secondSyncAt = new Date("2026-08-11T01:00:00.000Z");
  const firstSnapshot = [
    variation({
      id: "mirror-variation-1",
      displayId: "DISPLAY-1",
      barcode: "BAR-1",
      stocks: [
        { warehouseId: "warehouse-a", remainQuantity: 3.5 },
        { warehouseId: "warehouse-b", remainQuantity: 4 },
      ],
    }),
    variation({
      id: "mirror-variation-2",
      displayId: "DISPLAY-2",
      barcode: "BAR-2",
      stocks: [{ warehouseId: "warehouse-a", remainQuantity: 1 }],
    }),
  ];

  await repository.syncSnapshot({ shopId, variations: firstSnapshot, syncedAt: firstSyncAt });
  await repository.syncSnapshot({ shopId, variations: firstSnapshot, syncedAt: firstSyncAt });

  assert.equal(await prisma.productMirror.count({ where: { pancakeShopId: shopId } }), 1);
  assert.equal(
    await prisma.variantMirror.count({ where: { product: { pancakeShopId: shopId } } }),
    2,
  );
  assert.equal(
    await prisma.warehouseStock.count({ where: { variant: { product: { pancakeShopId: shopId } } } }),
    3,
  );

  const firstRead = await repository.listPresentProducts({ shopId, limit: 10 });
  assert.equal(firstRead.length, 1);
  assert.equal(firstRead[0]?.name, "Mirror Product");
  assert.equal(firstRead[0]?.isActive, false);
  assert.equal(firstRead[0]?.variants[0]?.pancakeVariationId, "mirror-variation-1");
  assert.equal(firstRead[0]?.variants[0]?.pancakeDisplayId, "DISPLAY-1");
  assert.equal(firstRead[0]?.variants[0]?.pancakeBarcode, "BAR-1");
  assert.equal(firstRead[0]?.variants[0]?.pancakeRetailPrice, 500_000);
  assert.equal(firstRead[0]?.variants[0]?.pancakeRetailPriceAfterDiscount, 450_000);
  assert.deepEqual(firstRead[0]?.variants[0]?.pancakeFields, firstSnapshot[0]?.fields);
  assert.deepEqual(firstRead[0]?.variants[0]?.pancakeImageUrls, firstSnapshot[0]?.imageUrls);
  assert.equal(firstRead[0]?.variants[0]?.color, "Black");
  assert.equal(firstRead[0]?.variants[0]?.size, "M");
  assert.equal(firstRead[0]?.variants[0]?.sellableStock, 7.5);

  const mirroredProduct = await prisma.productMirror.findFirstOrThrow({
    where: { pancakeShopId: shopId },
    include: { variants: { orderBy: { pancakeVariationId: "asc" } } },
  });
  await prisma.productMirror.update({
    where: { id: mirroredProduct.id },
    data: { isActive: true },
  });
  await prisma.variantMirror.update({
    where: { id: mirroredProduct.variants[0]!.id },
    data: {
      isActive: true,
      sku: "LOCAL-SKU",
      color: "Stale Local Color",
      size: "Stale Local Size",
    },
  });

  const secondSnapshot = [
    variation({
      id: "mirror-variation-1",
      productName: "Mirror Product Updated",
      displayId: "DISPLAY-1-UPDATED",
      barcode: "BAR-1-UPDATED",
      retailPrice: 520_000,
      retailPriceAfterDiscount: 470_000,
      stocks: [{ warehouseId: "warehouse-a", remainQuantity: 2 }],
    }),
  ];
  await repository.syncSnapshot({ shopId, variations: secondSnapshot, syncedAt: secondSyncAt });

  const secondRead = await repository.listPresentProducts({ shopId, limit: 10 });
  assert.equal(secondRead.length, 1);
  assert.equal(secondRead[0]?.name, "Mirror Product Updated");
  assert.equal(secondRead[0]?.isActive, true);
  assert.equal(secondRead[0]?.variants.length, 1);
  assert.equal(secondRead[0]?.variants[0]?.isActive, true);
  assert.equal(secondRead[0]?.variants[0]?.sku, "LOCAL-SKU");
  assert.equal(secondRead[0]?.variants[0]?.color, "Black");
  assert.equal(secondRead[0]?.variants[0]?.size, "M");
  assert.equal(secondRead[0]?.variants[0]?.pancakeDisplayId, "DISPLAY-1-UPDATED");
  assert.equal(secondRead[0]?.variants[0]?.sellableStock, 2);

  const staleVariant = await prisma.variantMirror.findUniqueOrThrow({
    where: { pancakeVariationId: "mirror-variation-2" },
  });
  assert.equal(staleVariant.isPresent, false);
  assert.equal(staleVariant.isActive, false);
  assert.equal(
    await prisma.warehouseStock.count({ where: { variantId: staleVariant.id } }),
    0,
  );
});

test("catalog mirror maps size without inventing color for size-only Pancake variants", async () => {
  await repository.syncSnapshot({
    shopId,
    syncedAt: new Date("2026-08-11T00:00:00.000Z"),
    variations: [
      variation({
        id: "size-only-variation",
        displayId: "SIZE-ONLY",
        barcode: "SIZE-ONLY-BAR",
        fields: [{ id: "field-size", keyValue: "size", name: "Size", value: "L" }],
        retailPrice: 590_000,
        retailPriceAfterDiscount: 590_000,
        stocks: [{ warehouseId: "warehouse-a", remainQuantity: 2 }],
      }),
    ],
  });

  const product = (await repository.listPresentProducts({ shopId, limit: 10 }))[0];
  assert.equal(product?.variants[0]?.size, "L");
  assert.equal(product?.variants[0]?.color, null);
});

test("catalog mirror rejects inconsistent duplicate variation identity before database writes", async () => {
  const first = variation({
    id: "duplicate-variation",
    displayId: "DISPLAY-A",
    barcode: "BAR-A",
    stocks: [],
  });
  const duplicate = variation({
    id: "duplicate-variation",
    displayId: "DISPLAY-B",
    barcode: "BAR-B",
    stocks: [],
  });

  await assert.rejects(
    () =>
      repository.syncSnapshot({
        shopId,
        variations: [first, duplicate],
        syncedAt: new Date("2026-08-11T00:00:00.000Z"),
      }),
    /duplicate variation/i,
  );
  assert.equal(await prisma.productMirror.count({ where: { pancakeShopId: shopId } }), 0);
});

test("catalog mirror rejects shop ids outside the PostgreSQL INTEGER range before writes", async () => {
  await assert.rejects(
    () =>
      repository.syncSnapshot({
        shopId: 2_147_483_648,
        variations: [],
        syncedAt: new Date("2026-08-11T00:00:00.000Z"),
      }),
    /shop id/i,
  );
  assert.equal(await prisma.productMirror.count({ where: { pancakeShopId: shopId } }), 0);
});

test("catalog mirror sync persists sourceDescription and primaryImageUrl idempotently", async () => {
  const syncedAt = new Date("2026-08-20T03:00:00.000Z");
  const snapshot = [
    variation({
      id: "mirror-variation-source-1",
      productName: "Source Content Shirt",
      sourceDescription: "100% Premium Cotton, regular fit.",
      primaryImageUrl: "https://content.pancake.vn/images/1/2/3/shirt.jpg",
      displayId: "DISPLAY-SRC-1",
      barcode: "BAR-SRC-1",
      stocks: [{ warehouseId: "warehouse-a", remainQuantity: 5 }],
    }),
  ];

  await repository.syncSnapshot({ shopId, variations: snapshot, syncedAt });
  await repository.syncSnapshot({ shopId, variations: snapshot, syncedAt });

  const products = await repository.listPresentProducts({ shopId, limit: 10 });
  assert.equal(products.length, 1);
  assert.equal(products[0]?.name, "Source Content Shirt");
  assert.equal(products[0]?.sourceDescription, "100% Premium Cotton, regular fit.");
  assert.equal(products[0]?.primaryImageUrl, "https://content.pancake.vn/images/1/2/3/shirt.jpg");

  const productInDb = await prisma.productMirror.findFirstOrThrow({
    where: { pancakeShopId: shopId, pancakeProductId: "mirror-product-1" },
  });
  assert.equal(productInDb.sourceDescription, "100% Premium Cotton, regular fit.");
  assert.equal(productInDb.primaryImageUrl, "https://content.pancake.vn/images/1/2/3/shirt.jpg");
});

test("Pancake source changes update ProductMirror source fields without overwriting website-owned ProductContent", async () => {
  const firstSyncAt = new Date("2026-08-20T03:00:00.000Z");
  const secondSyncAt = new Date("2026-08-20T04:00:00.000Z");

  const initialSnapshot = [
    variation({
      id: "mirror-variation-isolation-1",
      productName: "Initial Product Name",
      sourceDescription: "Initial source description from Pancake note_product.",
      primaryImageUrl: "https://content.pancake.vn/images/1/2/3/initial.jpg",
      displayId: "DISPLAY-ISO-1",
      barcode: "BAR-ISO-1",
      stocks: [{ warehouseId: "warehouse-a", remainQuantity: 3 }],
    }),
  ];

  await repository.syncSnapshot({ shopId, variations: initialSnapshot, syncedAt: firstSyncAt });

  const mirroredProduct = await prisma.productMirror.findFirstOrThrow({
    where: { pancakeShopId: shopId, pancakeProductId: "mirror-product-1" },
  });

  // Website-owned ProductContent is authored by editorial team
  await prisma.productContent.create({
    data: {
      productId: mirroredProduct.id,
      editorialDescription: "Carefully curated menswear essential. Website editorial authority.",
      careInstructions: "Machine wash cold inside out.",
      sizeGuide: "Model is 180cm wearing size L.",
      seoTitle: "Source Content Shirt | LA Clothing",
      seoDescription: "Shop the finest cotton shirt from LA Clothing.",
      collectionSlugs: ["essential-tops", "new-arrivals"],
    },
  });

  // Sync subsequent Pancake update with changed sourceDescription, primaryImageUrl, and name
  const updatedSnapshot = [
    variation({
      id: "mirror-variation-isolation-1",
      productName: "Updated Product Name",
      sourceDescription: "Updated source note from POS seller.",
      primaryImageUrl: "https://content.pancake.vn/images/1/2/3/updated.jpg",
      displayId: "DISPLAY-ISO-1",
      barcode: "BAR-ISO-1",
      stocks: [{ warehouseId: "warehouse-a", remainQuantity: 4 }],
    }),
  ];

  await repository.syncSnapshot({ shopId, variations: updatedSnapshot, syncedAt: secondSyncAt });

  // Verify ProductMirror was updated with the fresh Pancake source facts
  const updatedProduct = await prisma.productMirror.findUniqueOrThrow({
    where: { id: mirroredProduct.id },
    include: { content: true },
  });

  assert.equal(updatedProduct.name, "Updated Product Name");
  assert.equal(updatedProduct.sourceDescription, "Updated source note from POS seller.");
  assert.equal(updatedProduct.primaryImageUrl, "https://content.pancake.vn/images/1/2/3/updated.jpg");

  // Verify ProductContent was completely preserved and NOT overwritten
  assert.ok(updatedProduct.content);
  assert.equal(
    updatedProduct.content.editorialDescription,
    "Carefully curated menswear essential. Website editorial authority.",
  );
  assert.equal(updatedProduct.content.careInstructions, "Machine wash cold inside out.");
  assert.equal(updatedProduct.content.sizeGuide, "Model is 180cm wearing size L.");
  assert.equal(updatedProduct.content.seoTitle, "Source Content Shirt | LA Clothing");
  assert.equal(updatedProduct.content.seoDescription, "Shop the finest cotton shirt from LA Clothing.");
  assert.deepEqual(updatedProduct.content.collectionSlugs, ["essential-tops", "new-arrivals"]);
});

test("catalog mirror rejects inconsistent sourceDescription or primaryImageUrl among variants of the same product", async () => {
  const variantA = variation({
    id: "variation-diff-desc-a",
    displayId: "DISPLAY-A",
    barcode: "BAR-A",
    sourceDescription: "Description A",
    primaryImageUrl: "https://content.pancake.vn/images/1/2/3/img.jpg",
    stocks: [],
  });
  const variantB = variation({
    id: "variation-diff-desc-b",
    displayId: "DISPLAY-B",
    barcode: "BAR-B",
    sourceDescription: "Description B",
    primaryImageUrl: "https://content.pancake.vn/images/1/2/3/img.jpg",
    stocks: [],
  });

  await assert.rejects(
    () =>
      repository.syncSnapshot({
        shopId,
        variations: [variantA, variantB],
        syncedAt: new Date("2026-08-20T03:00:00.000Z"),
      }),
    /inconsistent product presentation/i,
  );

  const variantC = variation({
    id: "variation-diff-img-c",
    displayId: "DISPLAY-C",
    barcode: "BAR-C",
    sourceDescription: "Same Description",
    primaryImageUrl: "https://content.pancake.vn/images/1/2/3/img-1.jpg",
    stocks: [],
  });
  const variantD = variation({
    id: "variation-diff-img-d",
    displayId: "DISPLAY-D",
    barcode: "BAR-D",
    sourceDescription: "Same Description",
    primaryImageUrl: "https://content.pancake.vn/images/1/2/3/img-2.jpg",
    stocks: [],
  });

  await assert.rejects(
    () =>
      repository.syncSnapshot({
        shopId,
        variations: [variantC, variantD],
        syncedAt: new Date("2026-08-20T03:00:00.000Z"),
      }),
    /inconsistent product presentation/i,
  );
});

test("catalog mirror allows clearing sourceDescription and primaryImageUrl when removed in Pancake", async () => {
  const initial = [
    variation({
      id: "mirror-variation-clear-1",
      sourceDescription: "Present description",
      primaryImageUrl: "https://content.pancake.vn/images/1/2/3/img.jpg",
      displayId: "DISPLAY-CLR-1",
      barcode: "BAR-CLR-1",
      stocks: [{ warehouseId: "warehouse-a", remainQuantity: 1 }],
    }),
  ];
  await repository.syncSnapshot({
    shopId,
    variations: initial,
    syncedAt: new Date("2026-08-20T03:00:00.000Z"),
  });

  const cleared = [
    variation({
      id: "mirror-variation-clear-1",
      sourceDescription: null,
      primaryImageUrl: null,
      displayId: "DISPLAY-CLR-1",
      barcode: "BAR-CLR-1",
      stocks: [{ warehouseId: "warehouse-a", remainQuantity: 1 }],
    }),
  ];
  await repository.syncSnapshot({
    shopId,
    variations: cleared,
    syncedAt: new Date("2026-08-20T04:00:00.000Z"),
  });

  const read = await repository.listPresentProducts({ shopId, limit: 10 });
  assert.equal(read[0]?.sourceDescription, null);
  assert.equal(read[0]?.primaryImageUrl, null);
});

test("omitting an entire product marks mirror and variants as not present/inactive while preserving source fields and ProductContent", async () => {
  const firstSyncAt = new Date("2026-08-20T03:00:00.000Z");
  const secondSyncAt = new Date("2026-08-20T04:00:00.000Z");

  const initialSnapshot = [
    variation({
      id: "mirror-variation-stale-prod-1",
      productName: "Stale Candidate Product",
      sourceDescription: "Original source description from Pancake.",
      primaryImageUrl: "https://content.pancake.vn/images/1/2/3/stale-prod.jpg",
      displayId: "DISPLAY-STALE-1",
      barcode: "BAR-STALE-1",
      stocks: [{ warehouseId: "warehouse-a", remainQuantity: 5 }],
    }),
  ];

  await repository.syncSnapshot({ shopId, variations: initialSnapshot, syncedAt: firstSyncAt });

  const mirroredProduct = await prisma.productMirror.findFirstOrThrow({
    where: { pancakeShopId: shopId, pancakeProductId: "mirror-product-1" },
  });

  await prisma.productContent.create({
    data: {
      productId: mirroredProduct.id,
      editorialDescription: "Authoritative editorial copy.",
      careInstructions: "Dry clean only.",
      sizeGuide: "Standard sizing.",
      seoTitle: "Stale Product Title",
      seoDescription: "Stale Product Meta Description",
      collectionSlugs: ["heritage-line"],
    },
  });

  // Next sync snapshot completely omits this product
  await repository.syncSnapshot({ shopId, variations: [], syncedAt: secondSyncAt });

  const staleProduct = await prisma.productMirror.findUniqueOrThrow({
    where: { id: mirroredProduct.id },
    include: { content: true, variants: true },
  });

  assert.equal(staleProduct.isPresent, false);
  assert.equal(staleProduct.isActive, false);
  assert.equal(staleProduct.sourceDescription, "Original source description from Pancake.");
  assert.equal(staleProduct.primaryImageUrl, "https://content.pancake.vn/images/1/2/3/stale-prod.jpg");

  assert.equal(staleProduct.variants.length, 1);
  assert.equal(staleProduct.variants[0]?.isPresent, false);
  assert.equal(staleProduct.variants[0]?.isActive, false);

  assert.ok(staleProduct.content);
  assert.equal(staleProduct.content.editorialDescription, "Authoritative editorial copy.");
  assert.equal(staleProduct.content.careInstructions, "Dry clean only.");
  assert.equal(staleProduct.content.sizeGuide, "Standard sizing.");
  assert.equal(staleProduct.content.seoTitle, "Stale Product Title");
  assert.equal(staleProduct.content.seoDescription, "Stale Product Meta Description");
  assert.deepEqual(staleProduct.content.collectionSlugs, ["heritage-line"]);
});




test("I9 availability cycle uses the post-fetch observation day, not the G5 read-start day", async () => {
  const initial = [
    variation({
      id: "mirror-variation-i9-midnight",
      displayId: "DISPLAY-I9-MIDNIGHT",
      barcode: "BAR-I9-MIDNIGHT",
      stocks: [{ warehouseId: "warehouse-a", remainQuantity: 1 }],
    }),
  ];
  await repository.syncSnapshot({
    shopId,
    variations: initial,
    syncedAt: new Date("2026-09-18T16:00:00.000Z"),
    availabilityObservedAt: new Date("2026-09-18T16:00:01.000Z"),
  });

  const product = await prisma.productMirror.findFirstOrThrow({
    where: { pancakeShopId: shopId, pancakeProductId: "mirror-product-1" },
    include: { variants: true },
  });
  await prisma.productSellingPolicy.create({
    data: { productId: product.id, sellingMode: "PREORDER", negativeStockLimit: -20 },
  });

  const soldOut = [
    variation({
      id: "mirror-variation-i9-midnight",
      displayId: "DISPLAY-I9-MIDNIGHT",
      barcode: "BAR-I9-MIDNIGHT",
      stocks: [{ warehouseId: "warehouse-a", remainQuantity: 0 }],
    }),
  ];
  await repository.syncSnapshot({
    shopId,
    variations: soldOut,
    // 23:59:59 in Vietnam: still the 18th. This remains the reservation freshness marker.
    syncedAt: new Date("2026-09-18T16:59:59.000Z"),
    // 00:00:01 in Vietnam: the website only has the completed sold-out snapshot on the 19th.
    availabilityObservedAt: new Date("2026-09-18T17:00:01.000Z"),
  });

  const cycle = await prisma.variantAvailabilityCycle.findUniqueOrThrow({
    where: { variantId: product.variants[0]!.id },
  });
  assert.equal(cycle.cycleStartDate?.toISOString(), "2026-09-19T00:00:00.000Z");
  assert.equal(cycle.availabilityDate?.toISOString(), "2026-10-04T00:00:00.000Z");
});
