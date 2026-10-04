/**
 * Bounded rate and concurrency control for the try-on endpoint (spec §9).
 *
 * In-process on purpose. Production is one app container on one VPS (ADR 0002), so a per-process
 * counter *is* the whole fleet, and it needs no Redis and no database row per attempt. If the app
 * is ever scaled past one instance this limit becomes per-instance and must be revisited — that is
 * a deployment change that should come with its own review, not a dependency added speculatively.
 *
 * Restarting the process resets the counters. That is acceptable: the limit is a cost guard, and a
 * restart is rare and operator-initiated. Nothing here stores an image, an IP or any buyer data;
 * keys are the same pseudonymous HMAC client keys the checkout limiters use.
 *
 * Three independent controls, deliberately separate:
 * - `consumeAttempt` is a per-client window, spent *before* the request body is read, so it bounds
 *   how often one client can start anything;
 * - `startUpload` is a global cap on request bodies being received and parsed at once. It is taken
 *   before the body is read and released once the photo is validated, so it bounds the memory and
 *   CPU an untrusted ~7 MB upload costs, however many clients send one together;
 * - `startGeneration` is a global in-flight cap held only around the outbound image fetch and the
 *   Vertex call, so a slow upload cannot occupy a slot and starve other shoppers of Vertex capacity.
 *
 * The numeric values below are provisional engineering defaults, not an approved quota: the spec
 * leaves the cost limits to the owner (§21), and none has been measured against live Vertex cost.
 * They are recorded as such in `tasks/storefront-virtual-try-on-todo.md`.
 */

const DEFAULT_MAX_PER_WINDOW = 6;
const DEFAULT_WINDOW_MS = 10 * 60 * 1_000;
/** Vertex VTO takes several seconds per prediction; this caps spend and memory in flight. */
const DEFAULT_MAX_CONCURRENT = 3;
/**
 * A request in the upload phase holds roughly three copies of a <= 7 MB body (the buffer, the parsed
 * multipart, the photo bytes), so this bounds that phase to the order of 100 MB. It is a resource
 * bound for the container, not a traffic or cost quota.
 */
const DEFAULT_MAX_CONCURRENT_UPLOADS = 4;
const DEFAULT_MAX_TRACKED_CLIENTS = 10_000;

export type TryOnRateLimiterOptions = Readonly<{
  maxPerWindow?: number;
  windowMs?: number;
  maxConcurrent?: number;
  maxConcurrentUploads?: number;
  maxTrackedClients?: number;
}>;

export type TryOnGenerationSlot =
  | Readonly<{ ok: true; release: () => void }>
  | Readonly<{ ok: false; reason: "BUSY" }>;

/** Same shape as a generation slot: an upload slot is released exactly once, however it ends. */
export type TryOnUploadSlot = TryOnGenerationSlot;

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return resolved;
}

export function createTryOnRateLimiter(options: TryOnRateLimiterOptions = {}) {
  const maxPerWindow = positiveInteger(options.maxPerWindow, DEFAULT_MAX_PER_WINDOW, "Try-on max per window");
  const windowMs = positiveInteger(options.windowMs, DEFAULT_WINDOW_MS, "Try-on window");
  const maxConcurrent = positiveInteger(options.maxConcurrent, DEFAULT_MAX_CONCURRENT, "Try-on max concurrent");
  const maxConcurrentUploads = positiveInteger(
    options.maxConcurrentUploads,
    DEFAULT_MAX_CONCURRENT_UPLOADS,
    "Try-on max concurrent uploads",
  );
  const maxTrackedClients = positiveInteger(
    options.maxTrackedClients,
    DEFAULT_MAX_TRACKED_CLIENTS,
    "Try-on max tracked clients",
  );

  const windows = new Map<string, { startedAt: number; count: number }>();
  let inFlight = 0;
  let uploading = 0;

  function purgeExpired(nowMs: number): void {
    for (const [key, entry] of windows) {
      if (nowMs - entry.startedAt >= windowMs) windows.delete(key);
    }
  }

  /** Spends one attempt. `false` means the client is over its window. */
  function consumeAttempt(clientKey: string, nowMs: number = Date.now()): boolean {
    let entry = windows.get(clientKey);
    if (entry !== undefined && nowMs - entry.startedAt >= windowMs) {
      windows.delete(clientKey);
      entry = undefined;
    }
    if (entry === undefined) {
      if (windows.size >= maxTrackedClients) purgeExpired(nowMs);
      // Still full of live clients: fail closed rather than grow without bound.
      if (windows.size >= maxTrackedClients) return false;
      entry = { startedAt: nowMs, count: 0 };
      windows.set(clientKey, entry);
    }
    if (entry.count >= maxPerWindow) return false;
    entry.count += 1;
    return true;
  }

  /** Reserves one of the global upload slots, or reports the service as busy. */
  function startUpload(): TryOnUploadSlot {
    if (uploading >= maxConcurrentUploads) return { ok: false, reason: "BUSY" };
    uploading += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        uploading -= 1;
      },
    };
  }

  /** Reserves one of the global in-flight slots, or reports the service as busy. */
  function startGeneration(): TryOnGenerationSlot {
    if (inFlight >= maxConcurrent) return { ok: false, reason: "BUSY" };
    inFlight += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        inFlight -= 1;
      },
    };
  }

  return { consumeAttempt, startUpload, startGeneration };
}
