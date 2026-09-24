const MAX_POSTGRES_INTEGER = 2_147_483_647;

export type CompositeCapacityComponent = Readonly<{
  requiredQuantity: number;
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

/**
 * Advisory FULL SET capacity derived from the resources the set actually consumes.
 *
 * Parent WarehouseStock stays a verbatim Pancake mirror. Composite capacity is therefore computed
 * from component stock rather than copied into the parent row, which would be overwritten by the
 * next catalog sync and would give different parent variants independent claims on shared stock.
 *
 * Child activation is deliberately not an input. isActive controls whether a child may be sold as
 * its own storefront option; a present child can still be a valid stocked component of a FULL SET.
 */
export function deriveCompositeSellableStock({
  shopId,
  components,
}: Readonly<{
  shopId: number;
  components: readonly CompositeCapacityComponent[];
}>): number {
  if (!Number.isSafeInteger(shopId) || shopId <= 0 || shopId > MAX_POSTGRES_INTEGER) return 0;
  if (components.length === 0) return 0;

  let capacity = MAX_POSTGRES_INTEGER;
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
      return 0;
    }

    const stock = sumCountableStock(component.warehouseStocks);
    if (stock === null) return 0;
    const edgeCapacity = Math.floor(Math.max(0, stock) / edge.requiredQuantity);
    capacity = Math.min(capacity, edgeCapacity);
  }

  return capacity;
}
