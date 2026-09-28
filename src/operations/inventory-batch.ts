/**
 * The 30-second targeted inventory batch driven by Pancake `variations_warehouses` webhooks.
 *
 * Webhooks only mark (variation, warehouse) pairs dirty (`pancake-inventory-signals.ts`). Every 30
 * seconds this batch claims the pending markers, reads the flagged variations' authoritative stock
 * from Pancake, and applies it through `applyVariationStocks()` — the same guarded write, variant
 * locks, availability observation and durable capacity handoff as the full reconciliation.
 *
 * Ordering is the whole correctness argument, and it is the §4.2 read-start rule again:
 *
 * 1. `claimedAt` is sampled, then the pending markers are read — every one received at or before it;
 * 2. `syncedAt` is sampled after that and before the first Pancake request, so every read begins
 *    after every claimed marker's delivery and therefore after the change it announced;
 * 3. a marker is cleared only if its `lastReceivedAt` is still at or before `claimedAt`; one that was
 *    redelivered meanwhile stays for the next batch.
 *
 * A failed read keeps its markers for retry (bounded); nothing here can crash the loop, and the
 * hourly full reconciliation converges anything a lost webhook or an outage left behind.
 */

import type { PancakeCatalogWarehouseStock } from "../integrations/pancake/catalog-contract.ts";
import type { PendingInventorySignal } from "../commerce/pancake-inventory-signals.ts";

export const INVENTORY_BATCH_INTERVAL_MS = 30_000;
export const INVENTORY_BATCH_LIMIT = 500;
export const INVENTORY_SIGNAL_MAX_ATTEMPTS = 5;

export type InventoryBatchDependencies = Readonly<{
  shopId: number;
  signals: Readonly<{
    listPending: (limit: number) => Promise<PendingInventorySignal[]>;
    productIdsFor: (shopId: number, variationIds: readonly string[]) => Promise<Map<string, string>>;
    resolve: (signals: readonly PendingInventorySignal[], claimedAt: Date) => Promise<number>;
    recordFailure: (
      signals: readonly PendingInventorySignal[],
      maxAttempts: number,
    ) => Promise<{ retried: number; dropped: number }>;
  }>;
  /** Authoritative stock for every variation of one Pancake product. */
  readProduct: (pancakeProductId: string) => Promise<Map<string, PancakeCatalogWarehouseStock[]>>;
  applyVariationStocks: (input: {
    shopId: number;
    observations: readonly { variationId: string; warehouseStocks: readonly PancakeCatalogWarehouseStock[] }[];
    syncedAt: Date;
    availabilityObservedAt: Date;
  }) => Promise<{ applied: number; unknown: number; superseded: number; capacityHandedOff: number }>;
  clock?: () => Date;
  maxAttempts?: number;
  limit?: number;
}>;

export type InventoryBatchResult = Readonly<{
  /** Webhook deliveries represented by the claimed markers. */
  events: number;
  /** Deliveries collapsed into an existing marker (duplicates and repeats for one pair). */
  deduplicated: number;
  signals: number;
  variations: number;
  applied: number;
  /** Variations whose stock a newer read (usually the full reconciliation) already wrote. */
  superseded: number;
  /** Variations this mirror does not know yet, or Pancake no longer lists; left to reconciliation. */
  unknown: number;
  failedReads: number;
  retried: number;
  dropped: number;
  capacityHandedOff: number;
}>;

const EMPTY: InventoryBatchResult = {
  events: 0,
  deduplicated: 0,
  signals: 0,
  variations: 0,
  applied: 0,
  superseded: 0,
  unknown: 0,
  failedReads: 0,
  retried: 0,
  dropped: 0,
  capacityHandedOff: 0,
};

export async function processInventorySignals({
  shopId,
  signals: store,
  readProduct,
  applyVariationStocks,
  clock = () => new Date(),
  maxAttempts = INVENTORY_SIGNAL_MAX_ATTEMPTS,
  limit = INVENTORY_BATCH_LIMIT,
}: InventoryBatchDependencies): Promise<InventoryBatchResult> {
  const claimedAt = clock();
  const pending = await store.listPending(limit);
  if (pending.length === 0) return EMPTY;

  const events = pending.reduce((total, signal) => total + signal.receivedCount, 0);
  const variationIds = [...new Set(pending.map((signal) => signal.pancakeVariationId))];
  const productByVariationId = await store.productIdsFor(shopId, variationIds);

  // Read-start marker: after the claim, before the first Pancake request (ADR 0014 §4.2).
  const syncedAt = clock();
  const failedProducts = new Set<string>();
  const stocksByVariationId = new Map<string, PancakeCatalogWarehouseStock[]>();
  for (const productId of new Set(productByVariationId.values())) {
    try {
      for (const [variationId, stocks] of await readProduct(productId)) {
        stocksByVariationId.set(variationId, stocks);
      }
    } catch {
      failedProducts.add(productId);
    }
  }
  const availabilityObservedAt = clock();

  const observations = variationIds.flatMap((variationId) => {
    const stocks = stocksByVariationId.get(variationId);
    return stocks === undefined ? [] : [{ variationId, warehouseStocks: stocks }];
  });
  const failed = (signal: PendingInventorySignal) => {
    const productId = productByVariationId.get(signal.pancakeVariationId);
    return productId !== undefined && failedProducts.has(productId);
  };

  let applyResult = { applied: 0, unknown: 0, superseded: 0, capacityHandedOff: 0 };
  let applyFailed = false;
  if (observations.length > 0) {
    try {
      applyResult = await applyVariationStocks({ shopId, observations, syncedAt, availabilityObservedAt });
    } catch {
      applyFailed = true;
    }
  }

  // A failed read or write keeps its markers; everything else — written, superseded by a newer
  // read, unknown to this mirror, or no longer listed by Pancake — is covered and cleared.
  const toRetry = pending.filter((signal) => applyFailed || failed(signal));
  const covered = pending.filter((signal) => !applyFailed && !failed(signal));
  await store.resolve(covered, claimedAt);
  const { retried, dropped } = await store.recordFailure(toRetry, maxAttempts);

  const unknownToMirror = variationIds.filter((id) => !productByVariationId.has(id)).length;
  const notListedByPancake = variationIds.filter((id) => {
    const productId = productByVariationId.get(id);
    return productId !== undefined && !failedProducts.has(productId) && !stocksByVariationId.has(id);
  }).length;
  return {
    events,
    deduplicated: events - pending.length,
    signals: pending.length,
    variations: variationIds.length,
    applied: applyResult.applied,
    superseded: applyResult.superseded,
    unknown: unknownToMirror + notListedByPancake + applyResult.unknown,
    failedReads: failedProducts.size + (applyFailed ? 1 : 0),
    retried,
    dropped,
    capacityHandedOff: applyResult.capacityHandedOff,
  };
}

export type InventoryBatchLoopOptions = Readonly<{
  process: () => Promise<InventoryBatchResult>;
  intervalMs?: number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  log: (line: string) => void;
  now?: () => Date;
}>;

export function formatInventoryBatch(at: Date, result: InventoryBatchResult): string {
  return (
    `${at.toISOString()} inventory batch: ${result.events} webhook events ` +
    `(${result.deduplicated} deduplicated), ${result.variations} variations, ${result.applied} applied, ` +
    `${result.superseded} superseded, ${result.unknown} unknown, ${result.failedReads} failed reads ` +
    `(${result.retried} retried, ${result.dropped} dropped), ` +
    `${result.capacityHandedOff} capacity holds handed to the mirror`
  );
}

/**
 * Runs a batch every 30 seconds until stopped. An empty batch logs nothing; a batch that throws is
 * one fixed line and the loop carries on — one bad payload or Pancake outage never stops it.
 */
export async function runInventoryBatchLoop(options: InventoryBatchLoopOptions): Promise<{ batches: number; failures: number }> {
  const now = options.now ?? (() => new Date());
  let batches = 0;
  let failures = 0;
  while (!options.signal.aborted) {
    await options.sleep(options.intervalMs ?? INVENTORY_BATCH_INTERVAL_MS, options.signal);
    if (options.signal.aborted) break;
    batches += 1;
    try {
      const result = await options.process();
      if (result.signals > 0) options.log(formatInventoryBatch(now(), result));
    } catch {
      failures += 1;
      options.log(`${now().toISOString()} inventory batch failed; markers kept for the next batch`);
    }
  }
  return { batches, failures };
}
