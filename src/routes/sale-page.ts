import { saleListingByKind, type SaleListingKind } from "../brand/sale.config.ts";
import { saleListingCampaignKinds } from "../commerce/flash-sale-catalog.ts";
import {
  listConfiguredSalePage,
  resolveStorefrontPricingRuleForProducts,
} from "../commerce/storefront-catalog-runtime.ts";
import { buildProductListTracking } from "../components/analytics/product-list-tracking.ts";
import { SALE_TITLE } from "./metadata/sale.ts";

/**
 * What the first page of a sale listing and every page the infinite grid loads after it share:
 * how a page of sale products is priced and how it is reported. `@/routes/sale` (the first page)
 * and `storefront-sale-actions` (the next ones) both read it here, so a card appended by scrolling
 * shows -- and reports -- exactly the price it would have on its own crawlable page.
 */

export const SALE_PAGE_SIZE = 24;

export type SalePage = Awaited<ReturnType<typeof listConfiguredSalePage>>;

export async function describeSalePage({
  page,
  kind,
  now,
}: Readonly<{ page: SalePage; kind?: SaleListingKind; now: Date }>) {
  const listing = kind ? saleListingByKind(kind) : null;

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

  // The card prices from the variants the filters matched, so the list and select events price the
  // same variants: a `select_item` must describe the card at the price that was shown.
  const trackedProducts = page.products.map((product) => {
    const matched = "matchedVariantIds" in product ? new Set(product.matchedVariantIds) : null;
    const variants = matched ? product.variants.filter((variant) => matched.has(variant.id)) : [];
    return variants.length > 0 ? { ...product, variants } : product;
  });

  const tracking = buildProductListTracking({
    products: trackedProducts,
    list: listing
      ? { listId: listing.href.slice(1).replaceAll("/", "-"), listName: listing.label }
      : { listId: "sale", listName: SALE_TITLE },
    pricingRule,
    // A page opened by URL, or appended by scrolling, continues the list's numbering.
    startIndex: (page.page - 1) * SALE_PAGE_SIZE,
  });

  return { pricingRule, tracking };
}
