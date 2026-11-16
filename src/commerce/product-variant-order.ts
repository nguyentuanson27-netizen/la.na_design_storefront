import { compareClothingSizes } from "./clothing-size.ts";

/**
 * Explicit preferred color ordering for specific products.
 *
 * Key: Uppercase product code (or identifier) e.g. "SV612".
 * Value: Ordered list of colors (case-insensitive matching).
 *
 * For example, for "SV612" (Set váy Bích Liên):
 * Setting ["Hồng", "Be"] ensures that:
 * 1. The pink color variant photo becomes the primary image and sits first in the gallery.
 * 2. On PDP, "Hồng" is listed first in the color selector.
 * 3. Product cards across all listing pages (/shop, /set-do, /set-do/set-vay) feature the pink photo.
 */
export const PRODUCT_COLOR_PREFERENCE: Readonly<Record<string, readonly string[]>> = {
  SV612: ["Hồng", "Be"],
};

/**
 * Resolve preferred color order for a product by checking its productCode, slug, or name.
 */
export function resolveProductColorPreference(product: {
  productCode?: string | null;
  slug?: string | null;
  name?: string | null;
}): readonly string[] | null {
  const code = product.productCode?.trim().toUpperCase();
  if (code && PRODUCT_COLOR_PREFERENCE[code]) {
    return PRODUCT_COLOR_PREFERENCE[code];
  }

  // Check matching against configured keys
  for (const [key, colors] of Object.entries(PRODUCT_COLOR_PREFERENCE)) {
    const upperKey = key.toUpperCase();
    if (
      (product.productCode && product.productCode.toUpperCase() === upperKey) ||
      (product.slug && product.slug.toUpperCase().includes(upperKey)) ||
      (product.name && product.name.toUpperCase().includes(upperKey))
    ) {
      return colors;
    }
  }

  return null;
}

/**
 * Orders a product's variants according to the product's color preference (if any),
 * and standard clothing size order within each color group.
 *
 * If no preference is configured for the product, variants are returned in their original order.
 */
export function orderProductVariants<
  T extends {
    color?: string | null;
    size?: string | null;
  },
>(
  product: {
    productCode?: string | null;
    slug?: string | null;
    name?: string | null;
  },
  variants: readonly T[],
): T[] {
  const preferredColors = resolveProductColorPreference(product);
  if (!preferredColors || preferredColors.length === 0 || variants.length <= 1) {
    return [...variants];
  }

  const normalizedPreferred = preferredColors.map((c) => c.trim().toLowerCase());

  return variants
    .map((variant, originalIndex) => {
      const color = variant.color?.trim().toLowerCase() ?? "";
      const rank = normalizedPreferred.indexOf(color);
      return {
        variant,
        originalIndex,
        colorRank: rank === -1 ? Number.POSITIVE_INFINITY : rank,
      };
    })
    .sort((a, b) => {
      if (a.colorRank !== b.colorRank) {
        return a.colorRank - b.colorRank;
      }
      if (a.variant.size && b.variant.size) {
        const sizeComparison = compareClothingSizes(a.variant.size, b.variant.size);
        if (sizeComparison !== 0) {
          return sizeComparison;
        }
      }
      return a.originalIndex - b.originalIndex;
    })
    .map(({ variant }) => variant);
}
