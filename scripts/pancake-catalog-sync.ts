import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import {
  DEFAULT_CATALOG_SYNC_HEARTBEAT_FILE,
  parseCatalogSyncIntervalSeconds,
  runCatalogSyncLoop,
} from "../src/operations/catalog-sync-loop.ts";
import { runInventoryBatchLoop } from "../src/operations/inventory-batch.ts";

/**
 * `pnpm pancake:catalog:sync` runs one full catalog reconciliation; `--loop` is how the
 * `catalog-sync` Compose service runs until SIGTERM/SIGINT, with two loops in one process:
 *
 * - the full reconciliation, immediately and then every `CATALOG_SYNC_INTERVAL_SECONDS` (default
 *   3600) — the safety net that converges the mirror after lost webhooks or downtime; each success
 *   refreshes the heartbeat file `scripts/catalog-sync-health.ts` checks;
 * - the targeted inventory batch every 30 seconds, applying the variations Pancake
 *   `variations_warehouses` webhooks flagged (`src/operations/inventory-batch.ts`).
 *
 * Both write under the shop's catalog-sync lock, so they never interleave. Output is fixed text
 * only: counts on success, a generic line on failure, never a Pancake payload or credential.
 */
async function main(): Promise<void> {
  const loop = process.argv.includes("--loop");
  const intervalSeconds = parseCatalogSyncIntervalSeconds(process.env.CATALOG_SYNC_INTERVAL_SECONDS);
  const [{ syncConfiguredPancakeCatalog, processConfiguredInventorySignals }, { prisma }] = await Promise.all([
    import("../src/commerce/catalog-sync-runtime.ts"),
    import("../src/db/prisma.ts"),
  ]);

  try {
    if (!loop) {
      try {
        const result = await syncConfiguredPancakeCatalog();
        console.log(
          `catalog sync ok: ${result.products} products, ${result.variations} variations, ` +
            `${result.capacityHandedOff ?? 0} capacity holds handed to the mirror`,
        );
      } catch {
        console.error("catalog sync failed");
        process.exitCode = 1;
      }
      return;
    }

    const controller = new AbortController();
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => controller.abort());
    }
    const sleep = (ms: number, signal: AbortSignal) =>
      delay(ms, undefined, { signal }).catch(() => undefined);
    await Promise.all([
      runCatalogSyncLoop({
        sync: syncConfiguredPancakeCatalog,
        intervalMs: intervalSeconds * 1000,
        sleep,
        signal: controller.signal,
        log: (line) => console.log(line),
        // Read by scripts/catalog-sync-health.ts, the container health check.
        onSuccess: (at) =>
          writeFileSync(
            process.env.CATALOG_SYNC_HEARTBEAT_FILE ?? DEFAULT_CATALOG_SYNC_HEARTBEAT_FILE,
            at.toISOString(),
          ),
      }),
      runInventoryBatchLoop({
        process: processConfiguredInventorySignals,
        sleep,
        signal: controller.signal,
        log: (line) => console.log(line),
      }),
    ]);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(() => {
  console.error("Catalog sync could not start; check CATALOG_SYNC_INTERVAL_SECONDS and Pancake configuration");
  process.exitCode = 1;
});
