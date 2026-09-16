import type { Prisma, PrismaClient } from "../generated/prisma/client.ts";

const MAX_POSTGRES_INTEGER = 2_147_483_647;

/** The sitemaps.org per-document URL limit, and the whole budget this module apportions. */
const MAX_SITEMAP_URLS = 50_000;

/**
 * The canonical paths the sitemap always emits, independent of catalog size.
 *
 * They live beside the budget because together the two are the whole contract. Keeping them in one
 * module is what lets the W21 capacity audit derive its arithmetic instead of restating numbers
 * that would go stale the first time a static path is added.
 */
export const STATIC_CANONICAL_PATHS = [
  "/",
  "/shop",
  "/collections",
  "/lookbook",
  // U33a. The evergreen pages are permanent, self-canonical and indexable on the same terms as the
  // rest of this list, so they belong in the document rather than being reachable only by crawl.
  "/about",
  "/contact",
  "/returns",
  "/shipping",
  // U33c size guide page.
  "/size-guide",
  // A7b policy hub.
  "/policies",
] as const;

/**
 * What is left of the per-document limit once the static paths have taken their share — 49,990.
 *
 * Derived rather than written down: adding a static path must shrink the dynamic bound, and a
 * hand-maintained constant is exactly where that would silently fail to happen.
 */
export const MAX_DYNAMIC_SITEMAP_PATHS = MAX_SITEMAP_URLS - STATIC_CANONICAL_PATHS.length;

/** Counts of the dynamic canonical paths, grouped by the source that produces them. */
export type SitemapCanonicalPathCounts = Readonly<{
  productPaths: number;
  collectionPaths: number;
}>;

function parseShopId(shopId: number): number {
  if (!Number.isSafeInteger(shopId) || shopId <= 0 || shopId > MAX_POSTGRES_INTEGER) {
    throw new RangeError("Sitemap shop id must fit a positive PostgreSQL INTEGER");
  }
  return shopId;
}

/**
 * The eligibility predicates, defined once.
 *
 * The capacity audit counts with these and the sitemap lists with these, so a measurement cannot
 * report headroom against a different catalog than the one the sitemap would actually emit.
 */
function currentShopProductWhere(shopId: number): Prisma.ProductMirrorWhereInput {
  return { pancakeShopId: shopId, isPresent: true, isActive: true };
}

const PUBLISHED_COLLECTION_WHERE: Prisma.CollectionDefinitionWhereInput = { isPublished: true };

export function createSearchSitemapRepository(client: PrismaClient) {
  /** Aggregate counts only — this never materializes catalog rows. */
  async function countCanonicalPaths({
    shopId,
  }: {
    shopId: number;
  }): Promise<SitemapCanonicalPathCounts> {
    const safeShopId = parseShopId(shopId);

    const [productPaths, collectionPaths] = await Promise.all([
      client.productMirror.count({ where: currentShopProductWhere(safeShopId) }),
      client.collectionDefinition.count({ where: PUBLISHED_COLLECTION_WHERE }),
    ]);

    return { productPaths, collectionPaths };
  }

  return {
    countCanonicalPaths,

    async listCanonicalPaths({ shopId }: { shopId: number }): Promise<string[]> {
      const safeShopId = parseShopId(shopId);

      // The budget guard runs on the same counts the capacity audit reports, so the threshold the
      // audit measures against is the threshold that actually refuses to build the sitemap.
      const { productPaths, collectionPaths } = await countCanonicalPaths({ shopId: safeShopId });

      if (productPaths + collectionPaths > MAX_DYNAMIC_SITEMAP_PATHS) {
        throw new RangeError("Canonical sitemap exceeds the single-sitemap URL budget");
      }

      const [products, collections] = await Promise.all([
        client.productMirror.findMany({
          where: currentShopProductWhere(safeShopId),
          select: { slug: true },
          orderBy: { slug: "asc" },
        }),
        client.collectionDefinition.findMany({
          where: PUBLISHED_COLLECTION_WHERE,
          select: { slug: true },
          orderBy: { slug: "asc" },
        }),
      ]);

      return [
        ...collections.map((collection) => `/collections/${collection.slug}`),
        ...products.map((product) => `/shop/${product.slug}`),
      ];
    },
  };
}
