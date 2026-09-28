import type { PancakeCatalogWarehouseStock } from "./catalog-contract.ts";

/**
 * The authoritative per-product stock read the targeted inventory batch uses after a
 * `variations_warehouses` webhook: `GET /shops/{SHOP_ID}/products/{PRODUCT_ID}`, whose
 * `data.variations[].variations_warehouses[]` rows carry the same `warehouse_id`/`remain_quantity`
 * fields the reviewed catalog contract sums.
 *
 * ENDPOINT CONTRACT — PENDING OPENAPI CONFIRMATION: the repository's reviewed Pancake contract covers
 * only the paginated `/products/variations` listing. This reader is deliberately fail-closed: any
 * shape it does not recognise throws, the batch keeps the marker for retry, and the hourly full
 * reconciliation (reviewed endpoint) still converges the mirror.
 */

type QueryValue = string | number | boolean;
type ProductClient = {
  getJson(endpoint: string, query?: Readonly<Record<string, QueryValue>>): Promise<unknown>;
};

const CONTRACT_ERROR = "Pancake product stock payload is malformed";
const MAX_ID_LENGTH = 512;

function fail(): never {
  throw new TypeError(CONTRACT_ERROR);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}

function requireId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_LENGTH) fail();
  return value;
}

/** Every variation of one Pancake product, with its complete warehouse stock rows. */
export async function fetchPancakeProductVariationStocks({
  client,
  shopId,
  productId,
}: {
  client: ProductClient;
  shopId: number;
  productId: string;
}): Promise<Map<string, PancakeCatalogWarehouseStock[]>> {
  if (!Number.isSafeInteger(shopId) || shopId <= 0) fail();
  const safeProductId = requireId(productId);

  const root = requireRecord(
    await client.getJson(`/shops/${shopId}/products/${encodeURIComponent(safeProductId)}`),
  );
  if (root.success !== true) fail();
  const product = requireRecord(root.data);
  if (product.id !== undefined && product.id !== safeProductId) fail();
  if (!Array.isArray(product.variations)) fail();

  const stocksByVariationId = new Map<string, PancakeCatalogWarehouseStock[]>();
  for (const variationValue of product.variations) {
    const variation = requireRecord(variationValue);
    const variationId = requireId(variation.id);
    if (stocksByVariationId.has(variationId)) fail();
    if (variation.product_id !== undefined && variation.product_id !== safeProductId) fail();
    if (!Array.isArray(variation.variations_warehouses)) fail();

    const warehouseIds = new Set<string>();
    const stocks: PancakeCatalogWarehouseStock[] = [];
    for (const rowValue of variation.variations_warehouses) {
      const row = requireRecord(rowValue);
      const warehouseId = requireId(row.warehouse_id);
      const remainQuantity = row.remain_quantity;
      if (warehouseIds.has(warehouseId) || typeof remainQuantity !== "number" || !Number.isFinite(remainQuantity)) {
        fail();
      }
      warehouseIds.add(warehouseId);
      stocks.push({ warehouseId, remainQuantity });
    }
    stocksByVariationId.set(variationId, stocks);
  }
  return stocksByVariationId;
}
