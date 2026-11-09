"use server";

import { SALE_CHILD_NAVIGATION, saleListingByKind, type SaleListingKind } from "../brand/sale.config.ts";
import { buildFlashSaleViewModel } from "../routes/flash-sale-model.ts";
import { describeSalePage, SALE_PAGE_SIZE } from "../routes/sale-page.ts";
import type { TrackingEvent } from "../tracking/commerce-events.ts";
import type { ProductCardModel } from "../components/headless/build-product-card-model.ts";
import {
  buildCategoryDiscoveryHref,
  parseSaleDiscoverySearchParams,
  type CategoryDiscoverySort,
} from "./category-discovery-url.ts";
import { listConfiguredSalePage } from "./storefront-catalog-runtime.ts";

/**
 * The next page of `/sale` or one of its sub-listings for the infinite grid.
 *
 * It takes the facts the URL carries and parses them with the route's own parser, so a page loaded
 * by scrolling lists, orders and prices exactly what that page's crawlable URL does. `kind` is
 * checked against the declared sale listings: this is a public POST endpoint, and an unknown value
 * must not reach the campaign read.
 */

export type SaleNextPageActionInput = {
  /** Which sale listing is being paged; absent or `null` is `/sale` itself (every active discount). */
  kind?: SaleListingKind | null;
  page: number;
  color?: string | null;
  size?: string | null;
  minPriceVnd?: number | null;
  maxPriceVnd?: number | null;
  sort?: CategoryDiscoverySort;
};

export type SaleNextPageActionResult = {
  products: ProductCardModel[];
  page: number;
  totalPages: number;
  totalCount: number;
  hasNext: boolean;
  /** The sale listings page by number only, so there is never a cursor to continue from. */
  nextCursor: null;
  nextHref: string | null;
  /** The `view_item_list` for exactly the products in this response; `null` when none is published. */
  listEvent: TrackingEvent | null;
};

function parseKind(kind: unknown): SaleListingKind | undefined {
  if (kind === undefined || kind === null) return undefined;
  const listing = SALE_CHILD_NAVIGATION.find((candidate) => candidate.campaignKind === kind);
  if (!listing) throw new RangeError("Invalid sale listing");
  return listing.campaignKind;
}

export async function loadSaleNextPageAction(
  input: SaleNextPageActionInput,
): Promise<SaleNextPageActionResult> {
  if (typeof input?.page !== "number") throw new RangeError("Invalid sale page request");
  const kind = parseKind(input.kind);
  const basePath = kind ? saleListingByKind(kind).href : "/sale";

  const discovery = parseSaleDiscoverySearchParams({
    color: input.color ?? undefined,
    size: input.size ?? undefined,
    minPrice: input.minPriceVnd !== null && input.minPriceVnd !== undefined ? String(input.minPriceVnd) : undefined,
    maxPrice: input.maxPriceVnd !== null && input.maxPriceVnd !== undefined ? String(input.maxPriceVnd) : undefined,
    sort: input.sort && input.sort !== "default" ? input.sort : undefined,
    page: String(input.page),
  });

  const now = new Date();
  const salePage = await listConfiguredSalePage({ discovery, pageSize: SALE_PAGE_SIZE, kind, now });
  const { pricingRule, tracking } = await describeSalePage({ page: salePage, kind, now });

  const model = buildFlashSaleViewModel({
    basePath,
    products: salePage.products,
    totalCount: salePage.totalCount,
    totalPages: salePage.totalPages,
    page: salePage.page,
    pageSize: SALE_PAGE_SIZE,
    selectEventBySlug: tracking.selectEventBySlug,
    pricingRule,
  });

  const hasNext = salePage.page < salePage.totalPages;
  return {
    products: model.cards.map((card) => card.model),
    page: salePage.page,
    totalPages: salePage.totalPages,
    totalCount: salePage.totalCount,
    hasNext,
    nextCursor: null,
    nextHref: hasNext ? buildCategoryDiscoveryHref(
          basePath,
          {
            color: discovery.color,
            size: discovery.size,
            minPriceVnd: discovery.minPriceVnd,
            maxPriceVnd: discovery.maxPriceVnd,
            sort: discovery.sort,
          },
          salePage.page + 1,
        ) : null,
    listEvent: tracking.listEvent,
  };
}
