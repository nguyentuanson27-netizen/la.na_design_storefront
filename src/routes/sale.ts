import { localizeListing } from "@/commerce/product-translation-runtime";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import {
  listConfiguredSaleFacets,
  listConfiguredSalePage,
  readConfiguredNextSaleBoundary,
} from "@/commerce/storefront-catalog-runtime";
import { parseSaleDiscoverySearchParams } from "@/commerce/category-discovery-url";
import type { StorefrontDiscoverySearchParams } from "@/commerce/storefront-discovery";
import { resolveStorefrontPromotionRefresh } from "@/commerce/storefront-promotion-freshness";
import { sealRoute, type RouteHandle } from "./core.tsx";
import { buildFlashSaleViewModel, type FlashSaleViewModel } from "./flash-sale-model.ts";
import { saleListingByKind, type SaleListingKind } from "../brand/sale.config.ts";
import { describeSalePage, SALE_PAGE_SIZE } from "./sale-page.ts";

export { SALE_PAGE_SIZE };
export type SaleRouteProps = Readonly<{
  searchParams: Promise<StorefrontDiscoverySearchParams>;
}>;

/**
 * `/sale` and its sub-listings share this loader. Without `kind` it lists every active discount;
 * `/sale/uu-dai` passes `PROMOTION`, `/sale/flash-sale` `FLASH_SALE` and `/sale/xa-hang-le-size`
 * `CLEARANCE`, which narrows the
 * product read, the refresh boundary and the tracking list to that campaign kind.
 */
export async function loadSaleRoute(
  { searchParams }: SaleRouteProps,
  kind?: SaleListingKind,
): Promise<RouteHandle<FlashSaleViewModel>> {
  const listing = kind ? saleListingByKind(kind) : null;
  await connection();
  const now = new Date();
  let discovery: ReturnType<typeof parseSaleDiscoverySearchParams>;
  let page: Awaited<ReturnType<typeof listConfiguredSalePage>>;
  let facets: Awaited<ReturnType<typeof listConfiguredSaleFacets>>;
  let boundary: Awaited<ReturnType<typeof readConfiguredNextSaleBoundary>>;

  try {
    discovery = parseSaleDiscoverySearchParams(await searchParams);
    [page, facets, boundary] = await Promise.all([
      listConfiguredSalePage({ discovery, pageSize: SALE_PAGE_SIZE, kind, now }),
      listConfiguredSaleFacets({ discovery, kind, now }),
      readConfiguredNextSaleBoundary(now, kind),
    ]);
  } catch (error) {
    if (error instanceof RangeError) notFound();
    throw error;
  }

  page = await localizeListing(page);

  const { pricingRule, tracking } = await describeSalePage({ page, kind, now });
  const model = buildFlashSaleViewModel({
    basePath: listing?.href ?? "/sale",
    products: page.products,
    totalCount: page.totalCount,
    totalPages: page.totalPages,
    page: page.page,
    pageSize: SALE_PAGE_SIZE,
    selectEventBySlug: tracking.selectEventBySlug,
    pricingRule,
    filters: {
      active: {
        size: discovery.size,
        color: discovery.color,
        availability: null,
        minPriceVnd: discovery.minPriceVnd,
        maxPriceVnd: discovery.maxPriceVnd,
        sale: null,
        sort: discovery.sort,
      },
      availableSizes: facets.sizes,
    },
  });
  return sealRoute({
    data: model,
    refreshAfterMs: resolveStorefrontPromotionRefresh({ now, nextBoundaryAt: boundary }).refreshAfterMs,
    trackingEvent: tracking.listEvent,
    structuredData: [],
    pixelEvents: [],
  });
}
