import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import {
  buildAdminProductFacetTargets,
  parseAdminProductDirectorySearchParams,
} from "../../src/commerce/admin-product-directory.ts";
import { createProductContentRepository } from "../../src/commerce/product-content-repository.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required for database smoke tests");
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});
const repository = createProductContentRepository(prisma);

const testShopId = 920_010;
// Slug prefix used for cleanup. Individual tests scope their queries with a globally-unique token
// so a full result-set assertion cannot be perturbed by another DB test file running in parallel
// against the same database.
const externalPrefix = "admin-directory-";

function query(searchParams: Record<string, string | string[] | undefined>) {
  return parseAdminProductDirectorySearchParams(searchParams);
}

async function cleanup() {
  await prisma.productMirror.deleteMany({
    where: { pancakeProductId: { startsWith: externalPrefix } },
  });
}

type SeedProduct = Readonly<{
  key: string;
  name: string;
  productCode?: string;
  isActive?: boolean;
  syncedAt: string;
  content?: Readonly<{
    status: "DRAFT" | "REVIEWED" | "PUBLISHED";
    collectionSlugs: string[];
  }>;
}>;

async function seed(product: SeedProduct): Promise<string> {
  const created = await prisma.productMirror.create({
    data: {
      pancakeShopId: testShopId,
      pancakeProductId: `${externalPrefix}${product.key}`,
      slug: `${externalPrefix}${product.key}`,
      name: product.name,
      productCode: product.productCode ?? null,
      isActive: product.isActive ?? true,
      syncedAt: new Date(product.syncedAt),
      ...(product.content
        ? {
            content: {
              create: {
                status: product.content.status,
                collectionSlugs: product.content.collectionSlugs,
              },
            },
          }
        : {}),
    },
    select: { id: true },
  });
  return created.id;
}

test.beforeEach(cleanup);
test.afterEach(cleanup);
test.after(async () => {
  await prisma.$disconnect();
});

test("directory status filter treats a missing ProductContent row as DRAFT", async () => {
  // Unique token in every name scopes the search below to only this test's rows.
  const token = "admdirstatus";
  await seed({ key: "missing", name: `${token} missing`, syncedAt: "2026-08-01T00:00:00.000Z" });
  await seed({
    key: "explicit-draft",
    name: `${token} explicit`,
    syncedAt: "2026-08-02T00:00:00.000Z",
    content: { status: "DRAFT", collectionSlugs: [] },
  });
  await seed({
    key: "reviewed",
    name: `${token} reviewed`,
    syncedAt: "2026-08-03T00:00:00.000Z",
    content: { status: "REVIEWED", collectionSlugs: [] },
  });
  await seed({
    key: "published",
    name: `${token} published`,
    syncedAt: "2026-08-04T00:00:00.000Z",
    content: { status: "PUBLISHED", collectionSlugs: [] },
  });

  const draft = await repository.listDirectoryPage({ query: query({ q: token, status: "DRAFT" }) });
  assert.deepEqual(
    draft.products.map((p) => p.slug).sort(),
    [`${externalPrefix}explicit-draft`, `${externalPrefix}missing`],
  );

  const reviewed = await repository.listDirectoryPage({
    query: query({ q: token, status: "REVIEWED" }),
  });
  assert.deepEqual(
    reviewed.products.map((p) => p.slug),
    [`${externalPrefix}reviewed`],
  );

  const published = await repository.listDirectoryPage({
    query: query({ q: token, status: "PUBLISHED" }),
  });
  assert.deepEqual(
    published.products.map((p) => p.slug),
    [`${externalPrefix}published`],
  );
});

test("directory collection filter and uncategorized sentinel are mutually exclusive views", async () => {
  const token = "admdircoll";
  const collectionSlug = "admdircoll-city";
  await seed({
    key: "in-city",
    name: `${token} city`,
    syncedAt: "2026-08-01T00:00:00.000Z",
    content: { status: "PUBLISHED", collectionSlugs: [collectionSlug] },
  });
  await seed({
    key: "empty-slugs",
    name: `${token} empty`,
    syncedAt: "2026-08-02T00:00:00.000Z",
    content: { status: "DRAFT", collectionSlugs: [] },
  });
  await seed({ key: "no-content", name: `${token} none`, syncedAt: "2026-08-03T00:00:00.000Z" });

  const inCollection = await repository.listDirectoryPage({
    query: query({ q: token, collection: collectionSlug }),
  });
  assert.deepEqual(
    inCollection.products.map((p) => p.slug),
    [`${externalPrefix}in-city`],
  );

  const uncategorized = await repository.listDirectoryPage({
    query: query({ q: token, collection: "none" }),
  });
  assert.deepEqual(
    uncategorized.products.map((p) => p.slug).sort(),
    [`${externalPrefix}empty-slugs`, `${externalPrefix}no-content`],
  );
});

test("directory search matches name and slug case-insensitively; activity narrows the set", async () => {
  // Globally-unique tokens, so each search is self-scoping without an extra filter.
  await seed({ key: "linen-tee", name: "admdirLINEN Tee", syncedAt: "2026-08-01T00:00:00.000Z" });
  await seed({
    key: "admdirwool-coat",
    name: "Plain coat",
    isActive: false,
    syncedAt: "2026-08-02T00:00:00.000Z",
  });

  // Name match is case-insensitive (query lower-case vs stored upper-case).
  const byName = await repository.listDirectoryPage({ query: query({ q: "admdirlinen" }) });
  assert.deepEqual(
    byName.products.map((p) => p.slug),
    [`${externalPrefix}linen-tee`],
  );

  // Slug substring match.
  const bySlug = await repository.listDirectoryPage({ query: query({ q: "admdirwool-coat" }) });
  assert.deepEqual(
    bySlug.products.map((p) => p.slug),
    [`${externalPrefix}admdirwool-coat`],
  );

  // Activity narrows within the same search scope.
  const inactive = await repository.listDirectoryPage({
    query: query({ q: "admdirwool-coat", activity: "inactive" }),
  });
  assert.equal(inactive.products.length, 1);
  const active = await repository.listDirectoryPage({
    query: query({ q: "admdirwool-coat", activity: "active" }),
  });
  assert.equal(active.products.length, 0);
});

test("directory search matches the Pancake product code split off the name", async () => {
  await seed({
    key: "dieu-lien-hoa",
    name: "Set váy Diệu Liên Hoa",
    productCode: "ADMDIRSV605",
    syncedAt: "2026-08-01T00:00:00.000Z",
  });

  const byCode = await repository.listDirectoryPage({ query: query({ q: "admdirsv605" }) });
  assert.deepEqual(
    byCode.products.map((p) => p.slug),
    [`${externalPrefix}dieu-lien-hoa`],
  );
});

test("directory pagination clamps out-of-range pages and honors the sort order", async () => {
  const token = "admdirpage";
  await seed({ key: "a", name: `${token} Alpha`, syncedAt: "2026-08-01T00:00:00.000Z" });
  await seed({ key: "b", name: `${token} Bravo`, syncedAt: "2026-08-03T00:00:00.000Z" });
  await seed({ key: "c", name: `${token} Charlie`, syncedAt: "2026-08-02T00:00:00.000Z" });

  const firstPage = await repository.listDirectoryPage({
    query: query({ q: token, sort: "name-asc" }),
    pageSize: 2,
  });
  assert.equal(firstPage.totalCount, 3);
  assert.equal(firstPage.totalPages, 2);
  assert.equal(firstPage.page, 1);
  assert.deepEqual(
    firstPage.products.map((p) => p.name),
    [`${token} Alpha`, `${token} Bravo`],
  );

  // Page 9 does not exist; the repository clamps to the last real page rather than returning empty.
  const clamped = await repository.listDirectoryPage({
    query: query({ q: token, sort: "name-asc", page: "9" }),
    pageSize: 2,
  });
  assert.equal(clamped.page, 2);
  assert.deepEqual(
    clamped.products.map((p) => p.name),
    [`${token} Charlie`],
  );

  const bySync = await repository.listDirectoryPage({ query: query({ q: token, sort: "synced-desc" }) });
  assert.deepEqual(
    bySync.products.map((p) => p.name),
    [`${token} Bravo`, `${token} Charlie`, `${token} Alpha`],
  );
});

test("facet counts retain every active dimension except the one each facet switches", async () => {
  // Two "shirt" rows (one draft, one published) plus one unrelated "coat", all uniquely tokenized.
  const shirtToken = "admdirfacetshirt";
  const citySlug = "admdirfacet-city";
  await seed({
    key: "shirt-draft",
    name: `${shirtToken} draft`,
    syncedAt: "2026-08-01T00:00:00.000Z",
    content: { status: "DRAFT", collectionSlugs: [citySlug] },
  });
  await seed({
    key: "shirt-published",
    name: `${shirtToken} published`,
    syncedAt: "2026-08-02T00:00:00.000Z",
    content: { status: "PUBLISHED", collectionSlugs: [] },
  });
  await seed({
    key: "coat",
    name: "admdirfacetcoat published",
    syncedAt: "2026-08-03T00:00:00.000Z",
    content: { status: "PUBLISHED", collectionSlugs: [] },
  });

  // Search only: the status facets partition the searched set, and "all" is that whole set.
  const searched = await repository.countDirectoryFacets(
    buildAdminProductFacetTargets(query({ q: shirtToken, status: "PUBLISHED" })),
  );
  assert.equal(searched.all, 2);
  assert.equal(searched.draft, 1);
  assert.equal(searched.published, 1);
  assert.equal(searched.reviewed, 0);
  assert.equal(searched.uncategorized, 1);

  // Collection active: a status facet keeps that collection, so only the row inside it counts.
  // Under the previous behaviour this reported 1 while its own link opened a page of 0.
  const withinCollection = await repository.countDirectoryFacets(
    buildAdminProductFacetTargets(query({ q: shirtToken, collection: citySlug })),
  );
  assert.equal(withinCollection.draft, 1);
  assert.equal(withinCollection.published, 0);
  // "all" drops the collection the facet row owns, but keeps the search term.
  assert.equal(withinCollection.all, 2);
});

test("countProductsByCollectionSlug tallies membership across the scalar slug list", async () => {
  // Globally-unique slugs so the unscoped global count is not perturbed by other test files.
  const citySlug = "admdircount-city";
  const essentialsSlug = "admdircount-essentials";
  await seed({
    key: "one",
    name: "admdircount One",
    syncedAt: "2026-08-01T00:00:00.000Z",
    content: { status: "PUBLISHED", collectionSlugs: [citySlug, essentialsSlug] },
  });
  await seed({
    key: "two",
    name: "admdircount Two",
    syncedAt: "2026-08-02T00:00:00.000Z",
    content: { status: "DRAFT", collectionSlugs: [citySlug] },
  });
  await seed({ key: "three", name: "admdircount Three", syncedAt: "2026-08-03T00:00:00.000Z" });

  const counts = await repository.countProductsByCollectionSlug();
  assert.equal(counts.get(citySlug), 2);
  assert.equal(counts.get(essentialsSlug), 1);
  assert.equal(counts.get("admdircount-missing"), undefined);
});
