import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import {
  DEFAULT_CATALOG_SYNC_HEARTBEAT_FILE,
  parseCatalogSyncIntervalSeconds,
  runCatalogSyncLoop,
} from "../src/operations/catalog-sync-loop.ts";

/**
 * `pnpm pancake:catalog:sync` runs one catalog sync; `--loop` keeps running one per
 * `CATALOG_SYNC_INTERVAL_SECONDS` (default 300) until SIGTERM/SIGINT, which is how the
 * `catalog-sync` Compose service runs it. Output is fixed text only: counts on success, a generic
 * line on failure, never a Pancake payload or credential. In loop mode every success also refreshes
 * the heartbeat file that `scripts/catalog-sync-health.ts` checks.
 */
async function main(): Promise<void> {
  const loop = process.argv.includes("--loop");
  const intervalSeconds = parseCatalogSyncIntervalSeconds(process.env.CATALOG_SYNC_INTERVAL_SECONDS);
  const [{ syncConfiguredPancakeCatalog }, { prisma }] = await Promise.all([
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
    await runCatalogSyncLoop({
      sync: syncConfiguredPancakeCatalog,
      intervalMs: intervalSeconds * 1000,
      sleep: (ms, signal) => delay(ms, undefined, { signal }).catch(() => undefined),
      signal: controller.signal,
      log: (line) => console.log(line),
      // Read by scripts/catalog-sync-health.ts, the container health check.
      onSuccess: (at) =>
        writeFileSync(
          process.env.CATALOG_SYNC_HEARTBEAT_FILE ?? DEFAULT_CATALOG_SYNC_HEARTBEAT_FILE,
          at.toISOString(),
        ),
    });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(() => {
  console.error("Catalog sync could not start; check CATALOG_SYNC_INTERVAL_SECONDS and Pancake configuration");
  process.exitCode = 1;
});
