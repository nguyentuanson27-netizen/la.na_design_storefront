import { notFound } from "next/navigation";
import { connection } from "next/server";

import {
  listConfiguredStorefrontDiscoveryFacets,
  listConfiguredStorefrontDiscoveryPage,
} from "@/commerce/storefront-catalog-runtime";
import {
  parseStorefrontDiscoverySearchParams,
  type StorefrontDiscoverySearchParams,
} from "@/commerce/storefront-discovery";
import { buildProductListTracking } from "@/components/analytics/product-list-tracking";

import { sealRoute, type RouteHandle } from "./core.tsx";
import { SHOP_TITLE } from "./metadata/shop.ts";
import { buildShopViewModel, type ShopViewModel } from "./shop-model.ts";

/** The shop listing's loader: the query, the page, the facets and the grid's tracking. */

export const SHOP_PAGE_SIZE = 24;

export type ShopRouteProps = Readonly<{
  searchParams: Promise<StorefrontDiscoverySearchParams>;
}>;

export async function loadShopRoute({
  searchParams,
}: ShopRouteProps): Promise<RouteHandle<ShopViewModel>> {
  await connection();
  // One instant for the whole request: the count, the ordering, the SQL projection, transition
  // aggregation and the card prices all agree.
  const requestNow = new Date();

  let discovery: ReturnType<typeof parseStorefrontDiscoverySearchParams>;
  let catalogPage: Awaited<ReturnType<typeof listConfiguredStorefrontDiscoveryPage>>;
  let facets: Awaited<ReturnType<typeof listConfiguredStorefrontDiscoveryFacets>>;
  try {
    discovery = parseStorefrontDiscoverySearchParams(await searchParams);
    [catalogPage, facets] = await Promise.all([
      listConfiguredStorefrontDiscoveryPage({ discovery, pageSize: SHOP_PAGE_SIZE, now: requestNow }),
      listConfiguredStorefrontDiscoveryFacets(),
    ]);
  } catch (error) {
    // A query outside the accepted limits is a bad URL, not a server fault.
    if (error instanceof RangeError) notFound();
    throw error;
  }

  const { page, products, totalCount, totalPages, pricingRule, refreshAfterMs } = catalogPage;
  if (page > Math.max(totalPages, 1)) notFound();

  // One impression per rendered card, priced by the rule that ordered and rendered the grid.
  const listTracking = buildProductListTracking({
    products,
    list: { listId: "shop", listName: SHOP_TITLE },
    pricingRule,
  });

  return sealRoute({
    data: buildShopViewModel({
      discovery,
      products,
      facets,
      totalCount,
      totalPages,
      page,
      hasPrevious: catalogPage.hasPrevious,
      hasNext: catalogPage.hasNext,
      pageSize: SHOP_PAGE_SIZE,
      pricingRule,
      selectEventBySlug: listTracking.selectEventBySlug,
    }),
    refreshAfterMs,
    trackingEvent: listTracking.listEvent,
    // The listing publishes no JSON-LD of its own; the root layout carries the site graph.
    structuredData: [],
    pixelEvents: [],
  });
}
