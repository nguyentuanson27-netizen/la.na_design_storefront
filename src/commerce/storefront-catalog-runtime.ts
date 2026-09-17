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

export async function resolveConfiguredStorefrontProductSlug(slug: string) {
  const shopId = readPancakeShopId();
  return createStorefrontProductSlugResolver(prisma)({ shopId, slug });
}
