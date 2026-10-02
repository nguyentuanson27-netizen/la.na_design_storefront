import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import {
  ADMIN_PRODUCT_HEALTH_KEYS,
  buildAdminProductHealthTargets,
  parseAdminProductDirectorySearchParams,
} from "../../src/commerce/admin-product-directory.ts";
import { trustedProductImageUrlProbeSql } from "../../src/commerce/admin-product-health.ts";
import {
  MAX_MEDIA_CANDIDATES_SCANNED,
  parseTrustedProductImageUrl,
  resolveStorefrontProductMedia,
} from "../../src/commerce/product-media.ts";
import { createProductContentRepository } from "../../src/commerce/product-content-repository.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const repository = createProductContentRepository(prisma);

const shopId = 920_142;
const syncedAt = new Date("2026-08-28T00:00:00.000Z");
const externalPrefix = "admin-health-";

/** Products are named with this token so a result-set assertion cannot see another test's rows. */
const token = "healthfixture";

const trustedUrl = (id: number) => `https://content.pancake.vn/media/1/2/${id}/photo.jpg`;
const rejectedUrl = (id: number) => `https://cdn.example.com/media/1/2/${id}/photo.jpg`;

async function cleanup() {
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: shopId } });
}

test.beforeEach(cleanup);
test.afterEach(cleanup);
test.after(async () => {
  await prisma.$disconnect();
});

type SeedVariant = Readonly<{
  key: string;
  isPresent?: boolean;
  isActive?: boolean;
  imageUrls?: unknown;
  stocks?: readonly number[];
}>;

/**
 * Content written straight to the row rather than through `parseTextField`, so a legacy value the
 * editor could never save today — a blank or whitespace-only field — is still expressible here.
 */
type SeedContent = Readonly<{
  status?: "DRAFT" | "REVIEWED" | "PUBLISHED";
  editorialDescription?: string | null;
  careInstructions?: string | null;
  sizeGuide?: string | null;
  seoTitle?: string | null;
  seoDescription?: string | null;
  collectionSlugs?: readonly string[];
}>;

type SeedProduct = Readonly<{
  key: string;
  isActive?: boolean;
  primaryImageUrl?: string | null;
  variants?: readonly SeedVariant[];
  collectionSlugs?: readonly string[];
  content?: SeedContent;
}>;

async function seedProduct(product: SeedProduct): Promise<string> {
  const content = product.content ?? (product.collectionSlugs ? {} : null);
  const created = await prisma.productMirror.create({
    data: {
      pancakeShopId: shopId,
      pancakeProductId: `${externalPrefix}${product.key}`,
      slug: `${externalPrefix}${product.key}`,
      name: `${token} ${product.key}`,
      primaryImageUrl: product.primaryImageUrl ?? null,
      isPresent: true,
      isActive: product.isActive ?? true,
      syncedAt,
      ...(content
        ? {
            content: {
              create: {
                status: content.status ?? "DRAFT",
                editorialDescription: content.editorialDescription ?? null,
                careInstructions: content.careInstructions ?? null,
                sizeGuide: content.sizeGuide ?? null,
                seoTitle: content.seoTitle ?? null,
                seoDescription: content.seoDescription ?? null,
                collectionSlugs: [
                  ...(content.collectionSlugs ?? product.collectionSlugs ?? []),
                ],
              },
            },
          }
        : {}),
    },
  });

  for (const variant of product.variants ?? []) {
    await prisma.variantMirror.create({
      data: {
        pancakeVariationId: `${externalPrefix}${product.key}-${variant.key}`,
        productId: created.id,
        isPresent: variant.isPresent ?? true,
        isActive: variant.isActive ?? true,
        pancakeImageUrls:
          variant.imageUrls === undefined ? undefined : (variant.imageUrls as never),
        syncedAt,
        ...(variant.stocks
          ? {
              warehouseStocks: {
                create: variant.stocks.map((quantity, index) => ({
                  pancakeWarehouseId: `wh-${index}`,
                  quantity,
                  syncedAt,
                })),
              },
            }
          : {}),
      },
    });
  }

  return created.id;
}

function healthQuery(health: string | undefined) {
  return parseAdminProductDirectorySearchParams({ q: token, ...(health ? { health } : {}) });
}

async function listIds(health: string | undefined): Promise<string[]> {
  const page = await repository.listDirectoryPage({ query: healthQuery(health) });
  return page.products.map(({ id }) => id).sort();
}

/**
 * The storefront's own answer for a product, built from the same inputs
 * `src/commerce/storefront-catalog.ts` passes to the resolver.
 */
async function storefrontPrimaryIsNull(productId: string): Promise<boolean> {
  const product = await prisma.productMirror.findUniqueOrThrow({
    where: { id: productId },
    select: {
      name: true,
      primaryImageUrl: true,
      variants: {
        where: { isPresent: true, isActive: true },
        orderBy: [{ pancakeVariationId: "asc" }],
        select: { pancakeImageUrls: true },
      },
    },
  });

  const media = resolveStorefrontProductMedia({
    productName: product.name,
    primaryImageUrl: product.primaryImageUrl,
    variantImageUrls: product.variants.map((variant) =>
      Array.isArray(variant.pancakeImageUrls)
        ? variant.pancakeImageUrls.filter((item): item is string => typeof item === "string")
        : [],
    ),
  });
  return media.primary === null;
}

test("the database image-trust predicate matches parseTrustedProductImageUrl", async () => {
  const fixtures = [
    "https://content.pancake.vn/media/1/2/3/photo.jpg",
    "  https://content.pancake.vn/media/1/2/3/photo.jpg  ",
    "https://content.pancake.vn/media/1/2/3/photo.jpg?v=2",
    "https://content.pancake.vn/media/1/2/3/photo.jpg#frag",
    "https://content.pancake.vn/media/1/2/3/photo-1_a.jpg",
    "HTTPS://content.pancake.vn/media/1/2/3/photo.jpg",
    "https://content.pancake.vn/media/1/2/3/./photo.jpg",
    "https://content.pancake.vn/media/1/2/3/photo.JPG",
    "https://content.pancake.vn/media/1/2/3/photo.png",
    "https://content.pancake.vn/media/1/2/3/photo.jpg.png",
    "https://content.pancake.vn/web-media-263/aa/bb/cc/dd/photo.jpeg",
    "https://content.pancake.vn/web-media-263/aa/bb/cc/dd/meta/photo.jpeg",
    "https://content.pancake.vn/web-media-263/aa/bb/cc/photo.jpeg",
    "https://content.pancake.vn/web-media-263/aa/bb/cc/dd/ee/ff/photo.jpeg",
    "https://content.pancake.vn/media/1/2/photo.jpg",
    "https://content.pancake.vn/media/1/2/3/4/photo.jpg",
    "https://content.pancake.vn/media/1/2/3/photo..jpg",
    "https://content.pancake.vn/media/1/2/3/../photo.jpg",
    "https://content.pancake.vn/media/1/2/3/%2e%2e/photo.jpg",
    "https://content.pancake.vn/media/1/2/3/x/%2e/photo.jpg",
    "https://content.pancake.vn/media/1/2/3/x/%2e./photo.jpg",
    "https://content.pancake.vn/media/1/2/3/x/.%2e/photo.jpg",
    "https://content.pancake.vn//media/1/2/3/photo.jpg",
    "https://content.pancake.vn:443/media/1/2/3/photo.jpg",
    "https://user:pass@content.pancake.vn/media/1/2/3/photo.jpg",
    "https://CONTENT.PANCAKE.VN/media/1/2/3/photo.jpg",
    "https://content.pancake.vn.evil.com/media/1/2/3/photo.jpg",
    "https://evil.com/media/1/2/3/photo.jpg",
    "http://content.pancake.vn/media/1/2/3/photo.jpg",
    "//content.pancake.vn/media/1/2/3/photo.jpg",
    "https://content.pancake.vn/media/a/2/3/photo.jpg",
    "https://content.pancake.vn/media/1/2/3/pho to.jpg",
    "https://content.pancake.vn/med ia/1/2/3/photo.jpg",
    "https://content.pancake.vn/media/1/2/3/photo%41.jpg",
    "https://content.pancake.vn/",
    "https://content.pancake.vn",
    "not a url",
    "",
    "   ",
    `https://content.pancake.vn/media/1/2/3/${"a".repeat(5000)}.jpg`,
  ];

  for (const fixture of fixtures) {
    const rows = await prisma.$queryRaw<{ trusted: boolean }[]>(
      trustedProductImageUrlProbeSql(fixture),
    );
    assert.equal(
      rows[0]?.trusted,
      parseTrustedProductImageUrl(fixture) !== null,
      `database trust decision drifted for ${JSON.stringify(fixture)}`,
    );
  }
});

test("stocked-inactive uses summed warehouse stock, not any positive warehouse row", async () => {
  const summedPositive = await seedProduct({
    key: "stock-positive",
    variants: [{ key: "v1", isActive: false, stocks: [-1, 3] }],
  });
  const summedZero = await seedProduct({
    key: "stock-zero",
    variants: [{ key: "v1", isActive: false, stocks: [5, -5] }],
  });
  const stockedButActive = await seedProduct({
    key: "stock-active",
    variants: [{ key: "v1", isActive: true, stocks: [4] }],
  });
  const stockedButStale = await seedProduct({
    key: "stock-stale",
    variants: [{ key: "v1", isPresent: false, isActive: false, stocks: [4] }],
  });

  assert.deepEqual(await listIds("stocked-inactive"), [summedPositive]);
  assert.notEqual(summedZero, undefined);
  assert.notEqual(stockedButActive, undefined);
  assert.notEqual(stockedButStale, undefined);

  const metrics = (await repository.listDirectoryPage({ query: healthQuery(undefined) })).metrics;
  assert.equal(metrics.get(summedPositive)?.stockedInactiveCount, 1);
  assert.equal(metrics.get(summedZero)?.stockedInactiveCount, 0);
  assert.equal(metrics.get(stockedButActive)?.stockedInactiveCount, 0);
  assert.equal(
    metrics.get(stockedButStale)?.presentVariantCount,
    0,
    "stale variants are not part of the row metrics",
  );
});

test("zero-active selects products with no present active variant", async () => {
  const zeroActive = await seedProduct({
    key: "zero-active",
    variants: [{ key: "v1", isActive: false }],
  });
  const staleOnlyActive = await seedProduct({
    key: "zero-active-stale",
    variants: [{ key: "v1", isPresent: false, isActive: true }],
  });
  const noVariants = await seedProduct({ key: "zero-active-empty" });
  const active = await seedProduct({
    key: "zero-active-ok",
    variants: [{ key: "v1", isActive: true }],
  });

  assert.deepEqual(
    await listIds("zero-active"),
    [zeroActive, staleOnlyActive, noVariants].sort(),
  );

  const metrics = (await repository.listDirectoryPage({ query: healthQuery(undefined) })).metrics;
  assert.deepEqual(
    {
      active: metrics.get(active)?.activeVariantCount,
      total: metrics.get(active)?.presentVariantCount,
    },
    { active: 1, total: 1 },
  );
  assert.deepEqual(
    {
      active: metrics.get(zeroActive)?.activeVariantCount,
      total: metrics.get(zeroActive)?.presentVariantCount,
    },
    { active: 0, total: 1 },
  );
});

test("missing-image matches the effective storefront media resolution", async () => {
  const trustedPrimary = await seedProduct({
    key: "image-primary",
    primaryImageUrl: trustedUrl(1),
    variants: [{ key: "v1", imageUrls: [rejectedUrl(1)] }],
  });
  const untrustedPrimaryOnly = await seedProduct({
    key: "image-primary-untrusted",
    primaryImageUrl: rejectedUrl(2),
  });
  const variantFallback = await seedProduct({
    key: "image-variant-fallback",
    variants: [
      { key: "a", imageUrls: [rejectedUrl(3)] },
      { key: "b", imageUrls: [trustedUrl(4)] },
    ],
  });
  const inactiveVariantOnly = await seedProduct({
    key: "image-inactive-variant",
    variants: [{ key: "a", isActive: false, imageUrls: [trustedUrl(5)] }],
  });
  const staleVariantOnly = await seedProduct({
    key: "image-stale-variant",
    variants: [{ key: "a", isPresent: false, imageUrls: [trustedUrl(6)] }],
  });
  const nonArrayImages = await seedProduct({
    key: "image-non-array",
    variants: [{ key: "a", imageUrls: { url: trustedUrl(7) } }],
  });
  const nonStringEntries = await seedProduct({
    key: "image-non-string",
    variants: [{ key: "a", imageUrls: [42, null, trustedUrl(8)] }],
  });

  const missing = await listIds("missing-image");
  assert.deepEqual(
    missing,
    [untrustedPrimaryOnly, inactiveVariantOnly, staleVariantOnly, nonArrayImages].sort(),
  );

  for (const productId of [
    trustedPrimary,
    untrustedPrimaryOnly,
    variantFallback,
    inactiveVariantOnly,
    staleVariantOnly,
    nonArrayImages,
    nonStringEntries,
  ]) {
    assert.equal(
      missing.includes(productId),
      await storefrontPrimaryIsNull(productId),
      `admin missing-image drifted from the storefront resolver for ${productId}`,
    );
  }
});

test("missing-image honours the 100-candidate scan bound exactly", async () => {
  const rejectedNinetyNine = Array.from({ length: 99 }, (_, index) => rejectedUrl(index));
  const rejectedHundred = Array.from({ length: 100 }, (_, index) => rejectedUrl(index));

  const trustedAtHundred = await seedProduct({
    key: "image-bound-100",
    variants: [
      { key: "a", imageUrls: rejectedNinetyNine },
      { key: "b", imageUrls: [trustedUrl(100)] },
    ],
  });
  const trustedAtHundredAndOne = await seedProduct({
    key: "image-bound-101",
    variants: [
      { key: "a", imageUrls: rejectedHundred },
      { key: "b", imageUrls: [trustedUrl(101)] },
    ],
  });

  assert.equal(MAX_MEDIA_CANDIDATES_SCANNED, 100);
  assert.deepEqual(await listIds("missing-image"), [trustedAtHundredAndOne]);
  assert.equal(await storefrontPrimaryIsNull(trustedAtHundred), false);
  assert.equal(
    await storefrontPrimaryIsNull(trustedAtHundredAndOne),
    true,
    "storefront resolves no primary once the scan bound is spent",
  );

  const metrics = (await repository.listDirectoryPage({ query: healthQuery(undefined) })).metrics;
  assert.equal(metrics.get(trustedAtHundred)?.missingImage, false);
  assert.equal(metrics.get(trustedAtHundredAndOne)?.missingImage, true);
});

test("health filters compose with other dimensions and stay count-accurate before pagination", async () => {
  const matching = await seedProduct({
    key: "compose-match",
    isActive: false,
    collectionSlugs: [],
    variants: [{ key: "v1", isActive: false, stocks: [2] }],
  });
  await seedProduct({
    key: "compose-active-product",
    isActive: true,
    variants: [{ key: "v1", isActive: false, stocks: [2] }],
  });
  await seedProduct({
    key: "compose-no-stock",
    isActive: false,
    variants: [{ key: "v1", isActive: false, stocks: [0] }],
  });

  const composed = parseAdminProductDirectorySearchParams({
    q: token,
    health: "stocked-inactive",
    activity: "inactive",
  });
  const page = await repository.listDirectoryPage({ query: composed });
  assert.deepEqual(
    page.products.map(({ id }) => id),
    [matching],
  );
  assert.equal(page.totalCount, 1);

  const counts = await repository.countDirectoryFacets({ composed, unfiltered: healthQuery(undefined) });
  assert.equal(counts.composed, 1, "a chip count describes exactly the query its link opens");
  assert.equal(counts.unfiltered, 3);
});

test("a health page slices the full-catalog result set rather than filtering one page", async () => {
  for (let index = 0; index < 5; index += 1) {
    await seedProduct({
      key: `paged-${index}`,
      variants: [{ key: "v1", isActive: false, stocks: [1] }],
    });
  }

  const firstPage = await repository.listDirectoryPage({
    query: healthQuery("stocked-inactive"),
    pageSize: 2,
  });
  assert.equal(firstPage.totalCount, 5);
  assert.equal(firstPage.totalPages, 3);
  assert.equal(firstPage.products.length, 2);

  const lastPage = await repository.listDirectoryPage({
    query: { ...healthQuery("stocked-inactive"), page: 3 },
    pageSize: 2,
  });
  assert.equal(lastPage.page, 3);
  assert.equal(lastPage.products.length, 1);
});

/**
 * The `hasText` reading `src/commerce/catalog-acceptance.ts` applies to the same two content
 * dimensions: a field counts as present only when it still has characters after `String.trim()`.
 */
function hasText(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

test("missing-seo needs both SEO fields, matching the catalog acceptance reading", async () => {
  const complete = await seedProduct({
    key: "seo-complete",
    content: { seoTitle: "Áo linen", seoDescription: "Mô tả tìm kiếm." },
  });
  const titleOnly = await seedProduct({
    key: "seo-title-only",
    content: { seoTitle: "Áo linen", seoDescription: null },
  });
  const descriptionOnly = await seedProduct({
    key: "seo-description-only",
    content: { seoTitle: null, seoDescription: "Mô tả tìm kiếm." },
  });
  const neither = await seedProduct({
    key: "seo-neither",
    content: { editorialDescription: "Nội dung biên tập đầy đủ." },
  });
  const noContentRow = await seedProduct({ key: "seo-no-content-row" });

  assert.deepEqual(
    await listIds("missing-seo"),
    [titleOnly, descriptionOnly, neither, noContentRow].sort(),
    "a product is SEO-complete only when both seoTitle and seoDescription carry text",
  );
  assert.notEqual(complete, undefined);

  const page = await repository.listDirectoryPage({ query: healthQuery("missing-seo") });
  assert.equal(page.totalCount, 4);
});

test("missing-editorial is the editorial description alone, not the whole editorial section", async () => {
  const complete = await seedProduct({
    key: "editorial-complete",
    content: { editorialDescription: "Bản phối vải linen dệt tại xưởng." },
  });
  const notesOnly = await seedProduct({
    key: "editorial-notes-only",
    content: {
      editorialDescription: null,
      careInstructions: "Giặt tay.",
      sizeGuide: "Bảng size chuẩn.",
    },
  });
  const emptyRow = await seedProduct({
    key: "editorial-empty-row",
    content: { seoTitle: "Có SEO", seoDescription: "Có mô tả SEO." },
  });
  const noContentRow = await seedProduct({ key: "editorial-no-content-row" });

  assert.deepEqual(
    await listIds("missing-editorial"),
    [notesOnly, emptyRow, noContentRow].sort(),
    "care instructions and the size guide do not satisfy the editorial health state",
  );
  assert.equal(
    (await listIds("missing-editorial")).includes(complete),
    false,
    "an editorial description alone completes the editorial health state",
  );

  const page = await repository.listDirectoryPage({ query: healthQuery("missing-editorial") });
  assert.equal(page.totalCount, 3);
});

test("a product with no ProductContent row is missing both content health states", async () => {
  const noContentRow = await seedProduct({ key: "content-absent" });

  assert.deepEqual(await listIds("missing-seo"), [noContentRow]);
  assert.deepEqual(await listIds("missing-editorial"), [noContentRow]);
});

test("the blank-content predicate matches String.trim() for legacy whitespace rows", async () => {
  // `String.prototype.trim()` strips WhiteSpace + LineTerminator, so the SQL mirror has to strip
  // the same set: NBSP, LS, the ideographic space and ZWNBSP are blanks here, not content.
  const fixtures = [
    "",
    " ",
    "\t\n",
    "\u00a0",
    "\u2028",
    "\u3000",
    "\ufeff",
    " nội dung ",
    "\u00a0x",
  ];

  const seeded = await Promise.all(
    fixtures.map(async (value, index) => ({
      value,
      id: await seedProduct({
        key: `blank-${index}`,
        content: {
          seoTitle: value,
          seoDescription: "Mô tả tìm kiếm.",
          editorialDescription: value,
        },
      }),
    })),
  );

  const missingSeo = new Set(await listIds("missing-seo"));
  const missingEditorial = new Set(await listIds("missing-editorial"));

  for (const { value, id } of seeded) {
    assert.equal(
      missingSeo.has(id),
      !hasText(value),
      `the database seoTitle reading drifted from String.trim() for ${JSON.stringify(value)}`,
    );
    assert.equal(
      missingEditorial.has(id),
      !hasText(value),
      `the database editorial reading drifted from String.trim() for ${JSON.stringify(value)}`,
    );
  }
});

test("the content health filters compose with the directory's other dimensions", async () => {
  const publishedMissingSeo = await seedProduct({
    key: "compose-seo-published",
    content: { status: "PUBLISHED", editorialDescription: "Có biên tập." },
  });
  await seedProduct({
    key: "compose-seo-draft",
    content: { status: "DRAFT" },
  });
  await seedProduct({
    key: "compose-seo-published-complete",
    content: { status: "PUBLISHED", seoTitle: "T", seoDescription: "D" },
  });

  const saleMissingEditorial = await seedProduct({
    key: "compose-editorial-sale",
    content: { collectionSlugs: ["health-sale"], seoTitle: "T", seoDescription: "D" },
  });
  await seedProduct({
    key: "compose-editorial-sale-complete",
    content: { collectionSlugs: ["health-sale"], editorialDescription: "Có biên tập." },
  });
  const inactiveMissingEditorial = await seedProduct({
    key: "compose-editorial-inactive",
    isActive: false,
    content: { careInstructions: "Giặt tay." },
  });

  const composed = async (searchParams: Record<string, string>) => {
    const query = parseAdminProductDirectorySearchParams({ q: token, ...searchParams });
    const page = await repository.listDirectoryPage({ query });
    return { ids: page.products.map(({ id }) => id).sort(), totalCount: page.totalCount };
  };

  assert.deepEqual(await composed({ health: "missing-seo", status: "PUBLISHED" }), {
    ids: [publishedMissingSeo],
    totalCount: 1,
  });
  assert.deepEqual(await composed({ health: "missing-seo", q: `${token} compose-seo-published` }), {
    ids: [publishedMissingSeo],
    totalCount: 1,
  });
  assert.deepEqual(await composed({ health: "missing-editorial", collection: "health-sale" }), {
    ids: [saleMissingEditorial],
    totalCount: 1,
  });
  assert.deepEqual(await composed({ health: "missing-editorial", activity: "inactive" }), {
    ids: [inactiveMissingEditorial],
    totalCount: 1,
  });
});

test("every health chip's count equals the total of the page its own link opens", async () => {
  await seedProduct({
    key: "parity-complete",
    content: {
      seoTitle: "T",
      seoDescription: "D",
      editorialDescription: "E",
      collectionSlugs: ["health-parity"],
    },
    variants: [{ key: "v1", isActive: true, imageUrls: [trustedUrl(1)] }],
  });
  await seedProduct({ key: "parity-bare" });
  await seedProduct({
    key: "parity-partial",
    isActive: false,
    content: { seoTitle: "T", editorialDescription: "   " },
    variants: [{ key: "v1", isActive: false, stocks: [3] }],
  });

  for (const active of [
    healthQuery(undefined),
    healthQuery("missing-seo"),
    parseAdminProductDirectorySearchParams({ q: token, status: "DRAFT" }),
  ]) {
    const targets = buildAdminProductHealthTargets(active);
    const counts = await repository.countDirectoryFacets(targets);

    for (const key of ADMIN_PRODUCT_HEALTH_KEYS) {
      const { totalCount } = await repository.listDirectoryPage({ query: targets[key] });
      assert.equal(
        counts[key],
        totalCount,
        `health chip "${key}" advertises ${counts[key]} but its own link totals ${totalCount}`,
      );
    }
  }
});

test("a content health page slices the full catalog rather than the current page", async () => {
  for (let index = 0; index < 5; index += 1) {
    await seedProduct({ key: `seo-paged-${index}` });
  }
  await seedProduct({
    key: "seo-paged-complete",
    content: { seoTitle: "T", seoDescription: "D" },
  });

  const firstPage = await repository.listDirectoryPage({
    query: healthQuery("missing-seo"),
    pageSize: 2,
  });
  assert.equal(firstPage.totalCount, 5, "the total counts the catalog, not the page");
  assert.equal(firstPage.totalPages, 3);
  assert.equal(firstPage.products.length, 2);

  const lastPage = await repository.listDirectoryPage({
    query: { ...healthQuery("missing-seo"), page: 3 },
    pageSize: 2,
  });
  assert.equal(lastPage.page, 3);
  assert.equal(lastPage.products.length, 1);
});
