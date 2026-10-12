import { notFound } from "next/navigation";
import { connection } from "next/server";

import { listConfiguredManualNewArrivalsPage } from "@/commerce/storefront-catalog-runtime";
import {
  parseStorefrontListingPage,
  type StorefrontDiscoverySearchParams,
} from "@/commerce/storefront-discovery";
import { buildProductListTracking } from "@/components/analytics/product-list-tracking";
import { sealRoute, type RouteHandle } from "./core.tsx";
import {
  buildFlashSaleViewModel,
  type FlashSaleViewModel,
} from "./flash-sale-model.ts";
import { NEW_ARRIVALS_TITLE } from "./metadata/new-arrivals.ts";

/** /new-arrivals is the admin-selected list, never catalog recency. */

export const NEW_ARRIVALS_PAGE_SIZE = 24;

export type NewArrivalsRouteProps = Readonly<{
  searchParams: Promise<StorefrontDiscoverySearchParams>;
}>;

export type NewArrivalsViewModel = FlashSaleViewModel;

export async function loadNewArrivalsRoute({
  searchParams,
}: NewArrivalsRouteProps): Promise<RouteHandle<NewArrivalsViewModel>> {
  await connection();
  const now = new Date();

  let page: number;
  let catalogPage: Awaited<ReturnType<typeof listConfiguredManualNewArrivalsPage>>;
  try {
    page = parseStorefrontListingPage(await searchParams);
    catalogPage = await listConfiguredNewestProductPage({
      page,
      pageSize: NEW_ARRIVALS_PAGE_SIZE,
      now,
    });
  } catch (error) {
    if (error instanceof RangeError) notFound();
    throw error;
  }

  // A page past the end is not an empty listing, it is a URL that does not exist. Page 1 of an
  // empty catalog still is one, which is what the empty state is for.
  if (page > Math.max(catalogPage.totalPages, 1)) notFound();

  const tracking = buildProductListTracking({
    products: catalogPage.products,
    list: { listId: "new-arrivals", listName: NEW_ARRIVALS_TITLE },
    pricingRule: catalogPage.pricingRule,
  });

  const model = buildFlashSaleViewModel({
    basePath: "/new-arrivals",
    products: catalogPage.products,
    totalCount: catalogPage.totalProducts,
    totalPages: catalogPage.totalPages,
    page: catalogPage.page,
    pageSize: NEW_ARRIVALS_PAGE_SIZE,
    selectEventBySlug: tracking.selectEventBySlug,
    pricingRule: catalogPage.pricingRule,
  });

  return sealRoute({
    data: model,
    // Promotion-priced like any other listing, so it re-reads when a campaign boundary is nearer
    // than the shared default cadence.
    refreshAfterMs: catalogPage.refreshAfterMs,
    trackingEvent: tracking.listEvent,
    structuredData: [],
    pixelEvents: [],
  });
}
