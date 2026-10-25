import { notFound } from "next/navigation";
import { connection } from "next/server";

import { isApprovedSizeGuideId } from "@/brand";
import { readProductFeedback } from "@/commerce/feedback-repository";
import { readGuestShippingPolicy } from "@/commerce/guest-shipping-policy";
import type { ProductPromotionOffer } from "@/commerce/product-promotion-offers";
import { readProductPromotionOffers } from "@/commerce/product-promotion-offers-runtime";
import type { VoucherTeaserItem } from "@/commerce/voucher-teaser";
import { readProductVoucherTeaser } from "@/commerce/voucher-teaser-runtime";
import { createSizeGuideMediaRepository } from "@/commerce/size-guide-media";
import {
  getConfiguredStorefrontProductBySlug,
  listConfiguredRelatedStorefrontProducts,
  resolveStorefrontPromotionForProducts,
} from "@/commerce/storefront-catalog-runtime";
import { withListingFlashSale } from "@/commerce/storefront-listing-flash-sale";
import { selectStorefrontProductLevelOptions } from "@/commerce/storefront-projection";
import { getStorefrontResolvedPriceRange } from "@/commerce/storefront-product";
import { resolveProductTryOn } from "@/commerce/try-on-runtime";
import { HOMEPAGE_CONFIG } from "@/content/homepage.config";
import { prisma } from "@/db/prisma";
import {
  resolveDeepLinkedVariantSelection,
  VARIANT_QUERY_PARAM,
} from "@/commerce/storefront-variant-deep-link";
import { isCommerceTrackingEnabled } from "@/components/analytics/commerce-event-reporter";
import { buildProductListTracking } from "@/components/analytics/product-list-tracking";
import { buildProductPageViewEvent } from "@/components/analytics/product-page-tracking";
import { readSearchExposure } from "@/seo/search-exposure";
import { buildStorefrontProductStructuredData } from "@/seo/storefront-product-structured-data";

import type { ProductUrgency } from "@/components/headless/product-urgency";

import { sealRoute, type RouteHandle } from "./core.tsx";
import {
  buildPurchaseAssuranceViewModel,
  buildReturnsViewModel,
  buildShippingViewModel,
  type PurchaseAssuranceItem,
  type ReturnsViewModel,
  type ShippingViewModel,
} from "./evergreen-model.ts";
import {
  buildProductFeedbackSection,
  buildProductUrgency,
  buildProductViewModel,
  type ProductFeedbackSection,
  type ProductViewModel,
} from "./product-model.ts";

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
    /**
     * Server-decided virtual try-on entry point (`docs/specs/storefront-virtual-try-on.md` §4):
     * `null` when the feature is off or the product is not eligible, in which case the PDP renders
     * exactly what it rendered before try-on existed.
     */
    tryOn: Awaited<ReturnType<typeof resolveProductTryOn>>;
    /** Canonical A5 policy projections; the PDP does not restate shipping/returns facts. */
    shipping: ShippingViewModel;
    returns: ReturnsViewModel;
    /** The buying facts repeated under the purchase buttons. */
    purchaseAssurance: readonly PurchaseAssuranceItem[];
    /** Customer photographs: this product's own, else the brand's; `null` renders nothing. */
    feedback: ProductFeedbackSection | null;
    /** Gift / quantity-tier campaigns covering this product, named under the price; often empty. */
    promotionOffers: readonly ProductPromotionOffer[];
    /** The Flash Sale countdown and "Còn x" facts; see `buildProductUrgency`. */
    urgency: ProductUrgency;
    /** Up to two public vouchers covering this product; empty while the voucher feature is OFF. */
    voucherTeaser: readonly VoucherTeaserItem[];
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
  const sizeGuideId = product.sizeGuide;
  const [relatedProducts, sizeGuideImageUrl, tryOn, feedback, promotionOffers, voucherTeaser] = await Promise.all([
    listConfiguredRelatedStorefrontProducts(product),
    isApprovedSizeGuideId(sizeGuideId)
      ? createSizeGuideMediaRepository(prisma).readImageUrl(sizeGuideId)
      : null,
    resolveProductTryOn(product),
    readProductFeedback({ productId: product.id }),
    readProductPromotionOffers({ productId: product.id, now: requestNow }),
    readProductVoucherTeaser({ productId: product.id, now: requestNow }),
  ]);
  const promotion = await resolveStorefrontPromotionForProducts({
    products: [product, ...relatedProducts],
    now: requestNow,
  });
  // Related cards carry the Flash presentation every other listing gives them.
  const relatedWithFlash = withListingFlashSale(
    relatedProducts,
    promotion.campaignsByVariantId,
    requestNow,
  );
  const urgency = buildProductUrgency({
    variants: product.variants,
    productCapacity: product.productCapacity,
    campaignsByVariantId: promotion.campaignsByVariantId,
    now: requestNow,
  });
  const relatedTracking = buildProductListTracking({
    products: relatedWithFlash,
    // The list id is the analytics series and stays put; the name is what the surface is called,
    // and the refinement spec renamed it because the generic related source cannot prove the items
    // complete an outfit.
    list: { listId: "related-products", listName: "Nàng có thể thích" },
    pricingRule: promotion.pricingRule,
  });

  const shippingPolicy = readGuestShippingPolicy();
  const options = product.projection.options;
  const metaEntryPrice = getStorefrontResolvedPriceRange(options)?.minimum ?? null;
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
        sizeGuideImageUrl,
        careInstructions: product.careInstructions,
        options,
        productLevelOptions: selectStorefrontProductLevelOptions(product.projection),
        colorDimensionLabel: product.projection.colorDimensionLabel,
        deepLinkedSelection,
        galleryIndexByVariantId: product.galleryIndexByVariantId,
        relatedProducts: relatedWithFlash,
        relatedPricingRule: promotion.pricingRule,
        relatedSelectEventBySlug: relatedTracking.selectEventBySlug,
      }),
      commerceTrackingEnabled: isCommerceTrackingEnabled(),
      tryOn,
      relatedListEvent: relatedTracking.listEvent,
      shipping: buildShippingViewModel({ policy: shippingPolicy }),
      returns: buildReturnsViewModel(),
      purchaseAssurance: buildPurchaseAssuranceViewModel({ policy: shippingPolicy }),
      feedback: buildProductFeedbackSection(feedback, HOMEPAGE_CONFIG.feedback),
      promotionOffers,
      urgency,
      voucherTeaser,
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
    pixelEvents: [{
      name: "ViewContent",
      capiPath: `/shop/${product.slug}`,
      parameters: {
        content_ids: [product.slug], content_name: product.name, content_type: "product",
        currency: "VND",
        ...(metaEntryPrice === null ? {} : { value: metaEntryPrice }),
      },
    }],
  });
}
