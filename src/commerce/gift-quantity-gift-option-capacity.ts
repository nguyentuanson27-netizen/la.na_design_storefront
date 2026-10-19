import { deriveCompositeSellableStock } from "./composite-capacity.ts";

/** Shared READY-stock rule for Admin, PDP and cart. Holds/paid demand are supplied by the caller. */
export type GiftVariantCapacityRow = Readonly<{
  id: string;
  isPresent: boolean;
  isActive: boolean;
  product: Readonly<{ pancakeShopId: number; isPresent: boolean; isActive: boolean }>;
  warehouseStocks: readonly Readonly<{ quantity: number }>[];
  compositeComponents: readonly Readonly<{
    quantity: number;
    componentVariant: Readonly<{
      id: string;
      isPresent: boolean;
      product: Readonly<{ pancakeShopId: number; isPresent: boolean }>;
      warehouseStocks: readonly Readonly<{ quantity: number }>[];
    }>;
  }>[];
}>;

export function readyGiftResourceUnits(stocks: readonly Readonly<{ quantity: number }>[], used = 0): number {
  if (!Number.isSafeInteger(used) || used < 0) return 0;
  let total = 0;
  for (const row of stocks) {
    if (!Number.isSafeInteger(row.quantity)) return 0;
    total += row.quantity;
    if (!Number.isSafeInteger(total)) return 0;
  }
  const remaining = total - used;
  return Number.isSafeInteger(remaining) ? Math.max(0, remaining) : 0;
}

export function readyGiftOptionStock(row: GiftVariantCapacityRow, usedByResourceId: ReadonlyMap<string, number> = new Map()): number {
  if (!row.isPresent || !row.isActive || !row.product.isPresent || !row.product.isActive) return 0;
  if (row.compositeComponents.length === 0) {
    return readyGiftResourceUnits(row.warehouseStocks, usedByResourceId.get(row.id) ?? 0);
  }
  // Child activation is not an input: a present child can stock a full set even when it is not
  // separately sold. This is the same contract used by cart and checkout capacity reservation.
  return deriveCompositeSellableStock({
    shopId: row.product.pancakeShopId,
    components: row.compositeComponents.map((edge) => ({
      requiredQuantity: edge.quantity,
      activeReservedQuantity: usedByResourceId.get(edge.componentVariant.id) ?? 0,
      componentVariant: edge.componentVariant,
    })),
  });
}
