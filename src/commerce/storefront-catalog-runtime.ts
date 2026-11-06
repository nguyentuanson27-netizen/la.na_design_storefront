import { prisma } from "../db/prisma.ts";
import { readPancakeShopId } from "../integrations/pancake/config.ts";
import { createFlashSaleCatalogRepository, type SaleIdPage } from "./flash-sale-catalog.ts";
import {
  createSaleListingCache,
  createStorefrontListingCache,
  type StorefrontListingCache,
} from "./sale-listing-cache.ts";
import { createStorefrontCatalogRepository } from "./storefront-catalog.ts";
import type { StorefrontDiscoveryQuery } from "./storefront-discovery.ts";
import { createStorefrontProductDetailRepository } from "./storefront-product-detail.ts";
import {
  MAX_RELATED_PRODUCTS,
  listRelatedStorefrontProducts,
} from "./storefront-related-products.ts";
import { createMerchandisingRepository } from "./merchandising-repository.ts";
import { createNewArrivalsRepository } from "./new-arrivals-repository.ts";
import {
  categoryListingKeys,
  TOP_LEVEL_CATEGORY_KEYS,
  type CategoryKey,
} from "./category-taxonomy.ts";
import {
  rebaseListingFlashSaleRemaining,
  withListingFlashSale,
} from "./storefront-listing-flash-sale.ts";
import { storefrontCacheKey } from "./storefront-cache-key.ts";
import { createPricingGenerationReader } from "./pricing-generation-flight.ts";
import {
  createPricingScopedListingReader,
  type PricingStamped,
} from "./pricing-scoped-listing.ts";
import {
  createStorefrontProductSlugResolver,
  type StorefrontProductSlugResolution,
} from "./storefront-product-slug-resolution.ts";
import { readApplicablePromotionCampaignsBatched } from "./promotion-candidate-batching.ts";
import {
  resolveStorefrontPromotionRefreshFromCampaigns,
} from "./storefront-promotion-freshness.ts";
import type { ApplicablePromotionCampaign, PromotionCampaignKind } from "./promotion-pricing.ts";
import {
  buildPromotionalStorefrontPricing,
  type StorefrontCampaignKindScope,
} from "./storefront-promotion-projection.ts";
import { defaultStorefrontPricingRule, type StorefrontPricingRule } from "./storefront-product.ts";

type StorefrontPromotionProduct = Readonly<{
  variants: readonly Readonly<{ id: string }>[];
  projection?: Readonly<{ options: readonly Readonly<{ id: string }>[] }>;
}>;

type DiscoveryPageResult = Awaited<
  ReturnType<ReturnType<typeof createStorefrontCatalogRepository>["listDiscoveryPage"]>
>;
type ScopedFacetsResult = Awaited<
  ReturnType<ReturnType<typeof createStorefrontCatalogRepository>["listScopedDiscoveryFacets"]>
>;
type StorefrontProductsResult = Awaited<
  ReturnType<ReturnType<typeof createStorefrontCatalogRepository>["listProductsByIds"]>
>;

type StorefrontProductWithFlashSale = ReturnType<
  typeof withListingFlashSale<StorefrontProductsResult[number]>
>;

type ManualNewArrivalsPageResult = Readonly<{
  totalProducts: number;
  ids: readonly string[];
  page: number;
  pageSize: number;
  totalPages: number;
  products: StorefrontProductWithFlashSale;
  pricingRule: StorefrontPricingRule;
  refreshAfterMs: number;
}>;

type HomepageFeaturedResult = Readonly<{
  products: StorefrontProductWithFlashSale;
  pricingRule: StorefrontPricingRule;
  refreshAfterMs: number;
}>;

type HomepageNewArrivalsResult = Readonly<{
  products: Awaited<ReturnType<ReturnType<typeof createStorefrontCatalogRepository>["listNewestProducts"]>>;
  pricingRule: StorefrontPricingRule;
  refreshAfterMs: number;
}>;

/** One per server process: `/sale` and its sub-listings share their heavy page read across requests. */
const saleIdPageCache = createSaleListingCache<SaleIdPage>();
const saleFacetsCache = createSaleListingCache<readonly string[]>();

const categoryDiscoveryPageCache = createStorefrontListingCache<PricingStamped<DiscoveryPageResult>>();
const categoryDiscoveryFacetsCache = createStorefrontListingCache<PricingStamped<ScopedFacetsResult>>();
const storefrontDiscoveryPageCache = createStorefrontListingCache<PricingStamped<DiscoveryPageResult>>();
const collectionDiscoveryFacetsCache = createStorefrontListingCache<PricingStamped<ScopedFacetsResult>>();
const manualNewArrivalsCache = createStorefrontListingCache<PricingStamped<ManualNewArrivalsPageResult>>();
const homepageFeaturedCache = createStorefrontListingCache<PricingStamped<HomepageFeaturedResult>>();
const homepageNewArrivalsCache = createStorefrontListingCache<PricingStamped<HomepageNewArrivalsResult>>();
const productSlugCache = createStorefrontListingCache<StorefrontProductSlugResolution>();
const relatedProductsCache = createStorefrontListingCache<StorefrontProductsResult>();
const categoryMegaMediaCache = createStorefrontListingCache<readonly CategoryMegaMediaFacts[]>();
const categoryHeroMediaCache = createStorefrontListingCache<ReadonlyMap<string, string>>();

/**
 * `STOREFRONT_RUNTIME_CACHE=off` serves every read from the database. The browser specs rewrite rows
 * directly and reload, which a cache that only the admin actions invalidate cannot see.
 */
function runtimeCacheEnabled(): boolean {
  return process.env.STOREFRONT_RUNTIME_CACHE?.trim().toLowerCase() !== "off";
}

async function cachedRead<T>(
  cache: StorefrontListingCache<T>,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  if (!runtimeCacheEnabled()) return load();
  return (await cache.read(key, load)).value;
}

const readPricingScopedListing = createPricingScopedListingReader({
  enabled: runtimeCacheEnabled,
  readGeneration: createPricingGenerationReader((at) =>
    createFlashSaleCatalogRepository(prisma).readPricingGeneration(at),
  ),
});

export async function resolveStorefrontPromotionForProducts({
  products,
  now = new Date(),
  onlyKind,
}: {
  products: readonly StorefrontPromotionProduct[];
  now?: Date;
  /** Scopes the displayed discounts to one campaign kind; see `buildPromotionalStorefrontPricing`. */
  onlyKind?: StorefrontCampaignKindScope;
}): Promise<
  Readonly<{
    pricingRule: StorefrontPricingRule;
    refreshAfterMs: number;
    /** The campaigns the rule priced from, for a listing that also resolves Flash presentation. */
    campaignsByVariantId: ReadonlyMap<string, readonly ApplicablePromotionCampaign[]>;
  }>
> {
  const variantIds = products.flatMap((product) =>
    (product.projection?.options ?? product.variants).map((variant) => variant.id),
  );
  if (variantIds.length === 0) {
    return Object.freeze({
      pricingRule: defaultStorefrontPricingRule,
      refreshAfterMs: resolveStorefrontPromotionRefreshFromCampaigns({ now, campaigns: [] }).refreshAfterMs,
      campaignsByVariantId: new Map(),
    });
  }
  const { campaignsByVariantId } = await readApplicablePromotionCampaignsBatched({
    variantIds,
  });
  const campaigns = [...campaignsByVariantId.values()].flat();
  return Object.freeze({
    pricingRule: buildPromotionalStorefrontPricing({ campaignsByVariantId, now, onlyKind }),
    refreshAfterMs: resolveStorefrontPromotionRefreshFromCampaigns({ now, campaigns }).refreshAfterMs,
    campaignsByVariantId,
  });
}

export async function resolveStorefrontPricingRuleForProducts({
  products,
  now = new Date(),
  onlyKind,
}: {
  products: readonly StorefrontPromotionProduct[];
  now?: Date;
  onlyKind?: StorefrontCampaignKindScope;
}): Promise<StorefrontPricingRule> {
  return (await resolveStorefrontPromotionForProducts({ products, now, onlyKind })).pricingRule;
}

export async function listConfiguredStorefrontProducts(limit: number) {
  const shopId = readPancakeShopId();
  return createStorefrontCatalogRepository(prisma).listProducts({ shopId, limit });
}

export async function listConfiguredStorefrontProductPage({
  page,
  pageSize,
}: {
  page: number;
  pageSize: number;
}) {
  const shopId = readPancakeShopId();
  return createStorefrontCatalogRepository(prisma).listProductPage({ shopId, page, pageSize });
}

async function loadManualNewArrivalsPage({
  shopId,
  page,
  pageSize,
  now,
}: {
  shopId: number;
  page: number;
  pageSize: number;
  now?: Date;
}): Promise<ManualNewArrivalsPageResult> {
  const selected = await createNewArrivalsRepository(prisma).listVisiblePage({
    shopId,
    page,
    pageSize,
  });
  const products = await createStorefrontCatalogRepository(prisma).listProductsByIds({
    shopId,
    ids: selected.ids,
  });
  const at = now ?? new Date();
  const { pricingRule, refreshAfterMs, campaignsByVariantId } =
    await resolveStorefrontPromotionForProducts({ products, now: at });
  return Object.freeze({
    ...selected,
    products: withListingFlashSale(products, campaignsByVariantId, at),
    pricingRule,
    refreshAfterMs,
  });
}

/**
 * One page of `/new-arrivals`: admin-selected order, with the pricing rule its cards need and the window
 * that pricing is valid for.
 *
 * Priced through the same promotion resolution as every other listing, so a campaign that starts
 * or ends mid-session refreshes this route too rather than leaving it showing a stale price.
 */
export async function listConfiguredManualNewArrivalsPage({
  page,
  pageSize,
  now,
}: {
  page: number;
  pageSize: number;
  now?: Date;
}) {
  const shopId = readPancakeShopId();
  const cacheKey = storefrontCacheKey(["manual-new-arrivals", shopId, page, pageSize]);
  return readPricingScopedListing(manualNewArrivalsCache, cacheKey, now, (readAt) =>
    loadManualNewArrivalsPage({ shopId, page, pageSize, now: readAt }),
  );
}

/**
 * The given products, in the given order, as listing cards: read through the same visibility rules, priced
 * through the same promotion resolution and given the same Flash Sale presentation as every other listing.
 * For a surface that already knows which ids it wants (it paged them itself) and only needs them drawn.
 */
export async function listConfiguredStorefrontListingProductsByIds({
  ids,
  now,
}: {
  ids: readonly string[];
  now?: Date;
}) {
  const shopId = readPancakeShopId();
  const products = await createStorefrontCatalogRepository(prisma).listProductsByIds({ shopId, ids });
  const at = now ?? new Date();
  const { pricingRule, refreshAfterMs, campaignsByVariantId } =
    await resolveStorefrontPromotionForProducts({ products, now: at });
  return {
    products: withListingFlashSale(products, campaignsByVariantId, at),
    pricingRule,
    refreshAfterMs,
  };
}

export async function listConfiguredStorefrontDiscoveryPage({
  discovery,
  pageSize,
  allowCuratedComponents = false,
  inStockFirst,
  now,
}: {
  discovery: StorefrontDiscoveryQuery;
  pageSize: number;
  allowCuratedComponents?: boolean;
  inStockFirst?: boolean;
  now?: Date;
}) {
  const shopId = readPancakeShopId();
  const cacheKey = storefrontCacheKey([
    "disc-page",
    shopId,
    discovery.sort,
    discovery.page,
    pageSize,
    allowCuratedComponents ? "1" : "0",
    inStockFirst ? "1" : "0",
    discovery.size ?? "",
    discovery.color ?? "",
    discovery.availability ?? "",
    discovery.minPriceVnd ?? "",
    discovery.maxPriceVnd ?? "",
    discovery.sale ? "1" : "0",
    discovery.collection ?? "",
    discovery.query ?? "",
  ]);
  return readPricingScopedListing(storefrontDiscoveryPageCache, cacheKey, now, (readAt) =>
    createStorefrontCatalogRepository(prisma).listDiscoveryPage({
      shopId,
      discovery,
      pageSize,
      allowCuratedComponents,
      inStockFirst,
      now: readAt,
    }),
  );
}

export async function listConfiguredFlashSalePage({
  discovery,
  pageSize,
  now,
}: {
  discovery: StorefrontDiscoveryQuery;
  pageSize: number;
  now?: Date;
}) {
  const shopId = readPancakeShopId();
  return createFlashSaleCatalogRepository(prisma).listFlashSalePage({
    shopId,
    discovery,
    pageSize,
    now,
  });
}

export async function listConfiguredSalePage({
  discovery,
  pageSize,
  kind,
  now,
}: {
  discovery: StorefrontDiscoveryQuery;
  pageSize: number;
  kind?: PromotionCampaignKind;
  now?: Date;
}) {
  const shopId = readPancakeShopId();
  return createFlashSaleCatalogRepository(prisma, { saleIdPageCache }).listSalePage({
    shopId,
    discovery,
    pageSize,
    kind,
    now,
  });
}

export async function readConfiguredNextFlashSaleBoundary(now?: Date) {
  return createFlashSaleCatalogRepository(prisma).readNextFlashSaleBoundary({ now });
}

export async function readConfiguredNextSaleBoundary(
  now?: Date,
  kind?: PromotionCampaignKind,
) {
  return createFlashSaleCatalogRepository(prisma).readNextSaleBoundary({ now, kind });
}

/** The sizes still selectable on `/sale` or a sale sub-listing, given the other choices. */
export async function listConfiguredSaleFacets({
  discovery,
  kind,
  now,
}: {
  discovery: StorefrontDiscoveryQuery;
  kind?: PromotionCampaignKind;
  now?: Date;
}) {
  const shopId = readPancakeShopId();
  return createFlashSaleCatalogRepository(prisma, { saleIdPageCache, saleFacetsCache }).listSaleFacets({
    shopId,
    discovery,
    kind,
    now,
  });
}

export async function listConfiguredCategoryDiscoveryPage({
  categoryKey,
  discovery,
  pageSize,
  now,
}: {
  categoryKey: string;
  discovery: StorefrontDiscoveryQuery;
  pageSize: number;
  now?: Date;
}) {
  const shopId = readPancakeShopId();
  const listingKeys = categoryListingKeys(categoryKey as CategoryKey);
  const cacheKey = storefrontCacheKey([
    "cat-page",
    shopId,
    categoryKey,
    discovery.sort,
    discovery.page,
    pageSize,
    discovery.size ?? "",
    discovery.color ?? "",
    discovery.availability ?? "",
    discovery.minPriceVnd ?? "",
    discovery.maxPriceVnd ?? "",
    discovery.sale ? "1" : "0",
    discovery.query ?? "",
  ]);
  return readPricingScopedListing(categoryDiscoveryPageCache, cacheKey, now, (readAt) =>
    createStorefrontCatalogRepository(prisma).listDiscoveryPage({
      shopId,
      discovery: {
        ...discovery,
        categoryKey,
        categoryListingKeys: listingKeys,
      },
      pageSize,
      now: readAt,
    }),
  );
}

export async function listConfiguredCategoryDiscoveryFacets({
  categoryKey,
  discovery,
  now,
}: {
  categoryKey: string;
  discovery: StorefrontDiscoveryQuery;
  now?: Date;
}) {
  const shopId = readPancakeShopId();
  const listingKeys = categoryListingKeys(categoryKey as CategoryKey);
  const cacheKey = storefrontCacheKey([
    "cat-facets",
    shopId,
    categoryKey,
    discovery?.sort ?? "",
    discovery?.size ?? "",
    discovery?.color ?? "",
    discovery?.availability ?? "",
    discovery?.minPriceVnd ?? "",
    discovery?.maxPriceVnd ?? "",
    discovery?.sale ? "1" : "0",
    discovery?.query ?? "",
  ]);
  return readPricingScopedListing(categoryDiscoveryFacetsCache, cacheKey, now, (readAt) =>
    createStorefrontCatalogRepository(prisma).listScopedDiscoveryFacets({
      shopId,
      discovery: {
        ...discovery,
        categoryKey,
        categoryListingKeys: listingKeys,
      },
      now: readAt,
    }),
  );
}

/** The size chips and Sale toggle of `/collections/[slug]`, narrowed by its other filters. */
export async function listConfiguredCollectionDiscoveryFacets({
  discovery,
  now,
}: {
  discovery: StorefrontDiscoveryQuery;
  now?: Date;
}) {
  const shopId = readPancakeShopId();
  const cacheKey = storefrontCacheKey([
    "col-facets",
    shopId,
    discovery?.sort ?? "",
    discovery?.size ?? "",
    discovery?.color ?? "",
    discovery?.availability ?? "",
    discovery?.minPriceVnd ?? "",
    discovery?.maxPriceVnd ?? "",
    discovery?.collection ?? "",
    discovery?.query ?? "",
  ]);
  return readPricingScopedListing(collectionDiscoveryFacetsCache, cacheKey, now, (readAt) =>
    createStorefrontCatalogRepository(prisma).listScopedDiscoveryFacets({
      shopId,
      discovery,
      allowCuratedComponents: true,
      withSale: false,
      now: readAt,
    }),
  );
}

export async function listConfiguredStorefrontDiscoveryFacets({
  collectionSlug,
}: { collectionSlug?: string } = {}) {
  const shopId = readPancakeShopId();
  return createStorefrontCatalogRepository(prisma).listDiscoveryFacets({ shopId, collectionSlug });
}

/**
 * Not cached: the product page carries stock, video state and variant facts that the catalog sync and
 * the admin editor change without any revision a key could carry, and it is one slug's read.
 */
export async function getConfiguredStorefrontProductBySlug(slug: string, now?: Date) {
  const shopId = readPancakeShopId();
  return createStorefrontProductDetailRepository(prisma).getProductBySlug({ shopId, slug, now });
}

/**
 * How many candidates to pull per visited category.
 *
 * Each stage needs only enough rows to fill the slots the previous stages left, and the resolver
 * stops as soon as it is full. Reading a bounded slice keeps a category with thousands of products
 * from loading all of them to pick at most four.
 */
const RELATED_CANDIDATES_PER_CATEGORY = MAX_RELATED_PRODUCTS * 4;

/**
 * Related products for one PDP (ADR 0013 §7).
 *
 * Two passes on purpose. The resolver runs over thin `{ id, name }` rows, because the §7 order only
 * needs a name, an id and a per-category rank; the winners are then hydrated into full storefront
 * products. Projecting every candidate up front would build media, promotion and collection payloads
 * for rows that are about to be discarded.
 */
export async function listConfiguredRelatedStorefrontProducts(
  currentProduct: Readonly<{ id: string }>,
) {
  const shopId = readPancakeShopId();
  const cacheKey = storefrontCacheKey(["related-products", shopId, currentProduct.id]);
  return cachedRead(relatedProductsCache, cacheKey, async () => {
    const catalog = createStorefrontCatalogRepository(prisma);
    const merchandising = createMerchandisingRepository(prisma);

    const categoryKeys = await merchandising.readCategoryMembership(currentProduct.id);

    const ordered = await listRelatedStorefrontProducts({
      currentProduct: { id: currentProduct.id, categoryKeys },
      loadManualOverrides: () =>
        merchandising.listRelatedProductOverrides({ shopId, productId: currentProduct.id }),
      loadCategoryCandidates: (categoryKey) =>
        merchandising.listCategoryRelatedCandidates({
          shopId,
          categoryKey,
          limit: RELATED_CANDIDATES_PER_CATEGORY,
        }),
    });

    return catalog.listProductsByIds({ shopId, ids: ordered.map((product) => product.id) });
  });
}

/** One category's PLP, membership-selected and merchandiser-ordered (ADR 0013 §4.7, §5). */
export async function listConfiguredCategoryProducts(categoryKey: string, limit: number) {
  const shopId = readPancakeShopId();
  const merchandising = createMerchandisingRepository(prisma);
  const ordered = await merchandising.listCategoryProducts({ shopId, categoryKey, limit });

  return createStorefrontCatalogRepository(prisma).listProductsByIds({
    shopId,
    ids: ordered.map((product) => product.id),
  });
}

/** The homepage Featured section. Empty means empty — never a newest/bestseller fallback (§20). */
export async function listConfiguredHomepageFeaturedProducts() {
  const shopId = readPancakeShopId();
  const featured = await createMerchandisingRepository(prisma).listHomepageFeatured({ shopId });

  return createStorefrontCatalogRepository(prisma).listProductsByIds({
    shopId,
    ids: featured.map((product) => product.id),
  });
}

/**
 * The homepage `Hàng mới về` grid (master spec §18), priced like any other card grid.
 *
 * Featured (§20) and this are separate reads on purpose and must not be merged into one "homepage
 * products" call: Featured is a manual list whose emptiness is meaningful, and this one is a
 * recency read. Collapsing them is how an empty Featured section quietly starts showing new
 * arrivals, which §20 forbids in as many words.
 */
export async function listConfiguredHomepageNewArrivals(limit: number, now?: Date) {
  const shopId = readPancakeShopId();
  const cacheKey = storefrontCacheKey(["home-new-arrivals", shopId, limit]);
  return readPricingScopedListing(homepageNewArrivalsCache, cacheKey, now, async (readAt) => {
    const products = await createStorefrontCatalogRepository(prisma).listNewestProducts({
      shopId,
      limit,
    });

    const { pricingRule, refreshAfterMs } = await resolveStorefrontPromotionForProducts({
      products,
      now: readAt,
    });
    return { products, pricingRule, refreshAfterMs };
  });
}

/**
 * Featured products with the pricing rule their cards need, and the freshness window that pricing
 * is only valid for.
 *
 * This ordered `HomepageFeaturedProduct` list is the manual override authority for the homepage's
 * SPECIAL DEALS section (docs/specs/homepage-editorial-refresh.md §7.2).
 *
 * `refreshAfterMs` is returned rather than dropped because Featured is priced independently of the
 * `Hàng mới về` grid: a campaign boundary can fall inside Featured's products and nowhere near new
 * arrivals. A caller rendering both has to take the soonest of the two windows, and cannot do that
 * with a window it was never handed.
 */
export async function listConfiguredHomepageFeaturedWithPricing(now?: Date) {
  const shopId = readPancakeShopId();
  const cacheKey = storefrontCacheKey(["home-featured", shopId]);
  return readPricingScopedListing(homepageFeaturedCache, cacheKey, now, async (readAt) => {
    const products = await listConfiguredHomepageFeaturedProducts();
    const at = readAt;
    const { pricingRule, refreshAfterMs, campaignsByVariantId } =
      await resolveStorefrontPromotionForProducts({ products, now: at });
    return {
      products: withListingFlashSale(products, campaignsByVariantId, at),
      pricingRule,
      refreshAfterMs,
    };
  });
}

export async function resolveConfiguredStorefrontProductSlug(slug: string) {
  const shopId = readPancakeShopId();
  const cacheKey = storefrontCacheKey(["slug-resolve", shopId, slug]);
  return cachedRead(productSlugCache, cacheKey, () =>
    createStorefrontProductSlugResolver(prisma)({ shopId, slug }),
  );
}

export type CategoryMegaMediaFacts = Readonly<{
  categoryKey: string;
  imageUrl: string;
  altText?: string | null;
}>;

/** The mega-menu image of every top-level category that has one configured, in navigation order. */
export async function readConfiguredCategoryMegaMedia(): Promise<readonly CategoryMegaMediaFacts[]> {
  // A failed read is answered with no images but never cached: caching it would hide the menu
  // images for the whole fresh window after one transient database error.
  try {
    return await cachedRead(categoryMegaMediaCache, "mega-media", async () => {
      const merchandising = createMerchandisingRepository(prisma);
      const rows = await Promise.all(
        TOP_LEVEL_CATEGORY_KEYS.map((categoryKey) => merchandising.readCategoryEditorialMedia(categoryKey)),
      );
      const items: CategoryMegaMediaFacts[] = [];
      for (const row of rows) {
        if (row?.megaMenuImageUrl) {
          items.push({ categoryKey: row.categoryKey, imageUrl: row.megaMenuImageUrl, altText: null });
        }
      }
      return Object.freeze(items);
    });
  } catch {
    return Object.freeze([]);
  }
}

/**
 * Category editorial hero images, for the homepage's YOUR NEXT FAVOURITE section
 * (docs/specs/homepage-editorial-refresh.md §7.4).
 *
 * Returned as a map keyed by category rather than a list, because the section asks for four
 * specific categories and a missing entry is what makes it omit itself. The URLs are the raw
 * stored values: the route re-validates them through the trusted-media contract, the same as every
 * other image the storefront renders.
 */
export async function readConfiguredCategoryHeroMedia(
  categoryKeys: readonly CategoryKey[],
): Promise<ReadonlyMap<string, string>> {
  const cacheKey = storefrontCacheKey(["hero-media", categoryKeys.join(",")]);
  return cachedRead(categoryHeroMediaCache, cacheKey, async () => {
    const merchandising = createMerchandisingRepository(prisma);
    const rows = await Promise.all(
      categoryKeys.map((categoryKey) => merchandising.readCategoryEditorialMedia(categoryKey)),
    );

    const media = new Map<string, string>();
    for (const row of rows) {
      if (row?.heroImageUrl) media.set(row.categoryKey, row.heroImageUrl);
    }
    return media;
  });
}

/** Clear all in-process runtime storefront caches (e.g. after admin catalog updates or tests). */
export function clearStorefrontRuntimeCaches(): void {
  saleIdPageCache.clear();
  saleFacetsCache.clear?.();
  categoryDiscoveryPageCache.clear();
  categoryDiscoveryFacetsCache.clear();
  storefrontDiscoveryPageCache.clear();
  collectionDiscoveryFacetsCache.clear();
  manualNewArrivalsCache.clear();
  homepageFeaturedCache.clear();
  homepageNewArrivalsCache.clear();
  productSlugCache.clear();
  relatedProductsCache.clear();
  categoryMegaMediaCache.clear();
  categoryHeroMediaCache.clear();
}
