"use client";

import type { StorefrontProductMedia } from "@/commerce/product-media";
import { BrandProductGallery } from "@/components/brand/product-gallery";

/**
 * The gallery's public surface, kept so today's product page renders unchanged.
 *
 * Which image is on screen now comes from `@/components/headless/resolve-gallery-model` and the
 * markup from `@/components/brand/product-gallery`. This is the seam between them and holds no
 * logic of its own. The brand gallery also accepts a selected variant and the product's
 * variant-to-gallery mapping, which is how a redrawn PDP makes the frame follow a colour choice;
 * this surface does not pass them, so the page behaves exactly as before.
 */

type ProductGalleryProps = {
  media: StorefrontProductMedia;
  productName: string;
  /**
   * Which image to open on, resolved on the server from a `?variant=` deep link. A plain product
   * page passes nothing and opens on the first image as before.
   */
  initialIndex?: number;
};

export function ProductGallery(props: ProductGalleryProps) {
  return <BrandProductGallery {...props} />;
}
