import type { StorefrontProductMedia, TrustedProductImage } from "../commerce/product-media.ts";

/**
 * The editorial panels a merchandised page fills from its own products.
 *
 * Shared by the home and lookbook routes, which had the same rule written out twice. A panel is
 * filled from the nth product that has trusted photography, and falls back to the one above it, so
 * a catalog with a single photographed product fills every panel rather than leaving blank walls
 * where a full-bleed image was meant to be. A page with no photography at all reports `null` panels
 * and lets markup render its placeholder.
 */

export type EditorialSource = Readonly<{
  name: string;
  media?: StorefrontProductMedia | null;
}>;

export type EditorialPanel = Readonly<{
  image: TrustedProductImage;
  /** So markup can caption a photo whose own alt text is empty. */
  productName: string;
}> | null;

export function selectEditorialPanels(
  products: readonly EditorialSource[],
  count: number,
): readonly EditorialPanel[] {
  const photographed = products.filter((product) => product.media?.primary);

  return Object.freeze(
    Array.from({ length: count }, (_, index) => {
      // Walk back to the first panel that has a photo, so no slot is left empty while one exists.
      for (let candidate = index; candidate >= 0; candidate -= 1) {
        const product = photographed[candidate];
        const image = product?.media?.primary;
        if (image) return Object.freeze({ image, productName: product.name });
      }
      return null;
    }),
  );
}
