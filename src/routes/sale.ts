import { notFound } from "next/navigation";
import { connection } from "next/server";
import { saleListingCampaignKinds } from "@/commerce/flash-sale-catalog";
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

  // A sub-listing prices its cards -- and reports them -- from its own campaign kind only, so a
  // product listed on Ưu đãi for its Promotion variant never shows a sibling variant's Flash price.
  // Xả hàng lẻ size widens that scope to Flash Sale on exactly the Flash variants its read admitted
  // for proven "lẻ size" stock; everything else there stays Clearance-only.
  const flashAdmittedVariantIds = new Set(
    page.products.flatMap((product) =>
      "admittedFlashVariantIds" in product ? product.admittedFlashVariantIds : [],
    ),
  );
  const pricingRule = await resolveStorefrontPricingRuleForProducts({
    products: page.products,
    now,
    onlyKind:
      kind === "CLEARANCE"
        ? (variantId) =>
            flashAdmittedVariantIds.has(variantId) ? saleListingCampaignKinds(kind) : [kind]
        : kind,
  });
  const tracking = buildProductListTracking({
    products: page.products,
    list: listing
      ? { listId: listing.href.slice(1).replaceAll("/", "-"), listName: listing.label }
      : { listId: "sale", listName: SALE_TITLE },
    pricingRule,
  });
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
