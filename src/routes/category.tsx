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
import {
  ListingBreadcrumbs,
  ListingHeader,
  ListingShell,
  ListingSubnav,
} from "@/components/brand/listing-chrome";
import { PlpFilterPanel } from "@/components/brand/plp-filter-panel";
import { PlpInfiniteGrid } from "@/components/brand/plp-infinite-grid";
import { buildCategoryBreadcrumbStructuredData } from "@/seo/category-breadcrumb-structured-data";
import { readSearchExposure } from "@/seo/search-exposure";
import { resolveCategoryBreadcrumbs } from "./category-breadcrumbs.ts";
import { CATEGORY_DESTINATIONS, type CategoryDestination } from "./category-destinations.ts";
import {
  buildCategoryViewModel,
  type CategorySubnavItem,
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

  // The row under the heading: the parent's children with "Tất cả" first. A child page draws its
  // parent's row with itself marked current, so shoppers can move sideways between siblings without
  // climbing back up the breadcrumb, and the row keeps its place as they do.
  const parentNode = node.childKeys.length > 0
    ? node
    : node.parentKey
      ? categoryByKey(node.parentKey)
      : undefined;
  const subcategories: CategorySubnavItem[] = parentNode
    ? [
        {
          label: "Tất cả",
          fullLabel: `Tất cả ${parentNode.label.toLocaleLowerCase("vi")}`,
          href: parentNode.path,
          current: parentNode.key === node.key,
        },
        ...parentNode.childKeys.flatMap((childKey) => {
          const childNode = categoryByKey(childKey);
          return childNode
            ? [{
                label: shortenChildLabel(childNode.label, parentNode.label),
                fullLabel: childNode.label,
                href: childNode.path,
                current: childNode.key === node.key,
              }]
            : [];
        }),
      ]
    : [];

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

/**
 * "Áo dài cách tân" under an "Áo dài" heading reads as "Cách tân": the parent's name is already on
 * screen, and repeating it on every tab is what pushed the row onto a second line on a phone. A
 * label that does not start with its parent's ("Set váy" under "Set đồ") is kept whole.
 */
function shortenChildLabel(label: string, parentLabel: string): string {
  const prefix = `${parentLabel} `;
  if (!label.toLocaleLowerCase("vi").startsWith(prefix.toLocaleLowerCase("vi"))) return label;
  const rest = label.slice(prefix.length).trim();
  return rest ? rest.charAt(0).toLocaleUpperCase("vi") + rest.slice(1) : label;
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
    <ListingShell>
      <ListingBreadcrumbs items={breadcrumbs} />

      <ListingHeader eyebrow="Danh mục thiết kế" title={destination.label}>
        {subcategories.length > 0 ? (
          <ListingSubnav label="Danh mục con" items={subcategories} />
        ) : null}
      </ListingHeader>

      {/* Accessible PLP Filter Panel */}
      <div className="mt-5">
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
    </ListingShell>
  );
}
