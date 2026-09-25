import { notFound } from "next/navigation";
import { connection } from "next/server";
import {
  listConfiguredSalePage,
  readConfiguredNextSaleBoundary,
  resolveStorefrontPricingRuleForProducts,
} from "@/commerce/storefront-catalog-runtime";
import {
  parseStorefrontDiscoverySearchParams,
  type StorefrontDiscoverySearchParams,
} from "@/commerce/storefront-discovery";
import { resolveStorefrontPromotionRefresh } from "@/commerce/storefront-promotion-freshness";
import { buildProductListTracking } from "@/components/analytics/product-list-tracking";
import { sealRoute, type RouteHandle } from "./core.tsx";
import { buildFlashSaleViewModel, type FlashSaleViewModel } from "./flash-sale-model.ts";
import { saleListingByKind, type SaleListingKind } from "../brand/sale.config.ts";
import { SALE_TITLE } from "./metadata/sale.ts";

export const SALE_PAGE_SIZE = 24;
export type SaleRouteProps = Readonly<{
  searchParams: Promise<StorefrontDiscoverySearchParams>;
}>;

/**
 * `/sale` and its sub-listings share this loader. Without `kind` it lists every active discount;
 * `/sale/uu-dai` passes `PROMOTION` and `/sale/flash-sale` passes `FLASH_SALE`, which narrows the
 * product read, the refresh boundary and the tracking list to that campaign kind.
 */
export async function loadSaleRoute(
  { searchParams }: SaleRouteProps,
  kind?: SaleListingKind,
): Promise<RouteHandle<FlashSaleViewModel>> {
  const listing = kind ? saleListingByKind(kind) : null;
  await connection();
  const now = new Date();
  let discovery: ReturnType<typeof parseStorefrontDiscoverySearchParams>;
  let page: Awaited<ReturnType<typeof listConfiguredSalePage>>;
  let boundary: Awaited<ReturnType<typeof readConfiguredNextSaleBoundary>>;

  try {
    discovery = parseStorefrontDiscoverySearchParams(await searchParams);
    [page, boundary] = await Promise.all([
      listConfiguredSalePage({ discovery, pageSize: SALE_PAGE_SIZE, kind, now }),
      readConfiguredNextSaleBoundary(now, kind),
    ]);
  } catch (error) {
    if (error instanceof RangeError) notFound();
    throw error;
  }

  const [tracking, pricingRule] = await Promise.all([
    Promise.resolve(
      buildProductListTracking({
        products: page.products,
        list: listing
          ? { listId: listing.href.slice(1).replaceAll("/", "-"), listName: listing.label }
          : { listId: "sale", listName: SALE_TITLE },
      }),
    ),
    resolveStorefrontPricingRuleForProducts({ products: page.products, now }),
  ]);
  const model = buildFlashSaleViewModel({
    basePath: listing?.href ?? "/sale",
    products: page.products,
    totalCount: page.totalCount,
    totalPages: page.totalPages,
    page: page.page,
    pageSize: SALE_PAGE_SIZE,
    selectEventBySlug: tracking.selectEventBySlug,
    pricingRule,
  });
  return sealRoute({
    data: model,
    refreshAfterMs: resolveStorefrontPromotionRefresh({ now, nextBoundaryAt: boundary }).refreshAfterMs,
    trackingEvent: tracking.listEvent,
    structuredData: [],
    pixelEvents: [],
  });
}
