import {
  capacityFloorForMode,
  type CapacityDecisionReason,
  type SellingMode,
} from "./capacity-policy.ts";

const MAX_POSTGRES_INTEGER = 2_147_483_647;

export type CompositeCapacityComponent = Readonly<{
  requiredQuantity: number;
  /**
   * Units of this component still held by reservations that count (`resourceHoldsCapacity()`),
   * from `readAdvisoryHeldQuantities()`. Absent means none are known to the caller, which is the
   * pre-read-model answer; a surface that shows buyers capacity supplies it.
   */
  activeReservedQuantity?: number;
  componentVariant: Readonly<{
    isPresent: boolean;
    product: Readonly<{
      pancakeShopId: number;
      isPresent: boolean;
    }>;
    warehouseStocks: readonly Readonly<{ quantity: number }>[];
  }>;
}>;

function sumCountableStock(stocks: readonly Readonly<{ quantity: number }>[]): number | null {
  let total = 0;
  for (const stock of stocks) {
    if (!Number.isSafeInteger(stock.quantity)) return null;
    total += stock.quantity;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

export type CompositeCapacitySnapshot = Readonly<{
  sellingMode: SellingMode;
  negativeStockLimit: number;
  readyQuantity: number;
  reservableQuantity: number;
  reason: CapacityDecisionReason;
}>;

function invalidStockCapacity(
  sellingMode: SellingMode,
  negativeStockLimit: number,
): CompositeCapacitySnapshot {
  return Object.freeze({
    sellingMode,
    negativeStockLimit,
    readyQuantity: 0,
    reservableQuantity: 0,
    reason: "invalid-stock",
  });
}

/**
 * Component-aware advisory capacity for one composite parent.
 *
 * readyQuantity is the number of whole parents that can be assembled now. reservableQuantity is the
 * number that can still be accepted before any component crosses this product's capacity floor.
 * Keeping both values is required for PREORDER and for component multipliers greater than one.
 */
export function deriveCompositeCapacitySnapshot({
  shopId,
  components,
  sellingMode,
  negativeStockLimit,
}: Readonly<{
  shopId: number;
  components: readonly CompositeCapacityComponent[];
  sellingMode: SellingMode;
  negativeStockLimit: number;
}>): CompositeCapacitySnapshot {
  if (!Number.isSafeInteger(negativeStockLimit) || negativeStockLimit > 0) {
    return Object.freeze({
      sellingMode,
      negativeStockLimit,
      readyQuantity: 0,
      reservableQuantity: 0,
      reason: "invalid-limit" as const,
    });
  }
  if (!Number.isSafeInteger(shopId) || shopId <= 0 || shopId > MAX_POSTGRES_INTEGER) {
    return invalidStockCapacity(sellingMode, negativeStockLimit);
  }
  if (components.length === 0) return invalidStockCapacity(sellingMode, negativeStockLimit);

  const floor = capacityFloorForMode(sellingMode, negativeStockLimit);
  let readyQuantity = MAX_POSTGRES_INTEGER;
  let reservableQuantity = MAX_POSTGRES_INTEGER;

  for (const edge of components) {
    const component = edge.componentVariant;
    if (
      component.product.pancakeShopId !== shopId ||
      !component.product.isPresent ||
      !component.isPresent ||
      !Number.isSafeInteger(edge.requiredQuantity) ||
      edge.requiredQuantity <= 0 ||
      edge.requiredQuantity > MAX_POSTGRES_INTEGER
    ) {
      return invalidStockCapacity(sellingMode, negativeStockLimit);
    }

    const stock = sumCountableStock(component.warehouseStocks);
    if (stock === null) return invalidStockCapacity(sellingMode, negativeStockLimit);
    const held = edge.activeReservedQuantity ?? 0;
    if (!Number.isSafeInteger(held) || held < 0) return invalidStockCapacity(sellingMode, negativeStockLimit);

    const available = stock - held;
    const headroom = available - floor;
    if (!Number.isSafeInteger(available) || !Number.isSafeInteger(headroom)) {
      return invalidStockCapacity(sellingMode, negativeStockLimit);
    }

    const maxByResourceRow = Math.floor(MAX_POSTGRES_INTEGER / edge.requiredQuantity);
    const edgeReady = Math.min(
      Math.floor(Math.max(0, available) / edge.requiredQuantity),
      maxByResourceRow,
    );
    const edgeReservable = Math.min(
      Math.max(0, Math.floor(headroom / edge.requiredQuantity)),
      maxByResourceRow,
    );
    readyQuantity = Math.min(readyQuantity, edgeReady);
    reservableQuantity = Math.min(reservableQuantity, edgeReservable);
  }

  const reason: CapacityDecisionReason =
    reservableQuantity > 0
      ? "capacity-available"
      : sellingMode === "STANDARD"
        ? "standard-would-go-negative"
        : "negative-limit-reached";

  return Object.freeze({
    sellingMode,
    negativeStockLimit,
    readyQuantity,
    reservableQuantity,
    reason,
  });
}

/**
 * Advisory FULL SET capacity derived from the resources the set actually consumes.
 *
 * Parent WarehouseStock stays a verbatim Pancake mirror. Composite capacity is therefore computed
 * from component stock rather than copied into the parent row, which would be overwritten by the
 * next catalog sync and would give different parent variants independent claims on shared stock.
 *
 * Units other orders still hold on a component are subtracted before dividing, the same resource
 * accounting `reserveOrderCapacity()` applies, so a set is never advertised from component units a
 * concurrent order already owns.
 *
 * Child activation is deliberately not an input. isActive controls whether a child may be sold as
 * its own storefront option; a present child can still be a valid stocked component of a FULL SET.
 */
export function deriveCompositeSellableStock(input: Readonly<{
  shopId: number;
  components: readonly CompositeCapacityComponent[];
}>): number {
  return deriveCompositeCapacitySnapshot({
    ...input,
    sellingMode: "STANDARD",
    negativeStockLimit: 0,
  }).readyQuantity;
}
