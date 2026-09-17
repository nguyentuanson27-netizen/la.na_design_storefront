import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import {
  parseCategoryDiscoverySearchParams,
  type StorefrontDiscoverySearchParams,
} from "@/commerce/category-discovery-url";
import { categoryByKey, categoryByPath } from "@/commerce/category-taxonomy";
import {
  listConfiguredCategoryDiscoveryFacets,
  listConfiguredCategoryDiscoveryPage,
} from "@/commerce/storefront-catalog-runtime";
import { buildProductListTracking } from "@/components/analytics/product-list-tracking";
import { PlpFilterPanel } from "@/components/brand/plp-filter-panel";
import { PlpInfiniteGrid } from "@/components/brand/plp-infinite-grid";
import { buildCategoryBreadcrumbStructuredData } from "@/seo/category-breadcrumb-structured-data";
import { readSearchExposure } from "@/seo/search-exposure";
import { resolveCategoryBreadcrumbs } from "./category-breadcrumbs.ts";
import { CATEGORY_DESTINATIONS, type CategoryDestination } from "./category-destinations.ts";
import {
  buildCategoryViewModel,
  type CategoryViewModel,
} from "./category-model.ts";
import { sealRoute, type RouteHandle } from "./core.tsx";

export { CATEGORY_DESTINATIONS };
export type { CategoryDestination, CategoryViewModel };

export const CATEGORY_PAGE_SIZE = 24;

export type CategoryRouteProps = Readonly<{
  searchParams: Promise<StorefrontDiscoverySearchParams>;
}>;

export async function loadCategoryRoute(
  destination: CategoryDestination,
  props: CategoryRouteProps,
): Promise<RouteHandle<CategoryViewModel>> {
  await connection();
  const exposure = readSearchExposure();
  const node = categoryByPath(destination.href);
  if (!node) notFound();

  const categoryKey = node.key;
  const breadcrumbs = resolveCategoryBreadcrumbs(categoryKey);

  const subcategories = (node.childKeys ?? [])
    .map((childKey) => {
      const childNode = categoryByKey(childKey);
      return childNode ? { label: childNode.label, href: childNode.path } : null;
    })
    .filter((item): item is { label: string; href: string } => item !== null);

  const requestNow = new Date();
  let discovery: ReturnType<typeof parseCategoryDiscoverySearchParams>;
  let catalogPage: Awaited<ReturnType<typeof listConfiguredCategoryDiscoveryPage>>;
  let facets: Awaited<ReturnType<typeof listConfiguredCategoryDiscoveryFacets>>;

  try {
    const rawSearchParams = await props.searchParams;
    discovery = parseCategoryDiscoverySearchParams(categoryKey, rawSearchParams);
    [catalogPage, facets] = await Promise.all([
      listConfiguredCategoryDiscoveryPage({
        categoryKey,
        discovery,
        pageSize: CATEGORY_PAGE_SIZE,
        now: requestNow,
      }),
      listConfiguredCategoryDiscoveryFacets({ categoryKey }),
    ]);
  } catch (error) {
    if (error instanceof RangeError) notFound();
    throw error;
  }

  const { page, products, totalCount, totalPages, pricingRule, refreshAfterMs } = catalogPage;
  if (page > Math.max(totalPages, 1)) notFound();

  const listTracking = buildProductListTracking({
    products,
    list: { listId: `category:${categoryKey}`, listName: destination.label },
    pricingRule,
  });

  const structuredData = [
    buildCategoryBreadcrumbStructuredData({
      origin: exposure.origin,
      items: breadcrumbs.map((b) => ({ name: b.label, href: b.href })),
    }),
  ];

  const data = buildCategoryViewModel({
    destination,
    categoryKey,
    breadcrumbs,
    subcategories,
    discovery,
    products,
    facets,
    totalCount,
    totalPages,
    page,
    hasPrevious: catalogPage.hasPrevious,
    hasNext: catalogPage.hasNext,
    pageSize: CATEGORY_PAGE_SIZE,
    pricingRule,
    selectEventBySlug: listTracking.selectEventBySlug,
  });

  return sealRoute({
    data,
    refreshAfterMs,
    trackingEvent: listTracking.listEvent,
    structuredData,
    pixelEvents: [],
  });
}

export function renderCategoryRoute(data: CategoryViewModel) {
  const {
    destination,
    categoryKey,
    breadcrumbs,
    subcategories,
    cards,
    totalCount,
    totalPages,
    page,
    hasNext,
    nextHref,
    nextCursor,
    facets,
    activeFilters,
  } = data;

  return (
    <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-12 md:py-20">
      {/* Breadcrumbs */}
      <nav aria-label="Breadcrumb" className="text-xs uppercase tracking-[0.14em] text-[#3B2219]/70">
        <ol className="flex flex-wrap items-center gap-2">
          {breadcrumbs.map((crumb, idx) => (
            <li key={idx} className="flex items-center gap-2">
              {idx > 0 ? <span aria-hidden="true">/</span> : null}
              {crumb.href ? (
                <Link className="hover:text-[#2A1810] transition-colors" href={crumb.href}>
                  {crumb.label}
                </Link>
              ) : (
                <span aria-current="page" className="text-[#2A1810] font-medium">
                  {crumb.label}
                </span>
              )}
            </li>
          ))}
        </ol>
      </nav>

      {/* Category Header */}
      <div className="mt-8 border-b border-[#3B2219]/15 pb-8">
        <p className="eyebrow text-[#70584B]">Danh mục thiết kế</p>
        <h1 className="mt-3 font-serif text-4xl sm:text-5xl md:text-6xl font-normal text-[#2A1810] tracking-tight">
          {destination.label}
        </h1>

        {subcategories.length > 0 ? (
          <div className="mt-6 flex flex-wrap items-center gap-3">
            {subcategories.map((sub) => (
              <Link
                key={sub.href}
                href={sub.href}
                className="inline-flex items-center rounded-full border border-[#3B2219]/20 px-4 py-1.5 text-xs font-medium uppercase tracking-wider text-[#3B2219] transition hover:border-[#2A1810] hover:bg-[#2A1810] hover:text-[#FAF7F2]"
              >
                {sub.label}
              </Link>
            ))}
          </div>
        ) : null}
      </div>

      {/* Accessible PLP Filter Panel */}
      <div className="mt-8">
        <PlpFilterPanel
          categoryPath={destination.href}
          totalCount={totalCount}
          availableSizes={facets.sizes}
          availableColors={facets.colors}
          activeFilters={activeFilters}
        />
      </div>

      {/* Infinite Product Grid */}
      <PlpInfiniteGrid
        initialProducts={cards}
        totalCount={totalCount}
        totalPages={totalPages}
        initialPage={page}
        categoryKey={categoryKey}
        categoryPath={destination.href}
        activeFilters={activeFilters}
        hasNext={hasNext}
        nextHref={nextHref}
        nextCursor={nextCursor}
      />
    </div>
  );
}
