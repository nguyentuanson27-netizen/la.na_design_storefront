import { notFound } from "next/navigation";
import { connection } from "next/server";

import {
  buildCollectionDiscoveryHref,
  isCollectionDefaultSort,
  parseCollectionDiscoverySearchParams,
} from "@/commerce/collection-discovery-url";
import {
  listConfiguredCollectionDiscoveryFacets,
  listConfiguredStorefrontDiscoveryPage,
} from "@/commerce/storefront-catalog-runtime";
import { buildProductListTracking } from "@/components/analytics/product-list-tracking";
import { buildCollectionBreadcrumbStructuredData } from "@/seo/collection-breadcrumb-structured-data";
import { readSearchExposure } from "@/seo/search-exposure";

import {
  buildCollectionViewModel,
  orderByFeaturedSlugs,
  type CollectionViewModel,
} from "./collection-model.ts";
import { COLLECTION_PAGE_SIZE, isCollectionRouteReachable } from "./collection-first-page.ts";
import { sealRoute, type RouteHandle } from "./core.tsx";
import { readPublishedCollection } from "./metadata/collection.ts";

/** The collection detail's loader: the definition, its page of products, and the breadcrumb graph. */

export { COLLECTION_PAGE_SIZE };

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
  if (!isCollectionRouteReachable(collection)) notFound();

  let discovery: ReturnType<typeof parseCollectionDiscoverySearchParams>;
  let catalogPage: Awaited<ReturnType<typeof listConfiguredStorefrontDiscoveryPage>>;
  let facets: Awaited<ReturnType<typeof listConfiguredCollectionDiscoveryFacets>>;
  try {
    const query = await searchParams;
    discovery = parseCollectionDiscoverySearchParams(collection.slug, query);
    const requestNow = new Date();
    [catalogPage, facets] = await Promise.all([
      listConfiguredStorefrontDiscoveryPage({
        discovery,
        pageSize: COLLECTION_PAGE_SIZE,
        allowCuratedComponents: true,
        now: requestNow,
      }),
      listConfiguredCollectionDiscoveryFacets({ discovery, now: requestNow }),
    ]);
  } catch (error) {
    if (error instanceof RangeError) notFound();
    throw error;
  }

  const { page, products, totalCount, totalPages, pricingRule, refreshAfterMs } = catalogPage;
  if (page > Math.max(totalPages, 1)) notFound();

  // Ordered once, here, before tracking is built. The impression and select indices must describe
  // the order the shopper sees, so the same array feeds the tracking and the view model. Pins lead
  // only in the merchandiser's own order: under a sort the shopper picked they would sit above a
  // list that claims to be ordered by price or name.
  const ordered = orderByFeaturedSlugs(
    products,
    isCollectionDefaultSort(collection.slug, discovery.sort) ? collection.featuredProductSlugs : [],
  );
  const listTracking = buildProductListTracking({
    products: ordered,
    list: { listId: `collection:${collection.slug}`, listName: collection.title },
    pricingRule,
  });

  return sealRoute({
    data: buildCollectionViewModel({
      slug: collection.slug,
      title: collection.title,
      description: collection.description,
      heroImageUrl: collection.heroImageUrl,
      heroImageMobileUrl: collection.heroImageMobileUrl,
      galleryImageUrls: collection.galleryImageUrls,
      videoSrcUrl: collection.videoSrcUrl,
      videoPosterUrl: collection.videoPosterUrl,
      products: ordered,
      sizes: facets.sizes,
      discovery: {
        size: discovery.size,
        sort: discovery.sort,
        availability: discovery.availability,
      },
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
          availability: state.availability,
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
    pixelEvents: [],
  });
}
