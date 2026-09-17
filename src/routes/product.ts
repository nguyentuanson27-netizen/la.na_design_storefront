import { notFound } from "next/navigation";
import { connection } from "next/server";

import {
  getConfiguredStorefrontProductBySlug,
  listConfiguredRelatedStorefrontProducts,
  resolveStorefrontPromotionForProducts,
} from "@/commerce/storefront-catalog-runtime";
import { selectStorefrontProductLevelOptions } from "@/commerce/storefront-projection";
import {
  resolveDeepLinkedVariantSelection,
  VARIANT_QUERY_PARAM,
} from "@/commerce/storefront-variant-deep-link";
import { isCommerceTrackingEnabled } from "@/components/analytics/commerce-event-reporter";
import { buildProductListTracking } from "@/components/analytics/product-list-tracking";
import { buildProductPageViewEvent } from "@/components/analytics/product-page-tracking";
import { readSearchExposure } from "@/seo/search-exposure";
import { buildStorefrontProductStructuredData } from "@/seo/storefront-product-structured-data";

import { sealRoute, type RouteHandle } from "./core.tsx";
import { buildProductViewModel, type ProductViewModel } from "./product-model.ts";

/** The product page's loader: the product, its related grid, the deep link, and the JSON-LD. */

export type ProductRouteProps = Readonly<{
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>;

export type ProductRouteData = ProductViewModel &
  Readonly<{
    /** Server-resolved: a deployment that publishes no dataLayer must not have one created here. */
    commerceTrackingEnabled: boolean;
    /** The related grid's own `view_item_list`; the shell carries the product view event. */
    relatedListEvent: ReturnType<typeof buildProductListTracking>["listEvent"];
  }>;

export async function loadProductRoute({
  params,
  searchParams,
}: ProductRouteProps): Promise<RouteHandle<ProductRouteData>> {
  await connection();
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const requestNow = new Date();

  let product: Awaited<ReturnType<typeof getConfiguredStorefrontProductBySlug>>;
  try {
    product = await getConfiguredStorefrontProductBySlug(slug, requestNow);
  } catch (error) {
    // A malformed slug is a bad URL, not a server fault.
    if (error instanceof RangeError) notFound();
    throw error;
  }
  if (!product) notFound();

  // Related selection is membership-driven (ADR 0013 §7), so it does not depend on the request
  // clock; the promotion pass below is what applies `requestNow` to the products it returns.
  const relatedProducts = await listConfiguredRelatedStorefrontProducts(product);
  const promotion = await resolveStorefrontPromotionForProducts({
    products: [product, ...relatedProducts],
    now: requestNow,
  });
  const relatedTracking = buildProductListTracking({
    products: relatedProducts,
    list: { listId: "related-products", listName: "Hoàn thiện phối đồ" },
    pricingRule: promotion.pricingRule,
  });

  const options = product.projection.options;
  const deepLinkedSelection = resolveDeepLinkedVariantSelection({
    projection: product.projection,
    variantQuery: typeof query[VARIANT_QUERY_PARAM] === "string" ? query[VARIANT_QUERY_PARAM] : null,
  });

  return sealRoute({
    data: {
      ...buildProductViewModel({
        slug: product.slug,
        name: product.name,
        media: product.media,
        collections: product.collections,
        editorialDescription: product.editorialDescription,
        material: product.material,
        craftDetails: product.craftDetails,
        sizeGuide: product.sizeGuide,
        careInstructions: product.careInstructions,
        options,
        productLevelOptions: selectStorefrontProductLevelOptions(product.projection),
        deepLinkedSelection,
        galleryIndexByVariantId: product.galleryIndexByVariantId,
        relatedProducts,
        relatedPricingRule: promotion.pricingRule,
        relatedSelectEventBySlug: relatedTracking.selectEventBySlug,
      }),
      commerceTrackingEnabled: isCommerceTrackingEnabled(),
      relatedListEvent: relatedTracking.listEvent,
    },
    refreshAfterMs: promotion.refreshAfterMs,
    trackingEvent: buildProductPageViewEvent({
      pancakeProductId: product.pancakeProductId,
      name: product.name,
      options,
      deepLinkedSelection,
    }),
    // One document, carrying its own `@graph`. The shell emits one script per entry, so this is
    // byte-identical to what the page emitted before it was migrated.
    structuredData: [
      buildStorefrontProductStructuredData({ origin: readSearchExposure().origin, product }),
    ],
    pixelEvents: [],
  });
}
