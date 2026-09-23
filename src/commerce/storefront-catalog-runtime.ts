import { prisma } from "../db/prisma.ts";
import { readPancakeShopId } from "../integrations/pancake/config.ts";
import { createFlashSaleCatalogRepository } from "./flash-sale-catalog.ts";
import { createStorefrontCatalogRepository } from "./storefront-catalog.ts";
import type { StorefrontDiscoveryQuery } from "./storefront-discovery.ts";
import { createStorefrontProductDetailRepository } from "./storefront-product-detail.ts";
import {
  MAX_RELATED_PRODUCTS,
  listRelatedStorefrontProducts,
} from "./storefront-related-products.ts";
import { createMerchandisingRepository } from "./merchandising-repository.ts";
import { categoryListingKeys, type CategoryKey } from "./category-taxonomy.ts";
import { createStorefrontProductSlugResolver } from "./storefront-product-slug-resolution.ts";
import { readApplicablePromotionCampaignsBatched } from "./promotion-candidate-batching.ts";
import { resolveStorefrontPromotionRefreshFromCampaigns } from "./storefront-promotion-freshness.ts";
import { buildPromotionalStorefrontPricing } from "./storefront-promotion-projection.ts";
import { defaultStorefrontPricingRule, type StorefrontPricingRule } from "./storefront-product.ts";

type StorefrontPromotionProduct = Readonly<{
  variants: readonly Readonly<{ id: string }>[];
  projection?: Readonly<{ options: readonly Readonly<{ id: string }>[] }>;
}>;

export async function resolveStorefrontPromotionForProducts({
  products,
  now = new Date(),
}: {
  products: readonly StorefrontPromotionProduct[];
  now?: Date;
}): Promise<Readonly<{ pricingRule: StorefrontPricingRule; refreshAfterMs: number }>> {
  const variantIds = products.flatMap((product) =>
    (product.projection?.options ?? product.variants).map((variant) => variant.id),
  );
  if (variantIds.length === 0) {
    return Object.freeze({
      pricingRule: defaultStorefrontPricingRule,
      refreshAfterMs: resolveStorefrontPromotionRefreshFromCampaigns({ now, campaigns: [] }).refreshAfterMs,
    });
  }
  const { campaignsByVariantId } = await readApplicablePromotionCampaignsBatched({
    variantIds,
  });
  const campaigns = [...campaignsByVariantId.values()].flat();
  return Object.freeze({
    pricingRule: buildPromotionalStorefrontPricing({ campaignsByVariantId, now }),
    refreshAfterMs: resolveStorefrontPromotionRefreshFromCampaigns({ now, campaigns }).refreshAfterMs,
  });
}

export async function resolveStorefrontPricingRuleForProducts({
  products,
  now = new Date(),
}: {
  products: readonly StorefrontPromotionProduct[];
  now?: Date;
}): Promise<StorefrontPricingRule> {
  return (await resolveStorefrontPromotionForProducts({ products, now })).pricingRule;
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

/**
 * One page of `/new-arrivals`: newest first, with the pricing rule its cards need and the window
 * that pricing is valid for.
 *
 * Priced through the same promotion resolution as every other listing, so a campaign that starts
 * or ends mid-session refreshes this route too rather than leaving it showing a stale price.
 */
export async function listConfiguredNewestProductPage({
  page,
  pageSize,
  now,
}: {
  page: number;
  pageSize: number;
  now?: Date;
}) {
  const shopId = readPancakeShopId();
  const result = await createStorefrontCatalogRepository(prisma).listNewestProductPage({
    shopId,
    page,
    pageSize,
  });
  const { pricingRule, refreshAfterMs } = await resolveStorefrontPromotionForProducts({
    products: result.products,
    now,
  });
  return { ...result, pricingRule, refreshAfterMs };
}

export async function listConfiguredStorefrontDiscoveryPage({
  discovery,
  pageSize,
  now,
}: {
  discovery: StorefrontDiscoveryQuery;
  pageSize: number;
  now?: Date;
}) {
  const shopId = readPancakeShopId();
  return createStorefrontCatalogRepository(prisma).listDiscoveryPage({
    shopId,
    discovery,
    pageSize,
    now,
  });
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
  now,
}: {
  discovery: StorefrontDiscoveryQuery;
  pageSize: number;
  now?: Date;
}) {
  const shopId = readPancakeShopId();
  return createFlashSaleCatalogRepository(prisma).listSalePage({
    shopId,
    discovery,
    pageSize,
    now,
  });
}

export async function readConfiguredNextFlashSaleBoundary(now?: Date) {
  return createFlashSaleCatalogRepository(prisma).readNextFlashSaleBoundary({ now });
}

export async function readConfiguredNextSaleBoundary(now?: Date) {
  return createFlashSaleCatalogRepository(prisma).readNextSaleBoundary({ now });
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
  return createStorefrontCatalogRepository(prisma).listDiscoveryPage({
    shopId,
    discovery: {
      ...discovery,
      categoryKey,
      categoryListingKeys: listingKeys,
    },
    pageSize,
    now,
  });
}

export async function listConfiguredCategoryDiscoveryFacets({
  categoryKey,
}: {
  categoryKey: string;
}) {
  const shopId = readPancakeShopId();
  const listingKeys = categoryListingKeys(categoryKey as CategoryKey);
  return createStorefrontCatalogRepository(prisma).listDiscoveryFacets({
    shopId,
    categoryListingKeys: listingKeys,
  });
}

export async function listConfiguredStorefrontDiscoveryFacets() {
  const shopId = readPancakeShopId();
  return createStorefrontCatalogRepository(prisma).listDiscoveryFacets({ shopId });
}

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
  const products = await createStorefrontCatalogRepository(prisma).listNewestProducts({
    shopId,
    limit,
  });

  const { pricingRule, refreshAfterMs } = await resolveStorefrontPromotionForProducts({
    products,
    now,
  });
  return { products, pricingRule, refreshAfterMs };
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
  const products = await listConfiguredHomepageFeaturedProducts();
  const { pricingRule, refreshAfterMs } = await resolveStorefrontPromotionForProducts({
    products,
    now,
  });
  return { products, pricingRule, refreshAfterMs };
}

export async function resolveConfiguredStorefrontProductSlug(slug: string) {
  const shopId = readPancakeShopId();
  return createStorefrontProductSlugResolver(prisma)({ shopId, slug });
}

export type CategoryMegaMediaFacts = Readonly<{
  categoryKey: string;
  imageUrl: string;
  altText?: string | null;
}>;

export async function readConfiguredCategoryMegaMedia(): Promise<readonly CategoryMegaMediaFacts[]> {
  try {
    const merchandising = createMerchandisingRepository(prisma);
    const [aoDai, setDo] = await Promise.all([
      merchandising.readCategoryEditorialMedia("aoDai"),
      merchandising.readCategoryEditorialMedia("setDo"),
    ]);
    const items: CategoryMegaMediaFacts[] = [];
    if (aoDai?.megaMenuImageUrl) {
      items.push({
        categoryKey: "aoDai",
        imageUrl: aoDai.megaMenuImageUrl,
        altText: null,
      });
    }
    if (setDo?.megaMenuImageUrl) {
      items.push({
        categoryKey: "setDo",
        imageUrl: setDo.megaMenuImageUrl,
        altText: null,
      });
    }
    return Object.freeze(items);
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
  const merchandising = createMerchandisingRepository(prisma);
  const rows = await Promise.all(
    categoryKeys.map((categoryKey) => merchandising.readCategoryEditorialMedia(categoryKey)),
  );

  const media = new Map<string, string>();
  for (const row of rows) {
    if (row?.heroImageUrl) media.set(row.categoryKey, row.heroImageUrl);
  }
  return media;
}
