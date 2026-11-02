import type { PrismaClient } from "../generated/prisma/client.ts";
import { fetchAllPancakeCatalogVariations } from "../integrations/pancake/catalog-pages.ts";
import type { PancakeCatalogWarehouseStock } from "../integrations/pancake/catalog-contract.ts";
import { normalizeSku } from "../integrations/pancake/sku.ts";
import {
  observeStoredStockAvailability,
  writeObservedWarehouseStocks,
} from "./catalog-mirror-repository.ts";
import {
  acquireCatalogSyncLock,
  CATALOG_SYNC_LOCK_WAITER_TIMEOUT_MS,
  lockVariantMirrorRows,
} from "./catalog-sync-lock.ts";
import {
  SECONDARY_WAREHOUSE_KEY_PREFIX,
  secondaryShopKeyPrefix,
} from "./warehouse-stock-scope.ts";

export { normalizeSku };

type SyncTransaction = Parameters<typeof observeStoredStockAvailability>[0];

/** Database-side steps of a chunk, injectable so the matching logic can be tested without a database. */
export type SecondaryInventorySyncHooks = {
  acquireLock(tx: SyncTransaction, shopId: number): Promise<void>;
  lockVariants(tx: SyncTransaction, variantIds: readonly string[]): Promise<void>;
  observeAvailability(
    tx: SyncTransaction,
    input: { shopId: number; variantIds: readonly string[]; observedAt: Date },
  ): Promise<void>;
};

const DEFAULT_HOOKS: SecondaryInventorySyncHooks = {
  acquireLock: acquireCatalogSyncLock,
  lockVariants: lockVariantMirrorRows,
  observeAvailability: observeStoredStockAvailability,
};

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
  hooks = DEFAULT_HOOKS,
}: {
  primaryShopId: number;
  secondaryShopId: number;
  secondaryClient: SecondaryInventorySyncClient;
  prisma: PrismaClient;
  clock?: () => Date;
  /** Fixed text plus counts only: never a Pancake payload, SKU list or credential. */
  warn?: (message: string) => void;
  hooks?: SecondaryInventorySyncHooks;
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

  // A variant that lost its SKU is read too when it still carries this shop's rows: they matched
  // the old SKU and must be cleared, not left to be counted until they go stale.
  const primaryVariants = await prisma.variantMirror.findMany({
    where: {
      product: { pancakeShopId: primaryShopId },
      OR: [
        { pancakeDisplayId: { not: null } },
        {
          warehouseStocks: {
            some: { pancakeWarehouseId: { startsWith: secondaryShopKeyPrefix(secondaryShopId) } },
          },
        },
      ],
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
    if (!sku) {
      updates.push({ variantId: variant.id, stocks: [] });
      continue;
    }
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

  // Availability cycles are dated by the day the stock was observed, which for a figure read from
  // Pancake is after the read finished (the primary sync does the same).
  const availabilityObservedAt = clock();
  for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
    const chunk = updates.slice(i, i + CHUNK_SIZE);
    await prisma.$transaction(
      async (tx) => {
        // The shop's catalog-sync lock serializes this with the primary sync and the admin policy
        // writes that decide a preorder variant's availability cycle.
        await hooks.acquireLock(tx, primaryShopId);
        // The rows `reserveOrderCapacity()` locks before it reads stock, in the same order, so a
        // reservation never commits on a figure this chunk is replacing.
        await hooks.lockVariants(tx, chunk.map(({ variantId }) => variantId));
        for (const { variantId, stocks } of chunk) {
          await writeObservedWarehouseStocks(tx, variantId, stocks, observedAt, {
            kind: "secondary",
            shopId: secondaryShopId,
          });
        }
        // The secondary stock just changed what these variants (and the combos built on them) can
        // sell, so their sold-out cycles are judged again against everything now stored.
        await hooks.observeAvailability(tx, {
          shopId: primaryShopId,
          variantIds: chunk.map(({ variantId }) => variantId),
          observedAt: availabilityObservedAt,
        });
      },
      { timeout: CATALOG_SYNC_LOCK_WAITER_TIMEOUT_MS },
    );
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
 * Done like every other stock write: under the shop's catalog-sync lock, with the affected variant
 * rows locked, and followed by a fresh availability observation of those variants (and the combos
 * built on them) so a preorder cycle never keeps describing stock that is no longer there.
 *
 * - `exceptShopId`: keep that shop's rows, remove every other secondary shop's (the configured
 *   shop id changed).
 * - `shopId` + `syncedBefore`: remove that shop's rows last written before the instant (its sync
 *   has been failing).
 * - neither: remove every secondary row (the feature was switched off).
 */
export async function purgeSecondaryWarehouseStock(
  prisma: Pick<PrismaClient, "$transaction">,
  {
    primaryShopId,
    exceptShopId,
    shopId,
    syncedBefore,
    observedAt = new Date(),
    hooks = DEFAULT_HOOKS,
  }: {
    primaryShopId: number;
    exceptShopId?: number;
    shopId?: number;
    syncedBefore?: Date;
    observedAt?: Date;
    hooks?: SecondaryInventorySyncHooks;
  },
): Promise<number> {
  const where = {
    pancakeWarehouseId: {
      startsWith:
        shopId === undefined ? SECONDARY_WAREHOUSE_KEY_PREFIX : secondaryShopKeyPrefix(shopId),
    },
    ...(exceptShopId === undefined
      ? {}
      : { NOT: { pancakeWarehouseId: { startsWith: secondaryShopKeyPrefix(exceptShopId) } } }),
    ...(syncedBefore === undefined ? {} : { syncedAt: { lt: syncedBefore } }),
  };

  return prisma.$transaction(
    async (tx) => {
      await hooks.acquireLock(tx, primaryShopId);
      const affected = await tx.warehouseStock.findMany({
        where,
        select: { variantId: true },
        distinct: ["variantId"],
        orderBy: { variantId: "asc" },
      });
      const variantIds = affected.map(({ variantId }) => variantId);
      if (variantIds.length === 0) return 0;

      await hooks.lockVariants(tx, variantIds);
      const result = await tx.warehouseStock.deleteMany({ where: { ...where, variantId: { in: variantIds } } });
      await hooks.observeAvailability(tx, { shopId: primaryShopId, variantIds, observedAt });
      return result.count;
    },
    { timeout: CATALOG_SYNC_LOCK_WAITER_TIMEOUT_MS },
  );
}
