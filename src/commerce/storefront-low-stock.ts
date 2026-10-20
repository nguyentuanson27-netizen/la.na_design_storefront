/**
 * "Còn x": how many ready pieces are left, when that number is small and true.
 *
 * Shared by the product card (one total per product) and the product page (the total, and each
 * variant's own count), so the two surfaces cannot disagree about when the claim is made.
 *
 * Counted from the canonical per-option answer, the same one `Hết hàng` reads: only options still for
 * sale from ready stock, each floored at zero. Under `PREORDER` or `OVERSELL` the count is not a
 * ceiling on what the shopper can buy, so stating it would be false; the claim is reserved for
 * `STANDARD`. A caller that did not read the product's policy gets the STANDARD default for
 * availability, but that default is not proof the product cannot oversell, so it says nothing.
 */

import type { StorefrontProductCapacity, StorefrontVariantOption } from "./storefront-product.ts";

/** "Còn x" is said below this many ready pieces. */
export const LOW_STOCK_LIMIT = 5;

type LowStockOption = Pick<
  StorefrontVariantOption,
  "id" | "purchasable" | "isPreorderSale" | "sellableStock"
>;

function readyPieces(option: LowStockOption): number {
  if (!option.purchasable || option.isPreorderSale) return 0;
  return Number.isSafeInteger(option.sellableStock) ? Math.max(0, option.sellableStock) : 0;
}

function isLow(pieces: number): boolean {
  return pieces > 0 && pieces < LOW_STOCK_LIMIT;
}

/**
 * The product's total, or `null`.
 *
 * A composite (FULL SET) makes the claim only when its sizes share no component: each size's figure
 * is then derived from its own pieces and the sizes add up. When a component is shared (or the read
 * did not say), summing would count the same pieces twice.
 */
export function resolveLowStockTotal(
  options: readonly LowStockOption[],
  productCapacity: StorefrontProductCapacity | undefined,
): number | null {
  if (productCapacity?.sellingMode !== "STANDARD") return null;
  if (productCapacity.isComposite && productCapacity.sharesComponents !== false) return null;
  const total = options.reduce((sum, option) => sum + readyPieces(option), 0);
  return isLow(total) ? total : null;
}

/**
 * Each low variant's own count, keyed by variant id; variants with enough stock are absent.
 *
 * One variant's figure is exact on its own even when components are shared, so only the policy
 * gates it.
 */
export function resolveLowStockByVariantId(
  options: readonly LowStockOption[],
  productCapacity: StorefrontProductCapacity | undefined,
): Readonly<Record<string, number>> {
  if (productCapacity?.sellingMode !== "STANDARD") return Object.freeze({});
  const low: Record<string, number> = {};
  for (const option of options) {
    const pieces = readyPieces(option);
    if (isLow(pieces)) low[option.id] = pieces;
  }
  return Object.freeze(low);
}
