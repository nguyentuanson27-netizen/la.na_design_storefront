import { buildPromotionalStorefrontPricing } from "./storefront-promotion-projection.ts";
import { readApplicablePromotionCampaignsBatched } from "./promotion-candidate-batching.ts";
import { resolveStorefrontPromotionRefresh } from "./storefront-promotion-freshness.ts";
import { Prisma, type PrismaClient } from "../generated/prisma/client.ts";
import { sortClothingSizes } from "./clothing-size.ts";
import { resolveVariantAvailabilityFromWarehouseStocks } from "./storefront-product.ts";
import {
  resolveStorefrontProductMedia,
  resolveVariantGalleryIndexes,
  type StorefrontProductMedia,
} from "./product-media.ts";
import type { StorefrontDiscoveryQuery } from "./storefront-discovery.ts";

const MAX_STOREFRONT_PRODUCTS = 48;
const MAX_STOREFRONT_OFFSET = 50_000;
const MAX_POSTGRES_INTEGER = 2_147_483_647;
const MAX_STOREFRONT_SLUG_LENGTH = 160;

function parseShopId(shopId: number): number {
  if (!Number.isSafeInteger(shopId) || shopId <= 0 || shopId > MAX_POSTGRES_INTEGER) {
    throw new RangeError("Storefront shop id must fit a positive PostgreSQL INTEGER");
  }
  return shopId;
}

function parseListLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_STOREFRONT_PRODUCTS) {
    throw new RangeError(
      `Storefront product list limit must be between 1 and ${MAX_STOREFRONT_PRODUCTS}`,
    );
  }
  return limit;
}

function parsePageOffset(page: number, pageSize: number): number {
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new RangeError("Storefront product page must be a positive integer");
  }

  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset) || offset > MAX_STOREFRONT_OFFSET) {
    throw new RangeError("Storefront product page is outside the supported catalog window");
  }
  return offset;
}

function parseSlug(slug: string): string {
  if (
    typeof slug !== "string" ||
    slug.length < 1 ||
    slug.length > MAX_STOREFRONT_SLUG_LENGTH ||
    slug !== slug.trim()
  ) {
    throw new RangeError("Storefront product slug is invalid");
  }
  return slug;
}

function sumWarehouseStocks(stocks: readonly { quantity: number }[]): number {
  let total = 0;
  for (const stock of stocks) {
    if (!Number.isFinite(stock.quantity)) {
      throw new Error("Storefront catalog contains malformed warehouse quantity");
    }
    total += stock.quantity;
    if (!Number.isFinite(total)) {
      throw new Error("Storefront catalog stock total is outside numeric bounds");
    }
  }
  return total;
}

const productSelection = {
  id: true,
  pancakeProductId: true,
  slug: true,
  name: true,
  primaryImageUrl: true,
  content: {
    select: {
      status: true,
      editorialDescription: true,
      material: true,
      craftDetails: true,
      careInstructions: true,
      sizeGuide: true,
      seoTitle: true,
      seoDescription: true,
      collectionSlugs: true,
    },
  },
  variants: {
    where: { isPresent: true, isActive: true },
    orderBy: [{ pancakeVariationId: "asc" }],
    select: {
      id: true,
      pancakeVariationId: true,
      color: true,
      size: true,
      pancakeRetailPrice: true,
      pancakeRetailPriceAfterDiscount: true,
      pancakeImageUrls: true,
      warehouseStocks: {
        orderBy: [{ pancakeWarehouseId: "asc" }],
        select: { quantity: true },
      },
    },
  },
} satisfies Prisma.ProductMirrorSelect;

export type StorefrontProductCollection = {
  slug: string;
  title: string;
};

type SelectedProduct = Prisma.ProductMirrorGetPayload<{ select: typeof productSelection }>;
type DiscoveryIdRow = { id: string; sortPrice: number | null };
type DiscoveryCountRow = { count: bigint };
type DiscoveryTransitionRow = { nextTransitionAt: Date | null };
type FacetRow = { value: string };

function parseJsonStringArray(value: Prisma.JsonValue): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

async function fetchPublishedCollectionMap(
  client: PrismaClient,
  slugs: readonly string[],
): Promise<Map<string, StorefrontProductCollection>> {
  const uniqueSlugs = [...new Set(slugs.filter(Boolean))];
  if (uniqueSlugs.length === 0) return new Map();

  const definitions = await client.collectionDefinition.findMany({
    where: {
      slug: { in: uniqueSlugs },
      isPublished: true,
    },
    select: {
      slug: true,
      title: true,
    },
  });

  return new Map(definitions.map((def) => [def.slug, { slug: def.slug, title: def.title }]));
}

export type SelectedStorefrontProductPayload = SelectedProduct;

export function toStorefrontProduct(
  product: SelectedProduct,
  collectionMap?: ReadonlyMap<string, StorefrontProductCollection>,
) {
  const media: StorefrontProductMedia = resolveStorefrontProductMedia({
    productName: product.name,
    primaryImageUrl: product.primaryImageUrl,
    variantImageUrls: product.variants.map((variant) =>
      parseJsonStringArray(variant.pancakeImageUrls),
    ),
  });
  const publishedContent = product.content?.status === "PUBLISHED" ? product.content : null;
  const rawCollectionSlugs = product.content
    ? parseJsonStringArray(product.content.collectionSlugs)
    : [];
  const collections = collectionMap
    ? rawCollectionSlugs
        .map((slug) => collectionMap.get(slug))
        .filter((col): col is StorefrontProductCollection => Boolean(col))
    : [];

  return {
    // Internal identity, used for joins and admin routes. Not vendor-facing.
    id: product.id,
    // Product-level external identity. One card is one product impression regardless of which
    // variant a shopper later selects, so this never varies with selection.
    pancakeProductId: product.pancakeProductId,
    slug: product.slug,
    name: product.name,
    media,
    editorialDescription: publishedContent?.editorialDescription ?? null,
    material: publishedContent?.material ?? null,
    // Blank entries are dropped rather than rendered as empty bullets.
    craftDetails: (publishedContent?.craftDetails ?? []).filter((detail) => detail.trim().length > 0),
    careInstructions: publishedContent?.careInstructions ?? null,
    sizeGuide: publishedContent?.sizeGuide ?? null,
    seoTitle: publishedContent?.seoTitle ?? null,
    seoDescription: publishedContent?.seoDescription ?? null,
    collections,
    variants: product.variants.map((variant) => ({
      id: variant.id,
      pancakeVariationId: variant.pancakeVariationId,
      color: variant.color,
      size: variant.size,
      retailPrice: variant.pancakeRetailPrice,
      retailPriceAfterDiscount: variant.pancakeRetailPriceAfterDiscount,
      sellableStock: sumWarehouseStocks(variant.warehouseStocks),
    })),
    // Server-only, and kept off the variant facts for the same reason `galleryIndexByVariantId` is:
    // the purchase panel has no use for it, and widening the client option contract would ship a
    // publication concern to the browser. Resolved here because this is the last place that still
    // holds the raw warehouse rows — one pass over rows already in memory, no extra query.
    variantAvailabilityResolvedById: Object.fromEntries(
      product.variants.map((variant) => [
        variant.id,
        resolveVariantAvailabilityFromWarehouseStocks(variant.warehouseStocks),
      ]),
    ),
    // Server-resolved, and kept off the variant facts on purpose: it is a product-level mapping
    // into this product's gallery, not a property of the variant, and it must not widen what the
    // client option contract carries.
    galleryIndexByVariantId: Object.fromEntries(
      resolveVariantGalleryIndexes({
        gallery: media.gallery,
        variants: product.variants.map((variant) => ({
          id: variant.id,
          imageUrls: parseJsonStringArray(variant.pancakeImageUrls),
        })),
      }),
    ),
  };
}

function visibleProductWhere(shopId: number) {
  return {
    pancakeShopId: parseShopId(shopId),
    isPresent: true,
    isActive: true,
  } satisfies Prisma.ProductMirrorWhereInput;
}

/**
 * The sanctioned SQL pricing projection.
 *
 * #151 permits exactly one SQL mirror of the pricing contract, and only because `/shop` must filter
 * and order by effective price *before* it paginates — a TypeScript pass over one page cannot do
 * that, and paging first would show the wrong products. It is a projection of the central rule, not
 * a second rule: every branch below has a named counterpart in `promotion-pricing.ts`, and the
 * parity suite pins them together on the same fixtures, including the mandated rounding cases.
 *
 * Money never touches floating point here. The mirrored column is `double precision`, so the base
 * is validated as a positive safe integer and then cast to `numeric` before any arithmetic; the
 * percentage is exact decimal division floored half-up, which is the same value the `BigInt`
 * expression produces because both operands are non-negative.
 *
 * `now` is the caller's request clock, so the count, the ordering, the page and transition
 * aggregation all decide window membership against one instant.
 */
export function buildVariantStockCte(now: Date) {
  return Prisma.sql`
  WITH "variant_base" AS (
    SELECT
      v."id",
      v."productId",
      v."color",
      v."size",
      CASE
        WHEN v."pancakeRetailPrice" IS NOT NULL
          AND v."pancakeRetailPrice" > 0
          AND v."pancakeRetailPrice" <> 'NaN'::float8
          AND v."pancakeRetailPrice" <> 'Infinity'::float8
          AND v."pancakeRetailPrice" <> '-Infinity'::float8
          AND v."pancakeRetailPrice" <= 9007199254740991::float8
          AND FLOOR(v."pancakeRetailPrice") = v."pancakeRetailPrice"
        THEN v."pancakeRetailPrice"::int8::numeric
        ELSE NULL
      END AS "basePrice",
      CASE
        WHEN COUNT(ws."id") = 0 THEN 0::float8
        WHEN BOOL_AND(
          ws."quantity" <> 'NaN'::float8
          AND ws."quantity" <> 'Infinity'::float8
          AND ws."quantity" <> '-Infinity'::float8
        ) THEN SUM(ws."quantity")
        ELSE NULL
      END AS "sellableStock"
    FROM "VariantMirror" v
    LEFT JOIN "WarehouseStock" ws ON ws."variantId" = v."id"
    WHERE v."isPresent" = TRUE AND v."isActive" = TRUE
    GROUP BY
      v."id",
      v."productId",
      v."color",
      v."size",
      v."pancakeRetailPrice"
  ),
  "variant_campaign" AS (
    SELECT
      vb."id" AS "variantId",
      c."id" AS "campaignId",
      c."discountType"::text AS "discountType",
      c."percentageValue" AS "percentageValue",
      c."fixedPriceVnd" AS "fixedPriceVnd"
    FROM "variant_base" vb
    JOIN "PromotionTarget" t
      ON t."variantId" = vb."id" OR t."productId" = vb."productId"
    JOIN "PromotionCampaign" c ON c."id" = t."campaignId"
    WHERE c."isEnabled" = TRUE
      AND (c."startsAt" IS NULL OR c."startsAt" <= ${now})
      AND (c."endsAt" IS NULL OR c."endsAt" > ${now})
    GROUP BY vb."id", c."id", c."discountType", c."percentageValue", c."fixedPriceVnd"
  ),
  "variant_candidate" AS (
    SELECT
      vb."id",
      vb."productId",
      vb."color",
      vb."size",
      vb."basePrice",
      vb."sellableStock",
      COUNT(vc."campaignId") AS "candidateCount",
      MIN(vc."discountType") AS "discountType",
      MIN(vc."percentageValue") AS "percentageValue",
      MIN(vc."fixedPriceVnd") AS "fixedPriceVnd"
    FROM "variant_base" vb
    LEFT JOIN "variant_campaign" vc ON vc."variantId" = vb."id"
    GROUP BY vb."id", vb."productId", vb."color", vb."size", vb."basePrice", vb."sellableStock"
  ),
  "variant_stock" AS (
    SELECT
      vc."id",
      vc."productId",
      vc."color",
      vc."size",
      vc."sellableStock",
      CASE
        WHEN vc."basePrice" IS NULL THEN NULL
        WHEN vc."candidateCount" <> 1 THEN vc."basePrice"
        WHEN vc."discountType" = 'PERCENTAGE'
          AND vc."percentageValue" BETWEEN 1 AND 99
          AND FLOOR((vc."basePrice" * (100 - vc."percentageValue") + 50) / 100) > 0
          AND FLOOR((vc."basePrice" * (100 - vc."percentageValue") + 50) / 100) < vc."basePrice"
        THEN FLOOR((vc."basePrice" * (100 - vc."percentageValue") + 50) / 100)
        WHEN vc."discountType" = 'FIXED_PRICE'
          AND vc."fixedPriceVnd" IS NOT NULL
          AND vc."fixedPriceVnd"::numeric > 0
          AND vc."fixedPriceVnd"::numeric < vc."basePrice"
        THEN vc."fixedPriceVnd"::numeric
        ELSE vc."basePrice"
      END::float8 AS "resolvedPrice"
    FROM "variant_candidate" vc
  )
`;
}

function buildVariantPredicate(discovery: StorefrontDiscoveryQuery) {
  const filters: Prisma.Sql[] = [];
  if (discovery.color) {
    filters.push(Prisma.sql`LOWER(BTRIM(vf."color")) = LOWER(${discovery.color})`);
  }
  if (discovery.size) {
    filters.push(Prisma.sql`LOWER(BTRIM(vf."size")) = LOWER(${discovery.size})`);
  }
  if (discovery.availability === "in-stock") {
    filters.push(Prisma.sql`vf."sellableStock" > 0`);
  }
  if (discovery.sale) {
    filters.push(Prisma.sql`vf."resolvedPrice" < vf."basePrice"`);
  }
  if (discovery.minPriceVnd !== null) {
    filters.push(Prisma.sql`vf."resolvedPrice" >= ${discovery.minPriceVnd}`);
  }
  if (discovery.maxPriceVnd !== null) {
    filters.push(Prisma.sql`vf."resolvedPrice" <= ${discovery.maxPriceVnd}`);
  }
  return filters;
}

function buildTransitionVariantPredicate(discovery: StorefrontDiscoveryQuery) {
  const filters: Prisma.Sql[] = [];
  if (discovery.color) {
    filters.push(Prisma.sql`LOWER(BTRIM(vb."color")) = LOWER(${discovery.color})`);
  }
  if (discovery.size) {
    filters.push(Prisma.sql`LOWER(BTRIM(vb."size")) = LOWER(${discovery.size})`);
  }
  if (discovery.availability === "in-stock") {
    filters.push(Prisma.sql`vb."sellableStock" > 0`);
  }
  // Price filters are intentionally absent. A promotion transition can make a product that is
  // currently outside the requested price band enter it; filtering transition candidates by the
  // current resolved price would miss exactly that off-page change.
  return filters;
}

function buildBaseProductFilters(shopId: number, discovery: StorefrontDiscoveryQuery) {
  const safeShopId = parseShopId(shopId);
  const filters: Prisma.Sql[] = [
    Prisma.sql`p."pancakeShopId" = ${safeShopId}`,
    Prisma.sql`p."isPresent" = TRUE`,
    Prisma.sql`p."isActive" = TRUE`,
  ];

  if (discovery.query) {
    filters.push(Prisma.sql`POSITION(LOWER(${discovery.query}) IN LOWER(p."name")) > 0`);
  }
  if (discovery.categoryListingKeys && discovery.categoryListingKeys.length > 0) {
    filters.push(Prisma.sql`
      EXISTS (
        SELECT 1
        FROM "ProductCategoryMembership" pcm
        WHERE pcm."productId" = p."id"
          AND pcm."categoryKey" IN (${Prisma.join([...discovery.categoryListingKeys])})
      )
    `);
  }
  if (discovery.collection) {
    filters.push(Prisma.sql`
      ${discovery.collection} = ANY(COALESCE(pc."collectionSlugs", ARRAY[]::TEXT[]))
      AND EXISTS (
        SELECT 1
        FROM "CollectionDefinition" cd
        WHERE cd."slug" = ${discovery.collection}
          AND cd."isPublished" = TRUE
      )
    `);
  }
  return filters;
}

function buildProductPredicate(shopId: number, discovery: StorefrontDiscoveryQuery) {
  const filters = buildBaseProductFilters(shopId, discovery);
  const variantFilters = buildVariantPredicate(discovery);
  if (variantFilters.length > 0) {
    filters.push(Prisma.sql`
      EXISTS (
        SELECT 1
        FROM "variant_stock" vf
        WHERE vf."productId" = p."id"
          AND ${Prisma.join(variantFilters, " AND ")}
      )
    `);
  }

  return {
    productPredicate: Prisma.join(filters, " AND "),
    variantFilters,
  };
}

function buildTransitionProductPredicate(shopId: number, discovery: StorefrontDiscoveryQuery) {
  const filters = buildBaseProductFilters(shopId, discovery);
  const variantFilters = buildTransitionVariantPredicate(discovery);
  if (variantFilters.length > 0) {
    filters.push(Prisma.sql`
      EXISTS (
        SELECT 1
        FROM "variant_base" vb
        WHERE vb."productId" = p."id"
          AND ${Prisma.join(variantFilters, " AND ")}
      )
    `);
  }
  return Prisma.join(filters, " AND ");
}

function buildSortPrice(variantFilters: readonly Prisma.Sql[]) {
  const extraFilters =
    variantFilters.length > 0
      ? Prisma.sql`AND ${Prisma.join([...variantFilters], " AND ")}`
      : Prisma.sql``;
  return Prisma.sql`
    (
      SELECT MIN(vf."resolvedPrice")
      FROM "variant_stock" vf
      WHERE vf."productId" = p."id" ${extraFilters}
    )
  `;
}

function buildDiscoveryOrder(
  sort: StorefrontDiscoveryQuery["sort"],
  categoryKey?: string | null,
) {
  switch (sort) {
    case "default":
      if (categoryKey) {
        return Prisma.sql`
          (
            SELECT cpo."position"
            FROM "CategoryProductOrder" cpo
            WHERE cpo."categoryKey" = ${categoryKey}
              AND cpo."productId" = p."id"
          ) ASC NULLS LAST,
          p."name" ASC,
          p."id" ASC
        `;
      }
      return Prisma.sql`p."name" ASC, p."id" ASC`;
    case "name-desc":
      return Prisma.sql`p."name" DESC, p."id" ASC`;
    case "price-asc":
      return Prisma.sql`"sortPrice" ASC NULLS LAST, p."name" ASC, p."id" ASC`;
    case "price-desc":
      return Prisma.sql`"sortPrice" DESC NULLS LAST, p."name" ASC, p."id" ASC`;
    case "name-asc":
      return Prisma.sql`p."name" ASC, p."id" ASC`;
  }
}

function bigintToSafeNumber(value: bigint): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Storefront discovery count is outside safe integer bounds");
  }
  return parsed;
}

export function createStorefrontCatalogRepository(client: PrismaClient) {
  async function listProducts({ shopId, limit }: { shopId: number; limit: number }) {
    const products = await client.productMirror.findMany({
      where: visibleProductWhere(shopId),
      take: parseListLimit(limit),
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: productSelection,
    });

    const allSlugs = products.flatMap((p) =>
      p.content ? parseJsonStringArray(p.content.collectionSlugs) : [],
    );
    const collectionMap = await fetchPublishedCollectionMap(client, allSlugs);

    return products.map((product) => toStorefrontProduct(product, collectionMap));
  }

  /**
   * The most recently mirrored products, for the homepage's `Hàng mới về` grid (master spec §18).
   *
   * Ordered by when a product first entered this mirror. That is a real timestamp rather than a
   * merchandiser's choice, and the limit of what it can honestly claim is worth stating: it answers
   * "recently added to the catalog", not "recently released by the brand", and a bulk re-sync that
   * rewrites every row would flatten the ordering until the catalog moves again.
   *
   * Deliberately not a `sort` value on the discovery query. Adding one there would publish a new
   * crawlable `?sort=` URL on every listing page and hand the PLP a second ordering authority,
   * which is F4a's contract and not this section's to change. When an approved new-arrivals
   * merchandising order exists, it replaces this read rather than sorting alongside it.
   */
  async function listNewestProducts({ shopId, limit }: { shopId: number; limit: number }) {
    const products = await client.productMirror.findMany({
      where: visibleProductWhere(shopId),
      take: parseListLimit(limit),
      // `id` breaks ties, so a re-sync that gives many rows the same instant still returns a
      // stable page rather than one that reshuffles between requests.
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      select: productSelection,
    });

    const allSlugs = products.flatMap((p) =>
      p.content ? parseJsonStringArray(p.content.collectionSlugs) : [],
    );
    const collectionMap = await fetchPublishedCollectionMap(client, allSlugs);

    return products.map((product) => toStorefrontProduct(product, collectionMap));
  }

  /**
   * Hydrate an explicit, already-ordered set of product ids into full storefront products.
   *
   * The caller's order is preserved rather than re-derived: related products (ADR 0013 §7) decide
   * their order in `storefront-related-products.ts`, where it is pinned by domain tests, so
   * re-sorting here would silently replace that contract with `name`/`id`. Ids that no longer
   * resolve to a visible product are dropped, which is the same availability filtering every other
   * storefront read applies.
   */
  async function listProductsByIds({ shopId, ids }: { shopId: number; ids: readonly string[] }) {
    if (ids.length === 0) return [];

    const products = await client.productMirror.findMany({
      where: { ...visibleProductWhere(shopId), id: { in: [...ids] } },
      take: parseListLimit(ids.length),
      select: productSelection,
    });

    const allSlugs = products.flatMap((p) =>
      p.content ? parseJsonStringArray(p.content.collectionSlugs) : [],
    );
    const collectionMap = await fetchPublishedCollectionMap(client, allSlugs);

    const byId = new Map(
      products.map((product) => [product.id, toStorefrontProduct(product, collectionMap)]),
    );
    return ids.flatMap((id) => {
      const product = byId.get(id);
      return product ? [product] : [];
    });
  }

  async function listProductPage({
    shopId,
    page,
    pageSize,
  }: {
    shopId: number;
    page: number;
    pageSize: number;
  }) {
    const safePageSize = parseListLimit(pageSize);
    const offset = parsePageOffset(page, safePageSize);
    const where = visibleProductWhere(shopId);
    const [totalProducts, products] = await Promise.all([
      client.productMirror.count({ where }),
      client.productMirror.findMany({
        where,
        skip: offset,
        take: safePageSize,
        orderBy: [{ name: "asc" }, { id: "asc" }],
        select: productSelection,
      }),
    ]);

    const allSlugs = products.flatMap((p) =>
      p.content ? parseJsonStringArray(p.content.collectionSlugs) : [],
    );
    const collectionMap = await fetchPublishedCollectionMap(client, allSlugs);

    return {
      products: products.map((product) => toStorefrontProduct(product, collectionMap)),
      page,
      pageSize: safePageSize,
      totalProducts,
      totalPages: Math.ceil(totalProducts / safePageSize),
    };
  }

  async function listDiscoveryPage({
    shopId,
    pageSize,
    discovery,
    now = new Date(),
  }: {
    shopId: number;
    pageSize: number;
    discovery: StorefrontDiscoveryQuery;
    /**
     * One request clock. Count, ordering, hydration and query-wide transition aggregation all use
     * this instant so a window cannot open halfway through one response.
     */
    now?: Date;
  }) {
    const safePageSize = parseListLimit(pageSize);
    const offset = parsePageOffset(discovery.page, safePageSize);
    const { productPredicate, variantFilters } = buildProductPredicate(shopId, discovery);
    const transitionProductPredicate = buildTransitionProductPredicate(shopId, discovery);
    const sortPrice = buildSortPrice(variantFilters);
    const orderBy = buildDiscoveryOrder(discovery.sort, discovery.categoryKey);
    const variantStockCte = buildVariantStockCte(now);

    const [countRows, idRows, transitionRows] = await Promise.all([
      client.$queryRaw<DiscoveryCountRow[]>(Prisma.sql`
        ${variantStockCte}
        SELECT COUNT(*)::bigint AS "count"
        FROM "ProductMirror" p
        LEFT JOIN "ProductContent" pc ON pc."productId" = p."id"
        WHERE ${productPredicate}
      `),
      client.$queryRaw<DiscoveryIdRow[]>(Prisma.sql`
        ${variantStockCte}
        SELECT p."id", ${sortPrice} AS "sortPrice"
        FROM "ProductMirror" p
        LEFT JOIN "ProductContent" pc ON pc."productId" = p."id"
        WHERE ${productPredicate}
        ORDER BY ${orderBy}
        LIMIT ${safePageSize}
        OFFSET ${offset}
      `),
      client.$queryRaw<DiscoveryTransitionRow[]>(Prisma.sql`
        ${variantStockCte}
        SELECT MIN(boundary) AS "nextTransitionAt"
        FROM (
          SELECT c."startsAt" AS boundary
          FROM "PromotionCampaign" c
          INNER JOIN "PromotionTarget" t ON t."campaignId" = c."id"
          INNER JOIN "variant_base" vb
            ON t."variantId" = vb."id" OR t."productId" = vb."productId"
          INNER JOIN "ProductMirror" p ON p."id" = vb."productId"
          LEFT JOIN "ProductContent" pc ON pc."productId" = p."id"
          WHERE c."isEnabled" = TRUE
            AND c."startsAt" > ${now}
            AND ${transitionProductPredicate}
          UNION ALL
          SELECT c."endsAt" AS boundary
          FROM "PromotionCampaign" c
          INNER JOIN "PromotionTarget" t ON t."campaignId" = c."id"
          INNER JOIN "variant_base" vb
            ON t."variantId" = vb."id" OR t."productId" = vb."productId"
          INNER JOIN "ProductMirror" p ON p."id" = vb."productId"
          LEFT JOIN "ProductContent" pc ON pc."productId" = p."id"
          WHERE c."isEnabled" = TRUE
            AND c."endsAt" > ${now}
            AND ${transitionProductPredicate}
        ) boundaries
      `),
    ]);

    const totalCount = countRows[0] ? bigintToSafeNumber(countRows[0].count) : 0;
    const ids = idRows.map(({ id }) => id);
    const products =
      ids.length === 0
        ? []
        : await client.productMirror.findMany({
            where: { ...visibleProductWhere(shopId), id: { in: ids } },
            select: productSelection,
          });
    const byId = new Map(products.map((product) => [product.id, product]));
    const allSlugs = products.flatMap((p) =>
      p.content ? parseJsonStringArray(p.content.collectionSlugs) : [],
    );
    const collectionMap = await fetchPublishedCollectionMap(client, allSlugs);

    const orderedProducts = ids.map((id) => {
      const product = byId.get(id);
      if (!product) throw new Error("Storefront discovery result changed during read");
      return toStorefrontProduct(product, collectionMap);
    });

    const pageVariantIds = orderedProducts.flatMap((product) =>
      product.variants.map((variant) => variant.id),
    );
    const { campaignsByVariantId } = await readApplicablePromotionCampaignsBatched({
      variantIds: pageVariantIds,
    });
    const { refreshAfterMs } = resolveStorefrontPromotionRefresh({
      now,
      nextBoundaryAt: transitionRows[0]?.nextTransitionAt ?? null,
    });

    return {
      products: orderedProducts,
      page: discovery.page,
      pageSize: safePageSize,
      totalCount,
      totalPages: Math.ceil(totalCount / safePageSize),
      hasPrevious: discovery.page > 1,
      hasNext: offset + orderedProducts.length < totalCount,
      /** Server-relative freshness only; the browser never receives a promotion deadline. */
      refreshAfterMs,
      /** Apply to a card's variants so its displayed price matches the projection that ranked it. */
      pricingRule: buildPromotionalStorefrontPricing({ campaignsByVariantId, now }),
    };
  }

  async function listDiscoveryFacets({
    shopId,
    categoryListingKeys,
  }: {
    shopId: number;
    categoryListingKeys?: readonly string[];
  }) {
    const safeShopId = parseShopId(shopId);
    const categoryClause =
      categoryListingKeys && categoryListingKeys.length > 0
        ? Prisma.sql`
          AND EXISTS (
            SELECT 1 FROM "ProductCategoryMembership" pcm
            WHERE pcm."productId" = p."id"
              AND pcm."categoryKey" IN (${Prisma.join([...categoryListingKeys])})
          )
        `
        : Prisma.sql``;

    const [colorRows, sizeRows, collectionRows] = await Promise.all([
      client.$queryRaw<FacetRow[]>(Prisma.sql`
        SELECT DISTINCT BTRIM(v."color") AS "value"
        FROM "VariantMirror" v
        INNER JOIN "ProductMirror" p ON p."id" = v."productId"
        WHERE p."pancakeShopId" = ${safeShopId}
          AND p."isPresent" = TRUE
          AND p."isActive" = TRUE
          AND v."isPresent" = TRUE
          AND v."isActive" = TRUE
          AND v."color" IS NOT NULL
          AND BTRIM(v."color") <> ''
          ${categoryClause}
        ORDER BY "value" ASC
      `),
      client.$queryRaw<FacetRow[]>(Prisma.sql`
        SELECT DISTINCT BTRIM(v."size") AS "value"
        FROM "VariantMirror" v
        INNER JOIN "ProductMirror" p ON p."id" = v."productId"
        WHERE p."pancakeShopId" = ${safeShopId}
          AND p."isPresent" = TRUE
          AND p."isActive" = TRUE
          AND v."isPresent" = TRUE
          AND v."isActive" = TRUE
          AND v."size" IS NOT NULL
          AND BTRIM(v."size") <> ''
          ${categoryClause}
        ORDER BY "value" ASC
      `),
      client.$queryRaw<FacetRow[]>(Prisma.sql`
        SELECT DISTINCT cd."slug" AS "value"
        FROM "ProductContent" pc
        INNER JOIN "ProductMirror" p ON p."id" = pc."productId"
        CROSS JOIN LATERAL UNNEST(pc."collectionSlugs") AS collection
        INNER JOIN "CollectionDefinition" cd ON cd."slug" = collection AND cd."isPublished" = TRUE
        WHERE p."pancakeShopId" = ${safeShopId}
          AND p."isPresent" = TRUE
          AND p."isActive" = TRUE
        ORDER BY "value" ASC
      `),
    ]);

    return {
      colors: colorRows.map(({ value }) => value),
      sizes: sortClothingSizes(sizeRows.map(({ value }) => value)),
      collections: collectionRows.map(({ value }) => value),
    };
  }

  async function getProductBySlug({ shopId, slug }: { shopId: number; slug: string }) {
    const product = await client.productMirror.findFirst({
      where: {
        ...visibleProductWhere(shopId),
        slug: parseSlug(slug),
      },
      select: productSelection,
    });

    if (!product) return null;

    const rawSlugs = product.content
      ? parseJsonStringArray(product.content.collectionSlugs)
      : [];
    const collectionMap = await fetchPublishedCollectionMap(client, rawSlugs);

    return toStorefrontProduct(product, collectionMap);
  }

  return {
    listProducts,
    listProductsByIds,
    listNewestProducts,
    listProductPage,
    listDiscoveryPage,
    listDiscoveryFacets,
    getProductBySlug,
  };
}
