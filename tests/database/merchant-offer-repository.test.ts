/**
 * U25 / #153 M3 — the Merchant offer loader against a real database.
 *
 * These cases exist to prove the things a pure-function test cannot: that the loader reads the same
 * catalog the storefront publishes, that availability, media and content come out of the mirror the
 * way the mapper expects, and — the important one — that a Pancake catalog resync cannot erase a
 * website-owned apparel override.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createCatalogMirrorRepository } from "../../src/commerce/catalog-mirror-repository.ts";
import { createMerchantOfferRepository } from "../../src/commerce/merchant-offer-repository.ts";
import { createProductMerchantFactsRepository } from "../../src/commerce/product-merchant-facts-repository.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";
import type {
  PancakeCatalogField,
  PancakeParsedCatalogVariation,
} from "../../src/integrations/pancake/catalog-contract.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required for database smoke tests");
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const catalog = createCatalogMirrorRepository(prisma);
const merchant = createMerchantOfferRepository(prisma);
const merchantFacts = createProductMerchantFactsRepository(prisma);

const SHOP_ID = 920_925;
const ORIGIN = "https://la.example.test";
const SYNCED_AT = new Date("2026-09-04T00:00:00.000Z");
const PRIMARY_IMAGE = "https://content.pancake.vn/web-media/1/2/3/m3-primary.jpg";
const VARIANT_IMAGE = "https://content.pancake.vn/web-media/1/2/3/m3-variant.jpg";

function fields(size: string): PancakeCatalogField[] {
  return [
    { id: "field-color", keyValue: "color", name: "Color", value: "Black" },
    { id: "field-size", keyValue: "size", name: "Size", value: size },
  ];
}

function variation({
  id,
  displayId,
  size,
  quantity,
  retailPrice = 500_000,
}: Readonly<{
  id: string;
  displayId: string;
  size: string;
  quantity: number;
  retailPrice?: number;
}>): PancakeParsedCatalogVariation {
  return {
    id,
    productId: "m3-product-1",
    displayId,
    barcode: `BARCODE-${displayId}`,
    fields: fields(size),
    imageUrls: [VARIANT_IMAGE],
    isHidden: false,
    isLocked: false,
    retailPrice,
    retailPriceAfterDiscount: retailPrice,
    product: {
      id: "m3-product-1",
      name: "M3 Merchant Product",
      sourceDescription: "Pancake source text that is not a Merchant fact",
      primaryImageUrl: PRIMARY_IMAGE,
    },
    warehouseStocks: [{ warehouseId: "warehouse-a", remainQuantity: quantity }],
    sellableStock: quantity,
  };
}

const SNAPSHOT: PancakeParsedCatalogVariation[] = [
  variation({ id: "m3-variation-m", displayId: "A300-M", size: "M", quantity: 5 }),
  variation({ id: "m3-variation-l", displayId: "A300-L", size: "L", quantity: 0 }),
  variation({ id: "m3-variation-xl", displayId: "A300-XL", size: "XL", quantity: 2 }),
];

function batchingSnapshot(count: number): PancakeParsedCatalogVariation[] {
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    return variation({
      id: `m3-batch-${number}`,
      displayId: `BATCH-${number}`,
      size: `SIZE-${number}`,
      quantity: 1,
    });
  });
}

async function cleanup() {
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP_ID } });
  await prisma.catalogSyncState.deleteMany({ where: { pancakeShopId: SHOP_ID } });
}

/** Catalog sync deliberately leaves new rows disabled; the website owns activation. */
async function publishStorefront(description: string | null = "Mo ta bien tap da xuat ban.") {
  const product = await prisma.productMirror.findFirstOrThrow({
    where: { pancakeShopId: SHOP_ID },
    select: { id: true, slug: true },
  });

  await prisma.productMirror.update({ where: { id: product.id }, data: { isActive: true } });
  await prisma.variantMirror.updateMany({
    where: { productId: product.id },
    data: { isActive: true },
  });

  if (description !== null) {
    await prisma.productContent.upsert({
      where: { productId: product.id },
      create: { productId: product.id, status: "PUBLISHED", editorialDescription: description },
      update: { status: "PUBLISHED", editorialDescription: description },
    });
  }

  return product;
}

function read() {
  return merchant.readMerchantOffers({ shopId: SHOP_ID, origin: ORIGIN, now: SYNCED_AT });
}

test.beforeEach(cleanup);
test.afterEach(cleanup);
test.after(async () => {
  await prisma.$disconnect();
});

test("M3 the loader maps the published storefront catalog into Merchant offers", async () => {
  await catalog.syncSnapshot({ shopId: SHOP_ID, variations: SNAPSHOT, syncedAt: SYNCED_AT });
  const product = await publishStorefront();

  const result = await read();

  assert.deepEqual(result.excluded, []);
  assert.equal(result.offers.length, 3);

  const medium = result.offers.find((offer) => offer.size === "M");
  assert.ok(medium);
  assert.equal(medium.id, "m3-variation-m");
  assert.equal(medium.itemGroupId, "m3-product-1");
  assert.equal(medium.brand, "La.na Design");
  // ADR 0008: the manufacturer MPN is the mirrored Pancake display_id.
  assert.equal(medium.mpn, "A300-M");
  assert.equal(medium.link, `${ORIGIN}/shop/${product.slug}?variant=m3-variation-m`);
  // The variant carries its own trusted photography, so that is the offer image; the product's
  // primary stays as an additional image rather than being dropped.
  assert.equal(medium.imageLink, VARIANT_IMAGE);
  assert.deepEqual(medium.additionalImageLinks, [PRIMARY_IMAGE]);
  assert.equal(medium.availability, "in_stock");
  assert.equal(medium.priceVnd, 500_000);
  assert.equal(medium.color, "Black");
  assert.deepEqual([medium.gender, medium.ageGroup, medium.condition], ["female", "adult", "new"]);
  assert.equal(medium.description, "Mo ta bien tap da xuat ban.");

  // Merchant identity never leaks an internal handle or a barcode.
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("BARCODE-"), false);
  assert.equal(serialized.includes("gtin"), false);

  // A zero-stock but structurally valid option is still published, as out_of_stock.
  const large = result.offers.find((offer) => offer.size === "L");
  assert.ok(large);
  assert.equal(large.availability, "out_of_stock");
  assert.equal(large.priceVnd, 500_000);
});

test("M3 the local website-owned SKU never becomes the Merchant MPN", async () => {
  await catalog.syncSnapshot({ shopId: SHOP_ID, variations: SNAPSHOT, syncedAt: SYNCED_AT });
  await publishStorefront();

  await prisma.variantMirror.updateMany({
    where: { pancakeVariationId: "m3-variation-m" },
    data: { sku: "LOCAL-INTERNAL-CODE" },
  });

  const withLocalSku = await read();
  assert.equal(
    withLocalSku.offers.find((offer) => offer.id === "m3-variation-m")?.mpn,
    "A300-M",
  );
  assert.equal(JSON.stringify(withLocalSku).includes("LOCAL-INTERNAL-CODE"), false);

  // Removing the manufacturer MPN excludes the offer instead of falling back to the local code.
  await prisma.variantMirror.updateMany({
    where: { pancakeVariationId: "m3-variation-m" },
    data: { pancakeDisplayId: null },
  });

  const withoutMpn = await read();
  assert.equal(withoutMpn.offers.some((offer) => offer.id === "m3-variation-m"), false);
  assert.deepEqual(
    withoutMpn.excluded.find((entry) => entry.pancakeVariationId === "m3-variation-m")?.reasons,
    ["MPN_UNRESOLVED"],
  );
});

test("M3 an unresolved warehouse quantity excludes the offer fail-closed", async () => {
  await catalog.syncSnapshot({ shopId: SHOP_ID, variations: SNAPSHOT, syncedAt: SYNCED_AT });
  await publishStorefront();

  await prisma.$executeRaw`
    UPDATE "WarehouseStock" SET "quantity" = -3
    WHERE "variantId" IN (
      SELECT "id" FROM "VariantMirror" WHERE "pancakeVariationId" = 'm3-variation-xl'
    )`;

  const result = await read();
  assert.equal(result.offers.some((offer) => offer.id === "m3-variation-xl"), false);
  assert.deepEqual(
    result.excluded.find((entry) => entry.pancakeVariationId === "m3-variation-xl")?.reasons,
    ["AVAILABILITY_UNRESOLVED"],
  );
});

test("M3 an unpublished description excludes every offer of that product", async () => {
  await catalog.syncSnapshot({ shopId: SHOP_ID, variations: SNAPSHOT, syncedAt: SYNCED_AT });
  const product = await publishStorefront(null);

  const withoutContent = await read();
  assert.deepEqual(withoutContent.offers, []);
  assert.equal(withoutContent.excluded.length, 3);
  for (const entry of withoutContent.excluded) {
    assert.deepEqual(entry.reasons, ["DESCRIPTION_UNRESOLVED"]);
  }

  // A Draft description is work in progress, not a Merchant fact, so it does not unblock anything.
  await prisma.productContent.upsert({
    where: { productId: product.id },
    create: { productId: product.id, status: "DRAFT", editorialDescription: "Ban nhap." },
    update: { status: "DRAFT", editorialDescription: "Ban nhap." },
  });

  const withDraft = await read();
  assert.deepEqual(withDraft.offers, []);
  assert.equal(JSON.stringify(withDraft).includes("Ban nhap."), false);
});

test("M3 a product the storefront does not publish contributes no offers", async () => {
  await catalog.syncSnapshot({ shopId: SHOP_ID, variations: SNAPSHOT, syncedAt: SYNCED_AT });
  const product = await publishStorefront();

  await prisma.productMirror.update({ where: { id: product.id }, data: { isActive: false } });
  assert.deepEqual(await read(), {
    offers: [],
    excluded: [],
    market: { status: "UNRESOLVED", reason: "MERCHANT_MARKET_UNRESOLVED" },
    activationBlockedReasons: ["MERCHANT_MARKET_UNRESOLVED"],
  });

  // A deactivated single variant disappears from the authorized option list with it.
  await prisma.productMirror.update({ where: { id: product.id }, data: { isActive: true } });
  await prisma.variantMirror.updateMany({
    where: { pancakeVariationId: "m3-variation-l" },
    data: { isActive: false },
  });

  const result = await read();
  assert.deepEqual(
    result.offers.map((offer) => offer.id).sort(),
    ["m3-variation-m", "m3-variation-xl"],
  );
  assert.deepEqual(result.excluded, []);
});

test("M3 composite membership defers every option the product presents", async () => {
  await catalog.syncSnapshot({ shopId: SHOP_ID, variations: SNAPSHOT, syncedAt: SYNCED_AT });
  await publishStorefront();

  const [parent, component] = await prisma.variantMirror.findMany({
    where: { pancakeVariationId: { in: ["m3-variation-m", "m3-variation-l"] } },
    orderBy: [{ pancakeVariationId: "asc" }],
    select: { id: true },
  });
  assert.ok(parent && component);

  await prisma.compositeComponentMirror.create({
    data: {
      parentVariantId: component.id,
      componentVariantId: parent.id,
      quantity: 1,
      syncedAt: SYNCED_AT,
    },
  });

  const result = await read();
  assert.deepEqual(result.offers, []);
  assert.equal(result.excluded.length, 3);
  for (const entry of result.excluded) {
    assert.deepEqual(entry.reasons, ["COMPOSITE_DEFERRED"]);
  }
});

test("M3 apparel overrides are website-owned and a Pancake resync cannot erase them", async () => {
  await catalog.syncSnapshot({ shopId: SHOP_ID, variations: SNAPSHOT, syncedAt: SYNCED_AT });
  const product = await publishStorefront();

  const inherited = await read();
  assert.equal(inherited.offers[0]!.gender, "female");
  assert.deepEqual(await merchantFacts.readOverrides(product.id), {
    gender: null,
    ageGroup: null,
    condition: null,
  });

  // Both override values differ from the approved shop defaults (`female` / `adult`), so an
  // override that silently stopped applying would read as the default rather than as itself.
  await merchantFacts.saveOverrides(product.id, {
    gender: "male",
    ageGroup: "kids",
    condition: null,
  });

  const overridden = await read();
  for (const offer of overridden.offers) {
    assert.deepEqual([offer.gender, offer.ageGroup, offer.condition], ["male", "kids", "new"]);
  }

  // The regression that matters: a full catalog resync rewrites the Pancake mirror and must leave
  // the website-owned Merchant decision exactly where the merchandiser put it.
  await catalog.syncSnapshot({
    shopId: SHOP_ID,
    variations: SNAPSHOT,
    syncedAt: new Date("2026-09-05T00:00:00.000Z"),
  });

  assert.deepEqual(await merchantFacts.readOverrides(product.id), {
    gender: "male",
    ageGroup: "kids",
    condition: null,
  });

  await publishStorefront();
  for (const offer of (await read()).offers) {
    assert.deepEqual([offer.gender, offer.ageGroup, offer.condition], ["male", "kids", "new"]);
  }
});

test("M3 clearing an override returns the product to inheritance without storing a default copy", async () => {
  await catalog.syncSnapshot({ shopId: SHOP_ID, variations: SNAPSHOT, syncedAt: SYNCED_AT });
  const product = await publishStorefront();

  await merchantFacts.saveOverrides(product.id, {
    gender: "unisex",
    ageGroup: null,
    condition: null,
  });
  assert.equal(
    await prisma.productMerchantFacts.count({ where: { productId: product.id } }),
    1,
  );

  await merchantFacts.saveOverrides(product.id, {
    gender: null,
    ageGroup: null,
    condition: null,
  });

  assert.equal(
    await prisma.productMerchantFacts.count({ where: { productId: product.id } }),
    0,
    "clearing must remove the override row rather than persist the current shop default",
  );
  assert.equal((await read()).offers[0]!.gender, "female");
});

test("M3 a persisted apparel value outside the reviewed allowlist fails closed", async () => {
  await catalog.syncSnapshot({ shopId: SHOP_ID, variations: SNAPSHOT, syncedAt: SYNCED_AT });
  const product = await publishStorefront();

  // The database enum already refuses this, which is the first line of defence.
  await assert.rejects(
    () =>
      prisma.$executeRaw`
        INSERT INTO "ProductMerchantFacts" ("id","productId","gender","createdAt","updatedAt")
        VALUES ('m3-bad-facts', ${product.id}, 'ROBOT', NOW(), NOW())`,
  );

  // And the resolver is the second: a value that somehow reached the row excludes the offers.
  const overrides = { gender: "nam", ageGroup: null, condition: null };
  const products = await merchant.readCandidateProducts({ shopId: SHOP_ID, now: SYNCED_AT });
  const { mapMerchantOffers } = await import("../../src/commerce/merchant-offer-mapper.ts");
  const result = mapMerchantOffers({
    products: products.map((candidate) => ({ ...candidate, apparelOverrides: overrides })),
    origin: ORIGIN,
  });

  assert.deepEqual(result.offers, []);
  for (const entry of result.excluded) {
    assert.deepEqual(entry.reasons, ["APPAREL_FACT_UNRESOLVED"]);
  }
});

test("M4 the loader stays inside the whole-generation query envelope as offer count grows", async () => {
  let queries = 0;
  const counting = new PrismaClient({ adapter: new PrismaPg({ connectionString }) }).$extends({
    query: {
      async $allOperations({ args, query }) {
        queries += 1;
        return query(args);
      },
    },
  });
  const counted = createMerchantOfferRepository(counting as unknown as PrismaClient);

  await catalog.syncSnapshot({
    shopId: SHOP_ID,
    variations: batchingSnapshot(200),
    syncedAt: SYNCED_AT,
  });
  await publishStorefront();
  const at200 = await counted.readMerchantOffers({ shopId: SHOP_ID, origin: ORIGIN, now: SYNCED_AT });
  const queriesAt200 = queries;
  assert.equal(at200.offers.length, 200);
  assert.ok(queriesAt200 > 0 && queriesAt200 <= 8);

  queries = 0;
  await catalog.syncSnapshot({
    shopId: SHOP_ID,
    variations: batchingSnapshot(201),
    syncedAt: SYNCED_AT,
  });
  await publishStorefront();
  const at201 = await counted.readMerchantOffers({ shopId: SHOP_ID, origin: ORIGIN, now: SYNCED_AT });
  const queriesAt201 = queries;
  assert.equal(at201.offers.length, 201);

  // U26 replaces the old 200-id promotion batching path with a flat, bounded feed loader. Crossing
  // 200 offers must not add query batches; the stricter public-feed contract is <=8 DB operations.
  assert.equal(queriesAt201, queriesAt200);
  assert.ok(
    queriesAt201 <= 8,
    `expected <=8 whole-generation reads, observed ${queriesAt201} for ${at201.offers.length} offers`,
  );

  await counting.$disconnect();
});
