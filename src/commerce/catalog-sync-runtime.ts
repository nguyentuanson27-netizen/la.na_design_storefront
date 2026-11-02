import { auditListPrices } from "./list-price-audit.ts";
import { prisma } from "../db/prisma.ts";
import { PancakeClient } from "../integrations/pancake/client.ts";
import { readPancakeConfig } from "../integrations/pancake/config.ts";
import { fetchPancakeVariationStocks } from "../integrations/pancake/variation-stock-read.ts";
import { processInventorySignals } from "../operations/inventory-batch.ts";
import { createCatalogMirrorRepository } from "./catalog-mirror-repository.ts";
import { syncPancakeCatalog } from "./catalog-sync.ts";
import { createInventorySignalRepository } from "./pancake-inventory-signals.ts";
import {
  purgeSecondaryWarehouseStock,
  syncSecondaryShopInventory,
} from "./secondary-inventory-sync.ts";
import { parseCatalogSyncIntervalSeconds } from "../operations/catalog-sync-loop.ts";

/**
 * Secondary stock older than this many reconciliation intervals is dropped rather than trusted: the
 * sync that should have refreshed it has been failing, and a stale "in stock" is the costly error.
 */
const SECONDARY_STOCK_MAX_AGE_INTERVALS = 3;

/**
 * `clock` is forwarded rather than a timestamp: `syncPancakeCatalog()` samples it immediately before
 * the first Pancake read, which is what makes the stock-observation marker a read-start fact rather
 * than a write-time one (ADR 0014 §4.2).
 */
export async function syncConfiguredPancakeCatalog({
  clock,
}: {
  clock?: () => Date;
} = {}) {
  const config = readPancakeConfig();
  const client = new PancakeClient({ apiKey: config.apiKey });
  const repository = createCatalogMirrorRepository(prisma);

  const result = await syncPancakeCatalog({
    client,
    repository,
    shopId: config.shopId,
    ...(clock ? { clock } : {}),
  });

  await refreshSecondaryInventory(config, clock);

  try {
    await auditListPrices({ client: prisma, shopId: config.shopId, now: new Date() });
  } catch {
    // Durable retry; the completed catalog transaction stays successful.
  }
  return result;
}

/**
 * Never throws: the secondary shop only contributes stock, so its failure must not fail the primary
 * catalog sync that already committed.
 */
async function refreshSecondaryInventory(
  config: ReturnType<typeof readPancakeConfig>,
  clock?: () => Date,
): Promise<void> {
  try {
    if (!config.secondaryShop) {
      // Feature switched off: nothing will refresh these rows again, so they must not linger.
      const removed = await purgeSecondaryWarehouseStock(prisma, { primaryShopId: config.shopId });
      if (removed > 0) console.warn(`Removed ${removed} secondary warehouse stock row(s): feature is disabled`);
      return;
    }

    const { shopId, apiKey } = config.secondaryShop;
    const removedOtherShops = await purgeSecondaryWarehouseStock(prisma, { primaryShopId: config.shopId, exceptShopId: shopId });
    if (removedOtherShops > 0) {
      console.warn(`Removed ${removedOtherShops} warehouse stock row(s) of a previously configured secondary shop`);
    }

    try {
      await syncSecondaryShopInventory({
        primaryShopId: config.shopId,
        secondaryShopId: shopId,
        secondaryClient: new PancakeClient({ apiKey }),
        prisma,
        ...(clock ? { clock } : {}),
      });
    } catch {
      // Fixed text only, like the rest of the sync: never a Pancake payload or credential.
      console.error("Secondary Pancake shop inventory sync failed");
    }

    const maxAgeMs =
      SECONDARY_STOCK_MAX_AGE_INTERVALS *
      parseCatalogSyncIntervalSeconds(process.env.CATALOG_SYNC_INTERVAL_SECONDS) *
      1000;
    const removedStale = await purgeSecondaryWarehouseStock(prisma, {
      primaryShopId: config.shopId,
      shopId,
      syncedBefore: new Date((clock ? clock() : new Date()).getTime() - maxAgeMs),
    });
    if (removedStale > 0) {
      console.error(`Dropped ${removedStale} stale secondary warehouse stock row(s): secondary sync is failing`);
    }
  } catch {
    console.error("Secondary Pancake shop inventory maintenance failed");
  }
}

/** One 30-second targeted inventory batch against the configured Pancake shop. */
export async function processConfiguredInventorySignals() {
  const config = readPancakeConfig();
  const client = new PancakeClient({ apiKey: config.apiKey });
  const repository = createCatalogMirrorRepository(prisma);

  try {
    await auditListPrices({ client: prisma, shopId: config.shopId, now: new Date() });
  } catch {
    // Retry in the next batch; audit never blocks inventory.
  }

  return processInventorySignals({
    shopId: config.shopId,
    signals: createInventorySignalRepository(prisma),
    readVariations: (variationIds) =>
      fetchPancakeVariationStocks({ client, shopId: config.shopId, variationIds }),
    applyVariationStocks: (input) => repository.applyVariationStocks(input),
  });
}
