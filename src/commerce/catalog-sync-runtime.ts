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
  configureSecondaryShop,
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

  // Before the primary read, and whatever it turns out to do: what the configuration says about the
  // secondary shop (off, or another shop) is applied from the database alone. A primary outage must
  // not leave a switched-off or replaced shop's stock counting on the storefront; the primary error
  // below still propagates so the loop retries it.
  await reconcileSecondaryConfiguration(config, clock);

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
 * Applies the configured secondary shop (or its absence) to the database: stores which shop is
 * configured, removes the stock of any other, and drops this shop's stock once its sync has been
 * failing for too long. Needs the database only, never the network.
 *
 * Never throws: it is housekeeping and must not stand in the way of the catalog sync.
 */
async function reconcileSecondaryConfiguration(
  config: ReturnType<typeof readPancakeConfig>,
  clock?: () => Date,
): Promise<void> {
  try {
    const observedAt = clock ? clock() : new Date();
    const { removed } = await configureSecondaryShop(prisma, {
      primaryShopId: config.shopId,
      secondaryShopId: config.secondaryShop?.shopId ?? null,
      observedAt,
    });
    if (removed > 0) {
      console.warn(`Removed ${removed} secondary warehouse stock row(s) that do not belong to the configured secondary shop`);
    }

    if (config.secondaryShop) {
      const maxAgeMs =
        SECONDARY_STOCK_MAX_AGE_INTERVALS *
        parseCatalogSyncIntervalSeconds(process.env.CATALOG_SYNC_INTERVAL_SECONDS) *
        1000;
      const removedStale = await purgeSecondaryWarehouseStock(prisma, {
        primaryShopId: config.shopId,
        shopId: config.secondaryShop.shopId,
        syncedBefore: new Date(observedAt.getTime() - maxAgeMs),
        observedAt,
      });
      if (removedStale > 0) {
        console.error(`Dropped ${removedStale} stale secondary warehouse stock row(s): secondary sync is failing`);
      }
    }
  } catch {
    console.error("Secondary Pancake shop configuration maintenance failed");
  }
}

/**
 * Reads the secondary shop's stock into the mirror. Never throws: the secondary shop only
 * contributes stock, so its failure must not fail the primary catalog sync that already committed.
 */
async function refreshSecondaryInventory(
  config: ReturnType<typeof readPancakeConfig>,
  clock?: () => Date,
): Promise<void> {
  if (!config.secondaryShop) return;
  const { shopId, apiKey } = config.secondaryShop;
  try {
    // Before the first catalog sync there was no state row to store the configured shop in; now
    // there is. A no-op on every later cycle.
    await configureSecondaryShop(prisma, {
      primaryShopId: config.shopId,
      secondaryShopId: shopId,
      observedAt: clock ? clock() : new Date(),
    });
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
