import type { PrismaClient } from "../generated/prisma/client.ts";
import { fetchAllPancakeCatalogVariations } from "../integrations/pancake/catalog-pages.ts";
import type { PancakeCatalogWarehouseStock } from "../integrations/pancake/catalog-contract.ts";
import { normalizeSku } from "../integrations/pancake/sku.ts";
import { writeObservedWarehouseStocks } from "./catalog-mirror-repository.ts";
import {
  SECONDARY_WAREHOUSE_KEY_PREFIX,
  secondaryShopKeyPrefix,
} from "./warehouse-stock-scope.ts";

export { normalizeSku };

export type SecondaryInventorySyncClient = {
  getJson(
    endpoint: string,
    query?: Readonly<Record<string, string | number | boolean>>,
  ): Promise<unknown>;
};

export type SecondaryInventorySyncResult = {
  secondaryShopId: number;
  totalSecondaryVariations: number;
  /** Primary variants that received secondary stock. */
  matchedCount: number;
  /** Secondary SKUs with no primary variant; ignored. */
  unmatchedCount: number;
  /**
   * SKUs shared by more than one present primary variant. Which of them the secondary stock belongs
   * to is unknowable, and giving it to all of them would count the same units several times, so none
   * of them receives any.
   */
  ambiguousCount: number;
  totalStockAggregated: number;
  warehouseCount: number;
};

const CHUNK_SIZE = 100;

export async function syncSecondaryShopInventory({
  primaryShopId,
  secondaryShopId,
  secondaryClient,
  prisma,
  clock = () => new Date(),
  warn = (message) => console.warn(message),
}: {
  primaryShopId: number;
  secondaryShopId: number;
  secondaryClient: SecondaryInventorySyncClient;
  prisma: PrismaClient;
  clock?: () => Date;
  /** Fixed text plus counts only: never a Pancake payload, SKU list or credential. */
  warn?: (message: string) => void;
}): Promise<SecondaryInventorySyncResult> {
  // Sampled before the read starts, like the primary sync: a stock figure is only as new as the
  // instant its read began.
  const observedAt = clock();

  const secondaryVariations = await fetchAllPancakeCatalogVariations({
    client: secondaryClient,
    shopId: secondaryShopId,
  });

  // Secondary stock per normalized SKU and warehouse. A SKU repeated inside the secondary shop is
  // summed per warehouse: they are the same article held in the same place.
  const secondaryBySku = new Map<string, Map<string, number>>();
  for (const variation of secondaryVariations) {
    const sku = normalizeSku(variation.displayId);
    if (!sku) continue;
    let byWarehouse = secondaryBySku.get(sku);
    if (!byWarehouse) {
      byWarehouse = new Map();
      secondaryBySku.set(sku, byWarehouse);
    }
    for (const { warehouseId, remainQuantity } of variation.warehouseStocks) {
      byWarehouse.set(warehouseId, (byWarehouse.get(warehouseId) ?? 0) + remainQuantity);
    }
  }

  const primaryVariants = await prisma.variantMirror.findMany({
    where: {
      product: { pancakeShopId: primaryShopId },
      pancakeDisplayId: { not: null },
    },
    select: { id: true, pancakeDisplayId: true, isPresent: true },
  });

  // Only variants still on sale compete for a SKU; a retired variant keeping the code of its
  // replacement must not make the replacement ambiguous.
  const presentVariantsBySku = new Map<string, number>();
  for (const variant of primaryVariants) {
    const sku = normalizeSku(variant.pancakeDisplayId);
    if (!sku || !variant.isPresent) continue;
    presentVariantsBySku.set(sku, (presentVariantsBySku.get(sku) ?? 0) + 1);
  }

  let matchedCount = 0;
  let totalStockAggregated = 0;
  const seenWarehouseIds = new Set<string>();
  const primarySkus = new Set<string>();
  const ambiguousSkus = new Set<string>();
  const updates: Array<{ variantId: string; stocks: PancakeCatalogWarehouseStock[] }> = [];

  for (const variant of primaryVariants) {
    const sku = normalizeSku(variant.pancakeDisplayId);
    if (!sku) continue;
    primarySkus.add(sku);

    const byWarehouse = secondaryBySku.get(sku);
    const ambiguous = (presentVariantsBySku.get(sku) ?? 0) > 1;
    if (ambiguous) ambiguousSkus.add(sku);

    // Empty stocks clear whatever this shop contributed before: an unmatched, retired or ambiguous
    // variant must not keep a stale figure.
    if (!byWarehouse || !variant.isPresent || ambiguous) {
      updates.push({ variantId: variant.id, stocks: [] });
      continue;
    }
    const stocks = [...byWarehouse].map(([warehouseId, remainQuantity]) => ({
      warehouseId,
      remainQuantity,
    }));
    matchedCount += 1;
    for (const { warehouseId, remainQuantity } of stocks) {
      totalStockAggregated += remainQuantity;
      seenWarehouseIds.add(warehouseId);
    }
    updates.push({ variantId: variant.id, stocks });
  }

  let unmatchedCount = 0;
  for (const sku of secondaryBySku.keys()) {
    if (!primarySkus.has(sku)) unmatchedCount += 1;
  }

  if (ambiguousSkus.size > 0) {
    warn(
      `Secondary Pancake inventory sync skipped ${ambiguousSkus.size} SKU(s) shared by several primary variants`,
    );
  }

  for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
    const chunk = updates.slice(i, i + CHUNK_SIZE);
    await prisma.$transaction(async (tx) => {
      for (const { variantId, stocks } of chunk) {
        await writeObservedWarehouseStocks(tx, variantId, stocks, observedAt, {
          kind: "secondary",
          shopId: secondaryShopId,
        });
      }
    });
  }

  return {
    secondaryShopId,
    totalSecondaryVariations: secondaryVariations.length,
    matchedCount,
    unmatchedCount,
    ambiguousCount: ambiguousSkus.size,
    totalStockAggregated,
    warehouseCount: seenWarehouseIds.size,
  };
}

/**
 * Removes secondary-shop stock that must no longer be trusted, and returns how many rows went.
 * Removing is the safe direction: the storefront then sells on primary stock alone and the checkout
 * live read still adds whatever the secondary shop really has.
 *
 * - `exceptShopId`: keep that shop's rows, remove every other secondary shop's (the configured
 *   shop id changed).
 * - `shopId` + `syncedBefore`: remove that shop's rows last written before the instant (its sync
 *   has been failing).
 * - neither: remove every secondary row (the feature was switched off).
 */
export async function purgeSecondaryWarehouseStock(
  prisma: Pick<PrismaClient, "warehouseStock">,
  options: { exceptShopId?: number; shopId?: number; syncedBefore?: Date } = {},
): Promise<number> {
  const { exceptShopId, shopId, syncedBefore } = options;
  const result = await prisma.warehouseStock.deleteMany({
    where: {
      pancakeWarehouseId: {
        startsWith:
          shopId === undefined ? SECONDARY_WAREHOUSE_KEY_PREFIX : secondaryShopKeyPrefix(shopId),
      },
      ...(exceptShopId === undefined
        ? {}
        : { NOT: { pancakeWarehouseId: { startsWith: secondaryShopKeyPrefix(exceptShopId) } } }),
      ...(syncedBefore === undefined ? {} : { syncedAt: { lt: syncedBefore } }),
    },
  });
  return result.count;
}
