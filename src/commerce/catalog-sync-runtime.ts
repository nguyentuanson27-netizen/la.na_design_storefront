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
  SecondaryConfigurationError,
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
  seams = {},
}: {
  clock?: () => Date;
  /** Test seams for the two steps whose failure the cycle must tell apart. */
  seams?: Readonly<{
    syncCatalog?: typeof syncPancakeCatalog;
    configureSecondary?: typeof configureSecondaryShop;
    withdrawSecondary?: typeof purgeSecondaryWarehouseStock;
  }>;
} = {}) {
  const config = readPancakeConfig();
  const client = new PancakeClient({ apiKey: config.apiKey });
  const repository = createCatalogMirrorRepository(prisma);
  const syncCatalog = seams.syncCatalog ?? syncPancakeCatalog;
  const configureSecondary = seams.configureSecondary ?? configureSecondaryShop;
  const withdrawSecondary = seams.withdrawSecondary ?? purgeSecondaryWarehouseStock;

  // Before the primary read, and whatever it turns out to do: what the configuration says about the
  // secondary shop (off, or another shop) is applied from the database alone. A primary outage must
  // not leave a switched-off or replaced shop's stock counting on the storefront; the primary error
  // below still propagates so the loop retries it.
  //
  // If applying it fails, nothing is known about which shop's rows may count, so ALL secondary
  // stock is withdrawn before anything is served on it (a separate, plain purge: it does not depend
  // on the step that just failed), and the storefront falls back to primary stock alone -- the safe
  // direction, as the checkout's live read still adds what the secondary shop really has. The primary
  // sync still runs (the catalog must not go stale for that), and the cycle ends in an error so the
  // loop retries the whole configuration. Only if the withdrawal fails too can old rows keep
  // counting; the cycle is an error then as well, and the next one tries both again.
  let configurationApplied = true;
  try {
    await applySecondaryConfiguration(config, configureSecondary, clock);
  } catch {
    configurationApplied = false;
    console.error("Secondary Pancake shop configuration could not be applied; this sync cycle will be reported as failed");
    await withdrawAllSecondaryStock(config, withdrawSecondary, clock);
  }
  await dropStaleSecondaryStock(config, clock);

  const result = await syncCatalog({
    client,
    repository,
    shopId: config.shopId,
    ...(clock ? { clock } : {}),
  });

  // Reading the secondary shop's stock is only meaningful once the configuration is in force.
  if (configurationApplied) await refreshSecondaryInventory(config, configureSecondary, clock);

  try {
    await auditListPrices({ client: prisma, shopId: config.shopId, now: new Date() });
  } catch {
    // Durable retry; the completed catalog transaction stays successful.
  }
  if (!configurationApplied) throw new SecondaryConfigurationError();
  return result;
}

/**
 * Applies the configured secondary shop (or its absence) to the database: stores which shop is
 * configured and removes the stock of any other. Needs the database only, never the network.
 *
 * Throws on failure: a configuration that could not be applied must not pass for applied.
 */
async function applySecondaryConfiguration(
  config: ReturnType<typeof readPancakeConfig>,
  configureSecondary: typeof configureSecondaryShop,
  clock?: () => Date,
): Promise<void> {
  const { removed } = await configureSecondary(prisma, {
    primaryShopId: config.shopId,
    secondaryShopId: config.secondaryShop?.shopId ?? null,
    observedAt: clock ? clock() : new Date(),
  });
  if (removed > 0) {
    console.warn(`Removed ${removed} secondary warehouse stock row(s) that do not belong to the configured secondary shop`);
  }
}

/**
 * Removes every secondary row, whatever shop it belongs to. Used when the configuration could not be
 * applied, so which rows belong to the deployment is unknown. Never throws: the cycle is already
 * ending in an error.
 */
async function withdrawAllSecondaryStock(
  config: ReturnType<typeof readPancakeConfig>,
  withdraw: typeof purgeSecondaryWarehouseStock,
  clock?: () => Date,
): Promise<void> {
  try {
    const removed = await withdraw(prisma, {
      primaryShopId: config.shopId,
      observedAt: clock ? clock() : new Date(),
    });
    if (removed > 0) console.warn(`Withdrew ${removed} secondary warehouse stock row(s) until the configuration can be applied`);
  } catch {
    console.error("Secondary warehouse stock could not be withdrawn; it may still be counting");
  }
}

/**
 * Drops this shop's stock once its sync has been failing for too long. Best-effort and never
 * throws: unlike the configuration it only limits how stale a figure can get.
 */
async function dropStaleSecondaryStock(
  config: ReturnType<typeof readPancakeConfig>,
  clock?: () => Date,
): Promise<void> {
  if (!config.secondaryShop) return;
  try {
    const now = clock ? clock() : new Date();
    const maxAgeMs =
      SECONDARY_STOCK_MAX_AGE_INTERVALS *
      parseCatalogSyncIntervalSeconds(process.env.CATALOG_SYNC_INTERVAL_SECONDS) *
      1000;
    const removedStale = await purgeSecondaryWarehouseStock(prisma, {
      primaryShopId: config.shopId,
      shopId: config.secondaryShop.shopId,
      syncedBefore: new Date(now.getTime() - maxAgeMs),
      observedAt: now,
    });
    if (removedStale > 0) {
      console.error(`Dropped ${removedStale} stale secondary warehouse stock row(s): secondary sync is failing`);
    }
  } catch {
    console.error("Stale secondary stock could not be dropped");
  }
}

/**
 * Reads the secondary shop's stock into the mirror. Never throws: the secondary shop only
 * contributes stock, so its failure must not fail the primary catalog sync that already committed.
 */
async function refreshSecondaryInventory(
  config: ReturnType<typeof readPancakeConfig>,
  configureSecondary: typeof configureSecondaryShop,
  clock?: () => Date,
): Promise<void> {
  if (!config.secondaryShop) return;
  const { shopId, apiKey } = config.secondaryShop;
  try {
    // Before the first catalog sync there was no state row to store the configured shop in; now
    // there is. A no-op on every later cycle.
    await configureSecondary(prisma, {
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
