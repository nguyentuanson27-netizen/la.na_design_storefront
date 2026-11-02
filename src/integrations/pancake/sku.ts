/**
 * The one SKU normalization used to match a secondary shop's variation to the primary shop's:
 * surrounding whitespace is ignored and case is folded. Anything else (inner spaces, punctuation)
 * is significant, so two SKUs only match when they are the same code typed the same way.
 */
export function normalizeSku(sku: string | null | undefined): string | null {
  if (!sku) return null;
  const normalized = sku.trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
}
