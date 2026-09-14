import type { StorefrontProductMedia } from "@/commerce/product-media";
import type { StorefrontPricingRule, StorefrontVariantFacts } from "@/commerce/storefront-product";
import { ProductCard, type ProductCardTone } from "@/components/brand/product-card";
import {
  buildProductCardModel,
  type StorefrontFlashSalePresentation,
} from "@/components/headless/build-product-card-model";
import type { TrackingEvent } from "@/tracking/commerce-events";

/**
 * The card's public surface, kept so today's listing pages render unchanged.
 *
 * Pricing now lives in `buildProductCardModel` and markup in `@/components/brand/product-card`.
 * This is the seam between them and holds no logic of its own. Once the storefront pages are
 * migrated they will build the model themselves and render the brand card directly, at which point
 * this file goes away; migrating them is Phase D/E route work, not this task's.
 */

export type { StorefrontFlashSalePresentation };

type StorefrontProductCardProps = {
  slug: string;
  name: string;
  variants: StorefrontVariantFacts[];
  tone: ProductCardTone;
  media?: StorefrontProductMedia | null;
  /**
   * Supplied by the listing that produced this card, so its price matches the projection that
   * filtered and ordered it. Absent on surfaces that have not switched, which keeps the default.
   */
  pricingRule?: StorefrontPricingRule;
  /** Exact Flash representative selected server-side from purchasable active Flash variants. */
  flashSale?: StorefrontFlashSalePresentation;
  /**
   * The prebuilt product-level `select_item` for this card, or absent where the deployment
   * publishes no commerce events. Built on the server so a click handler never has to read an
   * identity or a price back out of the rendered card.
   */
  selectEvent?: TrackingEvent | null;
  /** Product-level variant-to-gallery mapping, where the caller has one. */
  galleryIndexByVariantId?: Readonly<Record<string, number>>;
};

export function StorefrontProductCard({ tone, ...input }: StorefrontProductCardProps) {
  return <ProductCard model={buildProductCardModel(input)} tone={tone} />;
}
