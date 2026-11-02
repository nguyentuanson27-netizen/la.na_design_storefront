import type { PrismaClient } from "../generated/prisma/client.ts";
import {
  fetchAllPancakeCatalogVariations,
  fetchPancakeWarehouses,
} from "../integrations/pancake/catalog-pages.ts";
import type { PancakeCatalogWarehouseStock } from "../integrations/pancake/catalog-contract.ts";
import { writeObservedWarehouseStocks } from "./catalog-mirror-repository.ts";

export type SecondaryInventorySyncClient = {
  getJson(
    endpoint: string,
    query?: Readonly<Record<string, string | number | boolean>>,
  ): Promise<unknown>;
};

export type SecondaryInventorySyncResult = {
  secondaryShopId: number;
  totalSecondaryVariations: number;
  matchedCount: number;
  unmatchedCount: number;
  totalStockAggregated: number;
  warehouseCount: number;
};

export function normalizeSku(sku: string | null | undefined): string | null {
  if (!sku) return null;
  const trimmed = sku.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : null;
}

const CHUNK_SIZE = 100;

export async function syncSecondaryShopInventory({
  primaryShopId,
  secondaryShopId,
  secondaryClient,
  prisma,
  clock = () => new Date(),
}: {
  primaryShopId: number;
  secondaryShopId: number;
  secondaryClient: SecondaryInventorySyncClient;
  prisma: PrismaClient;
  clock?: () => Date;
}): Promise<SecondaryInventorySyncResult> {
  const observedAt = clock();

  // 1. Fetch warehouses of the secondary shop to establish scope
  const secondaryWarehouses = await fetchPancakeWarehouses({
    client: secondaryClient,
    shopId: secondaryShopId,
  });
  const secondaryWarehouseIds = secondaryWarehouses.map((w) => w.id);
  if (secondaryWarehouseIds.length === 0) {
    return {
      secondaryShopId,
      totalSecondaryVariations: 0,
      matchedCount: 0,
      unmatchedCount: 0,
      totalStockAggregated: 0,
      warehouseCount: 0,
    };
  }

  // 2. Fetch all variations from secondary shop
  const secondaryVariations = await fetchAllPancakeCatalogVariations({
    client: secondaryClient,
    shopId: secondaryShopId,
  });

  // 3. Group secondary variations by normalized SKU
  const secondaryStocksBySku = new Map<string, PancakeCatalogWarehouseStock[]>();
  for (const variation of secondaryVariations) {
    const sku = normalizeSku(variation.displayId);
    if (!sku) continue;

    const existing = secondaryStocksBySku.get(sku);
    if (!existing) {
      secondaryStocksBySku.set(sku, [...variation.warehouseStocks]);
    } else {
      const byWh = new Map<string, number>();
      for (const s of existing) {
        byWh.set(s.warehouseId, (byWh.get(s.warehouseId) ?? 0) + s.remainQuantity);
      }
      for (const s of variation.warehouseStocks) {
        byWh.set(s.warehouseId, (byWh.get(s.warehouseId) ?? 0) + s.remainQuantity);
      }
      secondaryStocksBySku.set(
        sku,
        [...byWh.entries()].map(([warehouseId, remainQuantity]) => ({
          warehouseId,
          remainQuantity,
        })),
      );
    }
  }

  // 4. Query primary shop variants from the database
  const primaryVariants = await prisma.variantMirror.findMany({
    where: {
      product: { pancakeShopId: primaryShopId },
      pancakeDisplayId: { not: null },
    },
    select: {
      id: true,
      pancakeDisplayId: true,
    },
  });

  let matchedCount = 0;
  let totalStockAggregated = 0;
  const updates: Array<{ variantId: string; stocks: PancakeCatalogWarehouseStock[] }> = [];
  const primarySkus = new Set<string>();

  for (const variant of primaryVariants) {
    const sku = normalizeSku(variant.pancakeDisplayId);
    if (!sku) continue;
    primarySkus.add(sku);

    const secondaryStocks = secondaryStocksBySku.get(sku);
    if (secondaryStocks && secondaryStocks.length > 0) {
      matchedCount += 1;
      const stockSum = secondaryStocks.reduce((sum, s) => sum + s.remainQuantity, 0);
      totalStockAggregated += stockSum;
      updates.push({ variantId: variant.id, stocks: secondaryStocks });
    } else {
      // If variant has no stock in secondary shop, supply empty array so any
      // previous secondary warehouse rows in this scope are cleared.
      updates.push({ variantId: variant.id, stocks: [] });
    }
  }

  let unmatchedCount = 0;
  for (const sku of secondaryStocksBySku.keys()) {
    if (!primarySkus.has(sku)) {
      unmatchedCount += 1;
    }
  }

  // 5. Apply warehouse stocks in transactions chunked by CHUNK_SIZE
  for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
    const chunk = updates.slice(i, i + CHUNK_SIZE);
    await prisma.$transaction(async (tx) => {
      for (const { variantId, stocks } of chunk) {
        await writeObservedWarehouseStocks(tx, variantId, stocks, observedAt, {
          scopeWarehouseIds: secondaryWarehouseIds,
          stampVariantWatermark: false,
        });
      }
    });
  }

  return {
    secondaryShopId,
    totalSecondaryVariations: secondaryVariations.length,
    matchedCount,
    unmatchedCount,
    totalStockAggregated,
    warehouseCount: secondaryWarehouseIds.length,
  };
}
