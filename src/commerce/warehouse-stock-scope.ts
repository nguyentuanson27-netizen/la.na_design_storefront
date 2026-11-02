/**
 * `WarehouseStock.pancakeWarehouseId` is an opaque key. Rows that belong to the primary Pancake shop
 * keep the warehouse id Pancake reports; rows contributed by a read-only secondary shop are
 * namespaced `secondary:<shopId>:<warehouseId>`.
 *
 * The namespace is what lets two independent syncs each rewrite "the complete warehouse set of a
 * variant" without deleting the other's rows, and without either of them having to know which
 * warehouses the other shop owns. It also means a secondary warehouse id can never collide with a
 * primary one.
 */
export const SECONDARY_WAREHOUSE_KEY_PREFIX = "secondary:";

export type WarehouseStockScope =
  | Readonly<{ kind: "primary" }>
  | Readonly<{
      kind: "secondary";
      shopId: number;
      /** The normalized SKU the written rows are attributed to (recorded in `secondarySku`). */
      sku?: string | null;
    }>;

export const PRIMARY_WAREHOUSE_SCOPE: WarehouseStockScope = { kind: "primary" };

export function secondaryShopKeyPrefix(shopId: number): string {
  if (!Number.isSafeInteger(shopId) || shopId <= 0) {
    throw new TypeError("Secondary shop id must be a positive integer");
  }
  return `${SECONDARY_WAREHOUSE_KEY_PREFIX}${shopId}:`;
}

export function secondaryWarehouseKey(shopId: number, warehouseId: string): string {
  return `${secondaryShopKeyPrefix(shopId)}${warehouseId}`;
}

/** The stored key for a warehouse id Pancake reported, within `scope`. */
export function warehouseStockKey(scope: WarehouseStockScope, warehouseId: string): string {
  if (scope.kind === "secondary") return secondaryWarehouseKey(scope.shopId, warehouseId);
  if (warehouseId.startsWith(SECONDARY_WAREHOUSE_KEY_PREFIX)) {
    throw new Error("Primary warehouse id collides with the secondary warehouse namespace");
  }
  return warehouseId;
}

/** Prisma `where` fragment selecting exactly the `WarehouseStock` rows `scope` owns. */
export function warehouseStockScopeFilter(scope: WarehouseStockScope) {
  return scope.kind === "secondary"
    ? { pancakeWarehouseId: { startsWith: secondaryShopKeyPrefix(scope.shopId) } }
    : { NOT: { pancakeWarehouseId: { startsWith: SECONDARY_WAREHOUSE_KEY_PREFIX } } };
}
