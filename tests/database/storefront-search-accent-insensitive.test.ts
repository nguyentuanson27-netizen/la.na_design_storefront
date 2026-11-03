/** Storefront search ignores Vietnamese marks and matches every word of the query in any order. */

import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createStorefrontCatalogRepository } from "../../src/commerce/storefront-catalog.ts";
import type { StorefrontDiscoveryQuery } from "../../src/commerce/storefront-discovery.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const repository = createStorefrontCatalogRepository(prisma);

const P = "search-fold";
const SHOP = 920_961;
const NOW = new Date("2026-11-01T12:00:00.000Z");

const PRODUCTS = [
  { key: "ao-dai", name: "Áo dài cách tân Tơ Gương", code: "AD101" },
  { key: "set-vay", name: "Set Váy Tơ Gương Thêu Hoa Sen", code: "SV605" },
  { key: "dam", name: "Đầm xòe 100% lụa", code: "DX300" },
  // Stored decomposed (base letter + combining mark), as a name pasted from some sources arrives.
  { key: "nfd", name: "Chân váy xếp ly".normalize("NFD"), code: "CV77\u0301".normalize("NFD") },
] as const;

function query(overrides: Partial<StorefrontDiscoveryQuery>): StorefrontDiscoveryQuery {
  return {
    query: null,
    collection: null,
    color: null,
    size: null,
    availability: null,
    minPriceVnd: null,
    maxPriceVnd: null,
    page: 1,
    sort: "name-asc",
    ...overrides,
  };
}

async function cleanup() {
  await prisma.$executeRaw`DELETE FROM "ProductMirror" WHERE "pancakeProductId" LIKE ${`${P}-%`}`;
}

async function search(text: string): Promise<string[]> {
  const page = await repository.listDiscoveryPage({
    shopId: SHOP,
    pageSize: 24,
    discovery: query({ query: text }),
    now: NOW,
  });
  return page.products.map((product: { name: string }) => product.name).sort();
}

test.before(async () => {
  await cleanup();
  for (const product of PRODUCTS) {
    const created = await prisma.productMirror.create({
      data: {
        pancakeShopId: SHOP,
        pancakeProductId: `${P}-${product.key}`,
        slug: `${P}-${product.key}`,
        name: product.name,
        productCode: product.code,
        isPresent: true,
        isActive: true,
        syncedAt: NOW,
      },
    });
    const variant = await prisma.variantMirror.create({
      data: {
        pancakeVariationId: `${P}-pv-${product.key}`,
        productId: created.id,
        color: "Kem",
        size: "M",
        pancakeRetailPrice: 799_000,
        pancakeRetailPriceAfterDiscount: 799_000,
        isPresent: true,
        isActive: true,
        syncedAt: NOW,
      },
    });
    await prisma.warehouseStock.create({
      data: { variantId: variant.id, pancakeWarehouseId: `${P}-wh-${product.key}`, quantity: 5, syncedAt: NOW },
    });
  }
});

test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("a query typed without marks finds the product written with marks", async () => {
  assert.deepEqual(await search("ao dai"), ["Áo dài cách tân Tơ Gương"]);
  assert.deepEqual((await search("vay")).map((n) => n.normalize("NFC")), ["Chân váy xếp ly", "Set Váy Tơ Gương Thêu Hoa Sen"]);
  assert.deepEqual(await search("dam"), ["Đầm xòe 100% lụa"]);
});

test("a name stored in decomposed Unicode is found by the same queries", async () => {
  const stored = await prisma.productMirror.findFirstOrThrow({ where: { pancakeProductId: `${P}-nfd` } });
  assert.notEqual(stored.name, stored.name.normalize("NFC"), "the fixture really is decomposed");
  const found = (text: string) => search(text).then((names) => names.map((n) => n.normalize("NFC")));
  assert.deepEqual(await found("chan vay xep ly"), ["Chân váy xếp ly"]);
  assert.deepEqual(await found("chân váy"), ["Chân váy xếp ly"]);
  assert.deepEqual(await found("xep"), ["Chân váy xếp ly"]);
  // The composed and the decomposed product are both "váy" and are both returned.
  assert.equal((await search("vay")).length, 2);
});

test("a query with marks still works, in either case", async () => {
  assert.deepEqual(await search("áo dài"), ["Áo dài cách tân Tơ Gương"]);
  assert.deepEqual(await search("ĐẦM"), ["Đầm xòe 100% lụa"]);
});

test("every word must match, in any order and not necessarily adjacent", async () => {
  assert.deepEqual(await search("vay hoa sen"), ["Set Váy Tơ Gương Thêu Hoa Sen"]);
  assert.deepEqual(await search("sen hoa vay"), ["Set Váy Tơ Gương Thêu Hoa Sen"]);
  assert.deepEqual(await search("to guong"), ["Set Váy Tơ Gương Thêu Hoa Sen", "Áo dài cách tân Tơ Gương"].sort());
  assert.deepEqual(await search("vay dam"), []);
});

test("the product code is still searchable, in any case", async () => {
  assert.deepEqual(await search("sv605"), ["Set Váy Tơ Gương Thêu Hoa Sen"]);
  assert.deepEqual(await search("SV605 vay"), ["Set Váy Tơ Gương Thêu Hoa Sen"]);
});

test("LIKE metacharacters in the query are literal", async () => {
  assert.deepEqual(await search("100%"), ["Đầm xòe 100% lụa"]);
  assert.deepEqual(await search("%"), ["Đầm xòe 100% lụa"]);
  assert.deepEqual(await search("_"), []);
});
