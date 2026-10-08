/**
 * Bounded rate and concurrency control for the try-on endpoint (spec §9).
 *
 * In-process on purpose. Production is one app container on one VPS (ADR 0002), so a per-process
 * counter *is* the whole fleet, and it needs no Redis and no database row per attempt. If the app
 * is ever scaled past one instance these limits become per-instance and must be revisited — that is
 * a deployment change that should come with its own review, not a dependency added speculatively.
 *
 * Restarting the process resets the counters. That is acceptable: the limits are a cost guard, and a
 * restart is rare and operator-initiated. Nothing here stores an image, an IP or any buyer data;
 * guests are the same pseudonymous HMAC client keys the checkout limiters use, members are their
 * account id.
 *
 * Quotas — owner decision of 2026-10-04 (spec §21), recorded in the spec and the plan:
 * - guest:  1 attempt per minute, 5 in total; from the 6th, login is required;
 * - member: 2 attempts per minute, 10 per day.
 * "In total" for a guest is read as per 24 hours (a window that renews), because a lifetime count
 * would need durable per-visitor state this MVP deliberately does not keep. Every submitted attempt
 * counts, including one that later fails; a rejected attempt does not.
 *
 * Three independent controls, deliberately separate:
 * - `consumeAttempt` is the per-identity quota above, spent *before* the request body is read, so it
 *   bounds how often one guest or member can start anything;
 * - `startUpload` is a global cap on request bodies being received and parsed at once. It is taken
 *   before the body is read and released once the photo is validated, so it bounds the memory and
 *   CPU an untrusted ~7 MB upload costs, however many clients send one together;
 * - `startGeneration` is a global in-flight cap held only around the outbound image fetch and the
 *   Vertex call, so a slow upload cannot occupy a slot and starve other shoppers of Vertex capacity.
 *
 * The two concurrency caps are resource bounds for the container, not quotas, and are provisional
 * engineering defaults that no live measurement has tuned.
 */

import { TRY_ON_GUEST_QUOTA, TRY_ON_MEMBER_QUOTA } from "./try-on-policy.ts";

const MINUTE_MS = 60 * 1_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export type TryOnQuota = Readonly<{ perMinute: number; perDay: number }>;

const DEFAULT_GUEST_QUOTA: TryOnQuota = TRY_ON_GUEST_QUOTA;
const DEFAULT_MEMBER_QUOTA: TryOnQuota = TRY_ON_MEMBER_QUOTA;
/** Image generation takes several seconds per request; this caps spend and memory in flight. */
const DEFAULT_MAX_CONCURRENT = 3;
/**
 * A request in the upload phase holds roughly three copies of a <= 7 MB body (the buffer, the parsed
 * multipart, the photo bytes), so this bounds that phase to the order of 100 MB. It is a resource
 * bound for the container, not a traffic or cost quota.
 */
const DEFAULT_MAX_CONCURRENT_UPLOADS = 4;
const DEFAULT_MAX_TRACKED_CLIENTS = 10_000;

export type TryOnRateLimiterOptions = Readonly<{
  guest?: TryOnQuota;
  member?: TryOnQuota;
  maxConcurrent?: number;
  maxConcurrentUploads?: number;
  maxTrackedClients?: number;
}>;

/** Who is asking: a signed-in member (account id) or a guest (pseudonymous client key). */
export type TryOnIdentity = Readonly<{ kind: "guest" | "member"; key: string }>;

export type TryOnAttemptDecision =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: "RATE_LIMITED" | "LOGIN_REQUIRED" | "DAILY_LIMIT_REACHED" }>;

/** Today's allowance for one identity, for display. `limit` is the per-day figure of its own kind. */
export type TryOnQuotaStatus = Readonly<{
  audience: TryOnIdentity["kind"];
  limit: number;
  remaining: number;
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

function readQuota(value: TryOnQuota | undefined, fallback: TryOnQuota, label: string): TryOnQuota {
  const quota = value ?? fallback;
  return {
    perMinute: positiveInteger(quota.perMinute, fallback.perMinute, `${label} per minute`),
    perDay: positiveInteger(quota.perDay, fallback.perDay, `${label} per day`),
  };
}

type Window = { startedAt: number; count: number };

export function createTryOnRateLimiter(options: TryOnRateLimiterOptions = {}) {
  const guestQuota = readQuota(options.guest, DEFAULT_GUEST_QUOTA, "Try-on guest quota");
  const memberQuota = readQuota(options.member, DEFAULT_MEMBER_QUOTA, "Try-on member quota");
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

  const minuteWindows = new Map<string, Window>();
  const dayWindows = new Map<string, Window>();
  let inFlight = 0;
  let uploading = 0;

  /** The identity's live window, dropping it first if it has expired. */
  function liveWindow(windows: Map<string, Window>, id: string, windowMs: number, nowMs: number) {
    const entry = windows.get(id);
    if (entry === undefined) return undefined;
    if (nowMs - entry.startedAt >= windowMs) {
      windows.delete(id);
      return undefined;
    }
    return entry;
  }

  /** Room for one more identity, reclaiming expired ones first; full of live ones means no room. */
  function hasRoom(windows: Map<string, Window>, windowMs: number, nowMs: number): boolean {
    if (windows.size < maxTrackedClients) return true;
    for (const [key, entry] of windows) {
      if (nowMs - entry.startedAt >= windowMs) windows.delete(key);
    }
    return windows.size < maxTrackedClients;
  }

  /**
   * Spends one attempt for `identity`, or says why not. Nothing is counted for a refusal, so
   * hammering the endpoint cannot burn the allowance a shopper still has.
   */
  function consumeAttempt(identity: TryOnIdentity, nowMs: number = Date.now()): TryOnAttemptDecision {
    const quota = identity.kind === "member" ? memberQuota : guestQuota;
    // Kind is part of the id, so a guest key and a member key can never collide.
    const id = `${identity.kind}:${identity.key}`;

    const day = liveWindow(dayWindows, id, DAY_MS, nowMs);
    const minute = liveWindow(minuteWindows, id, MINUTE_MS, nowMs);

    // The daily allowance is checked first: a guest who is out of attempts needs to be told to log
    // in, not to wait a minute that would change nothing.
    if (day !== undefined && day.count >= quota.perDay) {
      return {
        ok: false,
        reason: identity.kind === "guest" ? "LOGIN_REQUIRED" : "DAILY_LIMIT_REACHED",
      };
    }
    if (minute !== undefined && minute.count >= quota.perMinute) {
      return { ok: false, reason: "RATE_LIMITED" };
    }
    // Still full of live identities: fail closed rather than grow without bound.
    if (
      (day === undefined && !hasRoom(dayWindows, DAY_MS, nowMs)) ||
      (minute === undefined && !hasRoom(minuteWindows, MINUTE_MS, nowMs))
    ) {
      return { ok: false, reason: "RATE_LIMITED" };
    }

    const dayEntry = day ?? { startedAt: nowMs, count: 0 };
    const minuteEntry = minute ?? { startedAt: nowMs, count: 0 };
    dayEntry.count += 1;
    minuteEntry.count += 1;
    dayWindows.set(id, dayEntry);
    minuteWindows.set(id, minuteEntry);
    return { ok: true };
  }

  /**
   * What `identity` has left today, without spending anything. Read-only, so showing it to a shopper
   * cannot change what they are allowed.
   */
  function peekQuota(identity: TryOnIdentity, nowMs: number = Date.now()): TryOnQuotaStatus {
    const quota = identity.kind === "member" ? memberQuota : guestQuota;
    const day = liveWindow(dayWindows, `${identity.kind}:${identity.key}`, DAY_MS, nowMs);
    return {
      audience: identity.kind,
      limit: quota.perDay,
      remaining: Math.max(0, quota.perDay - (day?.count ?? 0)),
    };
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

  return { consumeAttempt, peekQuota, startUpload, startGeneration };
}
