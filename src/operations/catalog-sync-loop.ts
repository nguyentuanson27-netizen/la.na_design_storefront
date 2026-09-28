/**
 * The scheduled Pancake catalog sync.
 *
 * A `COMMITTED` capacity reservation stops holding only once a stock observation that *began* after
 * the commit has landed in the mirror (ADR 0014 §4.1), and only a catalog sync makes such an
 * observation and records the handoff (`handOffMirroredCapacity()`). Without a recurring sync, every sale would stay locally
 * held and sellable capacity could only fall, and a restock in Pancake would never reach the
 * storefront. This loop is that recurrence.
 *
 * Deliberately a plain loop inside one long-running container rather than a host timer: it ships
 * with the release, is stopped with the app before migrations, and needs nothing on the VPS beyond
 * what `deploy.sh` already manages.
 */

export const DEFAULT_CATALOG_SYNC_INTERVAL_SECONDS = 300;
const MIN_CATALOG_SYNC_INTERVAL_SECONDS = 60;
const MAX_CATALOG_SYNC_INTERVAL_SECONDS = 24 * 60 * 60;

/** Reads the interval, refusing values that would hammer Pancake or silently stop syncing. */
export function parseCatalogSyncIntervalSeconds(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_CATALOG_SYNC_INTERVAL_SECONDS;
  if (!/^[1-9][0-9]*$/.test(raw.trim())) {
    throw new RangeError("CATALOG_SYNC_INTERVAL_SECONDS must be a positive whole number of seconds");
  }
  const seconds = Number(raw.trim());
  if (seconds < MIN_CATALOG_SYNC_INTERVAL_SECONDS || seconds > MAX_CATALOG_SYNC_INTERVAL_SECONDS) {
    throw new RangeError(
      `CATALOG_SYNC_INTERVAL_SECONDS must be between ${MIN_CATALOG_SYNC_INTERVAL_SECONDS} and ${MAX_CATALOG_SYNC_INTERVAL_SECONDS}`,
    );
  }
  return seconds;
}

export type CatalogSyncLoopOptions = Readonly<{
  sync: () => Promise<
    Readonly<{
      products: number;
      variations: number;
      capacityHandedOff?: number;
      compositeQuarantined?: number;
    }>
  >;
  intervalMs: number;
  /** Resolves after `ms`, or early when `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  log: (line: string) => void;
  /** Called after every successful sync, with the instant it finished: the liveness heartbeat. */
  onSuccess?: (at: Date) => void;
  now?: () => Date;
}>;

/**
 * Runs `sync` immediately, then once per interval until `signal` aborts.
 *
 * A failed run is logged and retried on the next tick rather than ending the loop: one Pancake
 * outage must not stop every later sync. Only a fixed message is logged, never the error itself,
 * because a Pancake failure can carry payload or credential context.
 */
export async function runCatalogSyncLoop(options: CatalogSyncLoopOptions): Promise<{ runs: number; failures: number }> {
  const now = options.now ?? (() => new Date());
  let runs = 0;
  let failures = 0;
  while (!options.signal.aborted) {
    runs += 1;
    try {
      const result = await options.sync();
      const finishedAt = now();
      // The handoff count is the audit trail of capacity leaving the local ledger (ADR 0014 §4.1).
      const handedOff =
        result.capacityHandedOff === undefined
          ? ""
          : `, ${result.capacityHandedOff} capacity holds handed to the mirror`;
      // A quarantined combo is hidden from the storefront until Pancake reports it complete again,
      // so an operator needs to see that it happened.
      const quarantined = result.compositeQuarantined
        ? `, ${result.compositeQuarantined} incomplete combos quarantined`
        : "";
      options.log(
        `${finishedAt.toISOString()} catalog sync ok: ${result.products} products, ${result.variations} variations${handedOff}${quarantined}`,
      );
      // Outside the sync's own failure handling on purpose: a heartbeat that cannot be written must
      // not turn a good sync into a counted failure, and the health check will report it as stale.
      try {
        options.onSuccess?.(finishedAt);
      } catch {
        options.log(`${finishedAt.toISOString()} catalog sync heartbeat could not be written`);
      }
    } catch {
      failures += 1;
      options.log(`${now().toISOString()} catalog sync failed; retrying next interval`);
    }
    if (options.signal.aborted) break;
    await options.sleep(options.intervalMs, options.signal);
  }
  return { runs, failures };
}

/** Where the loop records its last successful sync, and where the health check reads it. */
export const DEFAULT_CATALOG_SYNC_HEARTBEAT_FILE = "/tmp/catalog-sync-last-success";

export type CatalogSyncHealth =
  | { healthy: true; lastSuccessAt: Date; ageSeconds: number }
  | { healthy: false; reason: "NEVER_SUCCEEDED" | "HEARTBEAT_UNREADABLE" | "STALE"; ageSeconds: number | null };

/**
 * Whether the loop has recently proven it works, from its heartbeat alone.
 *
 * A running process is not evidence: the loop deliberately survives failures, so only a recent
 * successful sync counts. Stale means no success within two intervals plus two minutes -- one missed
 * run is tolerated (a Pancake blip, a sync that ran long), a second is reported.
 */
export function evaluateCatalogSyncHeartbeat({
  heartbeat,
  now,
  intervalSeconds,
}: Readonly<{ heartbeat: string | null; now: Date; intervalSeconds: number }>): CatalogSyncHealth {
  if (heartbeat === null) return { healthy: false, reason: "NEVER_SUCCEEDED", ageSeconds: null };
  const lastSuccessAt = new Date(heartbeat.trim());
  if (Number.isNaN(lastSuccessAt.getTime())) {
    return { healthy: false, reason: "HEARTBEAT_UNREADABLE", ageSeconds: null };
  }
  const ageSeconds = Math.max(0, Math.floor((now.getTime() - lastSuccessAt.getTime()) / 1000));
  if (ageSeconds > 2 * intervalSeconds + 120) return { healthy: false, reason: "STALE", ageSeconds };
  return { healthy: true, lastSuccessAt, ageSeconds };
}
