"use server";

import { buildProductListTracking } from "../components/analytics/product-list-tracking.ts";
import type { ProductCardModel } from "../components/headless/build-product-card-model.ts";
import { buildFlashSaleViewModel } from "../routes/flash-sale-model.ts";
import { NEW_ARRIVALS_TITLE } from "../routes/metadata/new-arrivals.ts";
import type { TrackingEvent } from "../tracking/commerce-events.ts";
import { NEW_ARRIVALS_PAGE_SIZE } from "./new-arrivals-selection.ts";
import { localizeListing } from "./product-translation-runtime.ts";
import { listConfiguredManualNewArrivalsPage } from "./storefront-catalog-runtime.ts";
import { parseStorefrontListingPage } from "./storefront-discovery.ts";

/**
 * The next page of `/new-arrivals` for the infinite grid: the admin-selected order, priced and
 * reported exactly as the crawlable `?page=` URL does. The listing has no filter, so the only input
 * is the page, which goes through the route's own page parser.
 */

export type NewArrivalsNextPageActionResult = {
  products: ProductCardModel[];
  page: number;
  totalPages: number;
  totalCount: number;
  hasNext: boolean;
  nextCursor: null;
  nextHref: string | null;
  listEvent: TrackingEvent | null;
};

export async function loadNewArrivalsNextPageAction(input: {
  page: number;
}): Promise<NewArrivalsNextPageActionResult> {
  if (typeof input?.page !== "number") throw new RangeError("Invalid new-arrivals page request");
  const page = parseStorefrontListingPage({ page: String(input.page) });

  // Names in the shopper's language, applied after the read as on the first page.
  const catalogPage = await localizeListing(
    await listConfiguredManualNewArrivalsPage({
      page,
      pageSize: NEW_ARRIVALS_PAGE_SIZE,
      now: new Date(),
    }),
  );
  if (page > Math.max(catalogPage.totalPages, 1)) {
    throw new RangeError("New-arrivals page is out of range");
  }

  const tracking = buildProductListTracking({
    products: catalogPage.products,
    list: { listId: "new-arrivals", listName: NEW_ARRIVALS_TITLE },
    pricingRule: catalogPage.pricingRule,
    startIndex: (catalogPage.page - 1) * NEW_ARRIVALS_PAGE_SIZE,
  });

  // The same card builder the first page renders with.
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

  return {
    products: model.cards.map((card) => card.model),
    page: catalogPage.page,
    totalPages: catalogPage.totalPages,
    totalCount: catalogPage.totalProducts,
    hasNext: model.nextHref !== null,
    nextCursor: null,
    nextHref: model.nextHref,
    listEvent: tracking.listEvent,
  };
}
