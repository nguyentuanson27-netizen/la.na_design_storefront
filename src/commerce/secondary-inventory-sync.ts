import { Prisma, type PrismaClient } from "../generated/prisma/client.ts";
import { fetchAllPancakeCatalogVariations } from "../integrations/pancake/catalog-pages.ts";
import type { PancakeCatalogWarehouseStock } from "../integrations/pancake/catalog-contract.ts";
import { normalizeSku } from "../integrations/pancake/sku.ts";
import {
  observeStoredStockAvailability,
  writeObservedWarehouseStocks,
} from "./catalog-mirror-repository.ts";
import { findAmbiguousPrimarySkus } from "./secondary-sku-guard.ts";
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
  /** The variants' CURRENT SKU and presence, read while holding the lock. */
  readMapping(
    tx: SyncTransaction,
    variantIds: readonly string[],
  ): Promise<ReadonlyArray<{ id: string; pancakeDisplayId: string | null; isPresent: boolean }>>;
  /**
   * The secondary shop the deployment is configured with, as stored under the shop's catalog-sync
   * lock; `present: false` when the shop has no catalog state yet (nothing has been synced).
   */
  readActiveShop(
    tx: SyncTransaction,
    shopId: number,
  ): Promise<Readonly<{ present: boolean; shopId: number | null }>>;
  setActiveShop(tx: SyncTransaction, shopId: number, activeShopId: number | null): Promise<void>;
  /** Of the normalized SKUs, those more than one present primary variant carries (read under the lock). */
  findAmbiguousSkus(
    tx: SyncTransaction,
    primaryShopId: number,
    skus: readonly string[],
  ): Promise<ReadonlySet<string>>;
  observeAvailability(
    tx: SyncTransaction,
    input: { shopId: number; variantIds: readonly string[]; observedAt: Date },
  ): Promise<void>;
};

const DEFAULT_HOOKS: SecondaryInventorySyncHooks = {
  acquireLock: acquireCatalogSyncLock,
  lockVariants: lockVariantMirrorRows,
  readMapping: (tx, variantIds) =>
    tx.variantMirror.findMany({
      where: { id: { in: [...variantIds] } },
      select: { id: true, pancakeDisplayId: true, isPresent: true },
      orderBy: { id: "asc" },
    }),
  findAmbiguousSkus: (tx, primaryShopId, skus) => findAmbiguousPrimarySkus(tx, primaryShopId, skus),
  async readActiveShop(tx, shopId) {
    const row = await tx.catalogSyncState.findUnique({
      where: { pancakeShopId: shopId },
      select: { secondaryShopId: true },
    });
    return { present: row !== null, shopId: row?.secondaryShopId ?? null };
  },
  async setActiveShop(tx, shopId, activeShopId) {
    await tx.catalogSyncState.updateMany({
      where: { pancakeShopId: shopId },
      data: { secondaryShopId: activeShopId },
    });
  },
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
  /** True when the configured secondary shop is no longer this one: the sync wrote nothing. */
  discarded: boolean;
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

  // A variation listed twice (a paginated walk can repeat a row) would have its stock added twice.
  // The live checkout lookup refuses this too; here the whole snapshot is refused, so nothing is
  // written from a walk that cannot be trusted.
  const seenVariationIds = new Set<string>();
  for (const { id } of secondaryVariations) {
    if (seenVariationIds.has(id)) {
      throw new Error("Secondary Pancake catalog repeats a variation id");
    }
    seenVariationIds.add(id);
  }

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

  // Which variants to visit: those with a SKU, and those still carrying this shop's rows (a variant
  // that lost its SKU must have them cleared). This is only a candidate list. What each variant's
  // SKU IS, and which SKUs are shared, is read again inside the lock, per chunk, below.
  const candidates = await prisma.variantMirror.findMany({
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
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const candidateIds = candidates.map(({ id }) => id);

  let discarded = false;
  let matchedCount = 0;
  let totalStockAggregated = 0;
  const seenWarehouseIds = new Set<string>();
  const primarySkus = new Set<string>();
  const ambiguousSkus = new Set<string>();

  // Availability cycles are dated by the day the stock was observed, which for a figure read from
  // Pancake is after the read finished (the primary sync does the same).
  const availabilityObservedAt = clock();
  for (let i = 0; i < candidateIds.length; i += CHUNK_SIZE) {
    const chunkIds = candidateIds.slice(i, i + CHUNK_SIZE);
    await prisma.$transaction(
      async (tx) => {
        // The shop's catalog-sync lock serializes this with the primary sync and the admin policy
        // writes that decide a preorder variant's availability cycle.
        await hooks.acquireLock(tx, primaryShopId);
        // Under the lock, the shop the deployment is configured with must be this one. A worker
        // started under an earlier configuration (feature off, shop replaced) finds another value
        // here and writes nothing, whether or not it had anything stored and whenever it began.
        const active = await hooks.readActiveShop(tx, primaryShopId);
        if (active.shopId !== secondaryShopId) {
          discarded = true;
          return;
        }
        // The rows `reserveOrderCapacity()` locks before it reads stock, in the same order, so a
        // reservation never commits on a figure this chunk is replacing.
        await hooks.lockVariants(tx, chunkIds);

        // Only now, holding the lock, is the SKU-to-variant mapping decided: a primary sync that
        // committed between the candidate read and this lock may have renamed a variant or made its
        // SKU shared, and stock attributed to the old mapping must not be written.
        const current = await hooks.readMapping(tx, chunkIds);
        const currentSkus = [
          ...new Set(
            current.flatMap(({ pancakeDisplayId, isPresent }) =>
              isPresent ? (normalizeSku(pancakeDisplayId) ?? []) : [],
            ),
          ),
        ];
        const ambiguousHere = await hooks.findAmbiguousSkus(tx, primaryShopId, currentSkus);

        for (const variant of current) {
          const sku = normalizeSku(variant.pancakeDisplayId);
          if (sku) primarySkus.add(sku);
          const byWarehouse = sku ? secondaryBySku.get(sku) : undefined;
          const ambiguous = sku !== null && variant.isPresent && ambiguousHere.has(sku);
          if (ambiguous && sku) ambiguousSkus.add(sku);

          // Empty stocks clear whatever this shop contributed before: an unmatched, retired,
          // SKU-less or ambiguous variant must not keep a stale figure.
          const stocks =
            sku && byWarehouse && variant.isPresent && !ambiguous
              ? [...byWarehouse].map(([warehouseId, remainQuantity]) => ({ warehouseId, remainQuantity }))
              : [];
          if (stocks.length > 0) {
            matchedCount += 1;
            for (const { warehouseId, remainQuantity } of stocks) {
              totalStockAggregated += remainQuantity;
              seenWarehouseIds.add(warehouseId);
            }
          }
          await writeObservedWarehouseStocks(tx, variant.id, stocks, observedAt, {
            kind: "secondary",
            shopId: secondaryShopId,
            sku: stocks.length > 0 ? sku : null,
          });
        }
        // Candidates that no longer exist have nothing to write; the rest are re-observed below.
        await hooks.observeAvailability(tx, {
          shopId: primaryShopId,
          variantIds: current.map(({ id }) => id),
          observedAt: availabilityObservedAt,
        });
      },
      { timeout: CATALOG_SYNC_LOCK_WAITER_TIMEOUT_MS },
    );
  }

  let unmatchedCount = 0;
  for (const sku of secondaryBySku.keys()) {
    if (!primarySkus.has(sku)) unmatchedCount += 1;
  }
  if (discarded) {
    warn("Secondary Pancake inventory sync discarded: this is no longer the configured secondary shop");
  }
  if (ambiguousSkus.size > 0) {
    warn(
      `Secondary Pancake inventory sync skipped ${ambiguousSkus.size} SKU(s) shared by several primary variants`,
    );
  }

  return {
    secondaryShopId,
    totalSecondaryVariations: secondaryVariations.length,
    matchedCount,
    unmatchedCount,
    ambiguousCount: ambiguousSkus.size,
    discarded,
    totalStockAggregated,
    warehouseCount: seenWarehouseIds.size,
  };
}

/**
 * The configured secondary shop could not be applied to the database (the transaction failed or timed
 * out). Until it is, stock of a shop the deployment no longer uses may still be counting, so a sync
 * cycle that ends with this outstanding must not be reported healthy.
 */
export class SecondaryConfigurationError extends Error {
  constructor() {
    super("The configured secondary Pancake shop could not be applied");
    this.name = "SecondaryConfigurationError";
  }
}

type PurgeOptions = {
  primaryShopId: number;
  exceptShopId?: number;
  shopId?: number;
  syncedBefore?: Date;
  observedAt?: Date;
  hooks?: SecondaryInventorySyncHooks;
};

/**
 * The body of a purge, for a caller that already holds the shop's catalog-sync lock inside its own
 * transaction: select the variants holding rows to remove, lock them, remove the rows, and observe
 * those variants' (and their combos') availability again. See `purgeSecondaryWarehouseStock`.
 */
async function purgeWithinTransaction(
  tx: SyncTransaction,
  { primaryShopId, exceptShopId, shopId, syncedBefore, observedAt = new Date(), hooks = DEFAULT_HOOKS }: PurgeOptions,
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
 * - `exceptShopId`: keep that shop's rows, remove every other secondary shop's.
 * - `shopId` + `syncedBefore`: remove that shop's rows last written before the instant (its sync
 *   has been failing).
 * - neither: remove every secondary row.
 */
export async function purgeSecondaryWarehouseStock(
  prisma: Pick<PrismaClient, "$transaction">,
  options: PurgeOptions,
): Promise<number> {
  const hooks = options.hooks ?? DEFAULT_HOOKS;
  return prisma.$transaction(
    async (tx) => {
      await hooks.acquireLock(tx, options.primaryShopId);
      return purgeWithinTransaction(tx, options);
    },
    { timeout: CATALOG_SYNC_LOCK_WAITER_TIMEOUT_MS },
  );
}

/**
 * Makes `secondaryShopId` (null: none) the secondary shop the deployment is configured with, and
 * removes whatever stock belongs to any other, in one transaction under the shop's catalog-sync lock.
 *
 * The stored value is what lets a worker started under an earlier configuration be refused: its
 * chunk takes the same lock and writes only while its own shop is the stored one. That holds even if
 * the earlier shop never stored anything, which is where a timestamp could not help. It depends on
 * nothing outside the database, so it can (and should) run whether or not the primary catalog read
 * succeeds. Before the first catalog sync there is no state row to store it in, and nothing to
 * remove: the call does nothing, and is repeated once the row exists.
 */
export async function configureSecondaryShop(
  prisma: Pick<PrismaClient, "$transaction">,
  {
    primaryShopId,
    secondaryShopId,
    observedAt = new Date(),
    hooks = DEFAULT_HOOKS,
  }: {
    primaryShopId: number;
    secondaryShopId: number | null;
    observedAt?: Date;
    hooks?: SecondaryInventorySyncHooks;
  },
): Promise<{ changed: boolean; removed: number }> {
  return prisma.$transaction(
    async (tx) => {
      await hooks.acquireLock(tx, primaryShopId);
      const state = await hooks.readActiveShop(tx, primaryShopId);
      if (!state.present) return { changed: false, removed: 0 };

      const changed = state.shopId !== secondaryShopId;
      if (changed) await hooks.setActiveShop(tx, primaryShopId, secondaryShopId);
      // Anything that does not belong to the configured shop goes. In a steady state this finds
      // nothing and costs one query.
      const removed = await purgeWithinTransaction(tx, {
        primaryShopId,
        ...(secondaryShopId === null ? {} : { exceptShopId: secondaryShopId }),
        observedAt,
        hooks,
      });
      return { changed, removed };
    },
    { timeout: CATALOG_SYNC_LOCK_WAITER_TIMEOUT_MS },
  );
}
