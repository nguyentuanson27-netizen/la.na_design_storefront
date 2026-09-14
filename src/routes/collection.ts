import { notFound } from "next/navigation";
import { connection } from "next/server";

import {
  buildCollectionDiscoveryHref,
  parseCollectionDiscoverySearchParams,
} from "@/commerce/collection-discovery-url";
import {
  listConfiguredStorefrontDiscoveryFacets,
  listConfiguredStorefrontDiscoveryPage,
} from "@/commerce/storefront-catalog-runtime";
import { buildProductListTracking } from "@/components/analytics/product-list-tracking";
import { buildCollectionBreadcrumbStructuredData } from "@/seo/collection-breadcrumb-structured-data";
import { readSearchExposure } from "@/seo/search-exposure";

import { buildCollectionViewModel, type CollectionViewModel } from "./collection-model.ts";
import { sealRoute, type RouteHandle } from "./core.tsx";
import { readPublishedCollection } from "./metadata/collection.ts";

/** The collection detail's loader: the definition, its page of products, and the breadcrumb graph. */

export const COLLECTION_PAGE_SIZE = 24;

const SORT_CHOICES = [
  { value: "name-asc", label: "Tên A–Z" },
  { value: "name-desc", label: "Tên Z–A" },
  { value: "price-asc", label: "Giá thấp → cao" },
  { value: "price-desc", label: "Giá cao → thấp" },
] as const;

export type CollectionRouteProps = Readonly<{
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>;

export async function loadCollectionRoute({
  params,
  searchParams,
}: CollectionRouteProps): Promise<RouteHandle<CollectionViewModel>> {
  await connection();
  const { slug } = await params;
  const collection = await readPublishedCollection(slug);

  // A published collection with no story is not a page: it would render a heading over nothing.
  if (!collection || !collection.description?.trim()) notFound();

  let discovery: ReturnType<typeof parseCollectionDiscoverySearchParams>;
  let catalogPage: Awaited<ReturnType<typeof listConfiguredStorefrontDiscoveryPage>>;
  let facets: Awaited<ReturnType<typeof listConfiguredStorefrontDiscoveryFacets>>;
  try {
    const query = await searchParams;
    discovery = parseCollectionDiscoverySearchParams(collection.slug, query);
    const requestNow = new Date();
    [catalogPage, facets] = await Promise.all([
      listConfiguredStorefrontDiscoveryPage({
        discovery,
        pageSize: COLLECTION_PAGE_SIZE,
        now: requestNow,
      }),
      listConfiguredStorefrontDiscoveryFacets(),
    ]);
  } catch (error) {
    if (error instanceof RangeError) notFound();
    throw error;
  }

  const { page, products, totalCount, totalPages, pricingRule, refreshAfterMs } = catalogPage;
  if (page > Math.max(totalPages, 1)) notFound();

  const listTracking = buildProductListTracking({
    products,
    list: { listId: `collection:${collection.slug}`, listName: collection.title },
    pricingRule,
  });

  return sealRoute({
    data: buildCollectionViewModel({
      slug: collection.slug,
      title: collection.title,
      description: collection.description,
      heroImageUrl: collection.heroImageUrl,
      galleryImageUrls: collection.galleryImageUrls,
      videoSrcUrl: collection.videoSrcUrl,
      videoPosterUrl: collection.videoPosterUrl,
      featuredProductSlugs: collection.featuredProductSlugs,
      products,
      sizes: facets.sizes,
      discovery: { size: discovery.size, sort: discovery.sort },
      sortChoices: SORT_CHOICES,
      totalCount,
      totalPages,
      page,
      hasPrevious: catalogPage.hasPrevious,
      hasNext: catalogPage.hasNext,
      pageSize: COLLECTION_PAGE_SIZE,
      pricingRule,
      selectEventBySlug: listTracking.selectEventBySlug,
      hrefFor: (state) =>
        buildCollectionDiscoveryHref(collection.slug, {
          size: state.size,
          sort: state.sort as typeof discovery.sort,
          page: state.page,
        }),
    }),
    refreshAfterMs,
    trackingEvent: listTracking.listEvent,
    structuredData: [
      buildCollectionBreadcrumbStructuredData({
        origin: readSearchExposure().origin,
        title: collection.title,
      }),
    ],
  });
}
