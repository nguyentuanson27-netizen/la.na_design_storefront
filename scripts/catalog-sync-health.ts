import { readFileSync } from "node:fs";

import {
  DEFAULT_CATALOG_SYNC_HEARTBEAT_FILE,
  evaluateCatalogSyncHeartbeat,
  parseCatalogSyncIntervalSeconds,
} from "../src/operations/catalog-sync-loop.ts";

/**
 * The `catalog-sync` container health check. Exits 0 only when the loop recorded a successful sync
 * recently enough; a process that is merely running, but whose every sync fails, is unhealthy.
 */
function readHeartbeat(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

try {
  const health = evaluateCatalogSyncHeartbeat({
    heartbeat: readHeartbeat(process.env.CATALOG_SYNC_HEARTBEAT_FILE ?? DEFAULT_CATALOG_SYNC_HEARTBEAT_FILE),
    now: new Date(),
    intervalSeconds: parseCatalogSyncIntervalSeconds(process.env.CATALOG_SYNC_INTERVAL_SECONDS),
  });
  if (health.healthy) {
    console.log(`catalog sync healthy: last success ${health.ageSeconds}s ago`);
  } else {
    console.log(`catalog sync unhealthy: ${health.reason}${health.ageSeconds === null ? "" : ` (${health.ageSeconds}s)`}`);
    process.exitCode = 1;
  }
} catch {
  console.log("catalog sync unhealthy: invalid CATALOG_SYNC_INTERVAL_SECONDS");
  process.exitCode = 1;
}
