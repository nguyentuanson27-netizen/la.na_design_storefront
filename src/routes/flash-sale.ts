import { notFound } from "next/navigation";
import { connection } from "next/server";

import {
  listConfiguredFlashSalePage,
  readConfiguredNextFlashSaleBoundary,
} from "@/commerce/storefront-catalog-runtime";
import {
  parseStorefrontDiscoverySearchParams,
  type StorefrontDiscoverySearchParams,
} from "@/commerce/storefront-discovery";
import { resolveStorefrontPromotionRefresh } from "@/commerce/storefront-promotion-freshness";
import { buildProductListTracking } from "@/components/analytics/product-list-tracking";

import { sealRoute, type RouteHandle } from "./core.tsx";
import { buildFlashSaleViewModel, type FlashSaleViewModel } from "./flash-sale-model.ts";
import { FLASH_TITLE } from "./metadata/flash-sale.ts";

/** The Flash Sale listing's loader. */

export const FLASH_SALE_PAGE_SIZE = 24;

export type FlashSaleRouteProps = Readonly<{
  searchParams: Promise<StorefrontDiscoverySearchParams>;
}>;

export async function loadFlashSaleRoute({
  searchParams,
}: FlashSaleRouteProps): Promise<RouteHandle<FlashSaleViewModel>> {
  await connection();
  // One server instant for membership, pricing, representative selection and refresh alike.
  const requestNow = new Date();

  let discovery: ReturnType<typeof parseStorefrontDiscoverySearchParams>;
  let flashPage: Awaited<ReturnType<typeof listConfiguredFlashSalePage>>;
  let nextBoundaryAt: Awaited<ReturnType<typeof readConfiguredNextFlashSaleBoundary>>;
  try {
    discovery = parseStorefrontDiscoverySearchParams(await searchParams);
    [flashPage, nextBoundaryAt] = await Promise.all([
      listConfiguredFlashSalePage({ discovery, pageSize: FLASH_SALE_PAGE_SIZE, now: requestNow }),
      readConfiguredNextFlashSaleBoundary(requestNow),
    ]);
  } catch (error) {
    if (error instanceof RangeError) notFound();
    throw error;
  }

  const { page, products, totalCount, totalPages } = flashPage;
  const listTracking = buildProductListTracking({
    products,
    list: { listId: "flash-sale", listName: FLASH_TITLE },
  });

  return sealRoute({
    data: buildFlashSaleViewModel({
      products,
      totalCount,
      totalPages,
      page,
      pageSize: FLASH_SALE_PAGE_SIZE,
      selectEventBySlug: listTracking.selectEventBySlug,
    }),
    // The window's own boundary, not a fixed interval: the page re-reads when the sale changes.
    refreshAfterMs: resolveStorefrontPromotionRefresh({ now: requestNow, nextBoundaryAt }).refreshAfterMs,
    trackingEvent: listTracking.listEvent,
    structuredData: [],
    pixelEvents: [],
  });
}
