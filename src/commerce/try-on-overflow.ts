import type { TryOnFailureReason } from "./try-on-policy.ts";

/**
 * The Vertex overflow behind Flow (owner decision 2026-10-11; see `try-on-provider.ts`).
 *
 * Routing happens before anything is sent, so one shopper action reaches one provider: Flow when its
 * single slot is free and it is not marked down, otherwise Vertex if this gate lets it through,
 * otherwise BUSY as before. Nothing here ever retries a request on the other provider after it has
 * been sent — a Flow timeout may still finish and spend, and a safety refusal must stay final.
 *
 * Three controls, all in process memory like the rest of the limiter (one app container, ADR 0002):
 *
 * - a cap on Vertex generations per calendar day in Vietnam time (UTC+7). Taking a slot only
 *   *reserves* one of today's generations; it is spent by `commit()` at the provider call, whatever
 *   the outcome, and a reservation released without a commit (the garment image could not be
 *   fetched, so Vertex was never called) is handed back. Reservations count against the cap, so
 *   concurrent requests can never overshoot it;
 * - a cap on Vertex generations in flight;
 * - Flow's health: an auth failure marks it down for 30 min, a quota BUSY from the worker (its final
 *   model refused for quota, HTTP 429) for 10 min, and three generic failures or timeouts in a row
 *   for 15 min. A BUSY that only means the worker is momentarily held (its lock, a held Chrome
 *   profile, an operator's `/v1/cool` pause: HTTP 409) says nothing about Flow's health.
 *   While it is down every request goes to Vertex; the first request after that tries Flow again.
 *
 * A restart forgets all three: the cap starts again and Flow is tried first. That is acceptable for a
 * cost guard that is otherwise bounded per day.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const VIETNAM_OFFSET_MS = 7 * 60 * MINUTE_MS;

export const OVERFLOW_MAX_CONCURRENT = 2;
export const PRIMARY_DOWN_AFTER_AUTH_FAILURE_MS = 30 * MINUTE_MS;
export const PRIMARY_DOWN_AFTER_PROVIDER_BUSY_MS = 10 * MINUTE_MS;
export const PRIMARY_DOWN_AFTER_FAILURES_MS = 15 * MINUTE_MS;
export const PRIMARY_FAILURES_BEFORE_DOWN = 3;

export type TryOnOverflowSlot =
  | Readonly<{
      ok: true;
      /** Spends the reserved generation: call it right before the provider call. Idempotent. */
      commit: () => void;
      /** Frees the slot, and hands the reservation back if it was never committed. Idempotent. */
      release: () => void;
    }>
  | Readonly<{ ok: false; reason: "BUSY"; cause: "daily_cap" | "concurrency" }>;

export type TryOnPrimaryDown = Readonly<{
  cause: "auth_failed" | "provider_busy" | "repeated_failures";
  forMs: number;
}>;

export type TryOnPrimaryOutcome =
  | Readonly<{ ok: true }>
  /** `quotaExhausted`: the worker's BUSY was a quota refusal, not a momentarily held worker. */
  | Readonly<{ ok: false; reason: TryOnFailureReason; quotaExhausted?: boolean }>;

export type TryOnOverflowGate = Readonly<{
  /** Whether Flow is marked down right now; requests then go straight to the overflow. */
  primaryDown: () => boolean;
  /** Reserves a Vertex slot and spends one of today's capped generations, or says why not. */
  startOverflow: () => TryOnOverflowSlot;
  /** What Flow did with a request routed to it. Returns the mark-down it caused, if any. */
  notePrimaryOutcome: (outcome: TryOnPrimaryOutcome) => TryOnPrimaryDown | null;
}>;

function vietnamDay(nowMs: number): number {
  return Math.floor((nowMs + VIETNAM_OFFSET_MS) / DAY_MS);
}

export function createTryOnOverflowGate(
  options: Readonly<{ dailyCap: number; maxConcurrent?: number; now?: () => number }>,
): TryOnOverflowGate {
  const now = options.now ?? Date.now;
  const maxConcurrent = options.maxConcurrent ?? OVERFLOW_MAX_CONCURRENT;
  if (!Number.isSafeInteger(options.dailyCap) || options.dailyCap <= 0) {
    throw new TypeError("Try-on overflow daily cap must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0) {
    throw new TypeError("Try-on overflow max concurrent must be a positive safe integer");
  }

  let day = vietnamDay(now());
  let usedToday = 0;
  // Reserved but not yet committed or handed back; they belong to the day they were taken on.
  let reserved = 0;
  let inFlight = 0;
  let downUntil = 0;
  let failuresInARow = 0;

  function primaryDown(): boolean {
    return now() < downUntil;
  }

  function startOverflow(): TryOnOverflowSlot {
    const today = vietnamDay(now());
    if (today !== day) {
      day = today;
      usedToday = 0;
      reserved = 0;
    }
    if (usedToday + reserved >= options.dailyCap) return { ok: false, reason: "BUSY", cause: "daily_cap" };
    if (inFlight >= maxConcurrent) return { ok: false, reason: "BUSY", cause: "concurrency" };
    reserved += 1;
    inFlight += 1;
    const takenOn = day;
    let state: "reserved" | "committed" | "returned" = "reserved";
    let released = false;
    function settleReservation(spend: boolean) {
      if (state !== "reserved") return;
      state = spend ? "committed" : "returned";
      // A reservation from a previous day was already dropped when the day turned over.
      if (takenOn !== day) return;
      reserved -= 1;
      if (spend) usedToday += 1;
    }
    return {
      ok: true,
      commit: () => settleReservation(true),
      release: () => {
        if (released) return;
        released = true;
        inFlight -= 1;
        settleReservation(false);
      },
    };
  }

  function markDown(cause: TryOnPrimaryDown["cause"], forMs: number): TryOnPrimaryDown {
    downUntil = now() + forMs;
    failuresInARow = 0;
    return { cause, forMs };
  }

  function notePrimaryOutcome(outcome: TryOnPrimaryOutcome): TryOnPrimaryDown | null {
    if (outcome.ok) {
      failuresInARow = 0;
      return null;
    }
    switch (outcome.reason) {
      case "AUTH_FAILED":
        return markDown("auth_failed", PRIMARY_DOWN_AFTER_AUTH_FAILURE_MS);
      case "BUSY":
        // Only a quota refusal says Flow cannot serve for a while; a held worker frees in seconds.
        return outcome.quotaExhausted === true
          ? markDown("provider_busy", PRIMARY_DOWN_AFTER_PROVIDER_BUSY_MS)
          : null;
      case "GENERATION_FAILED":
      case "TIMEOUT":
        failuresInARow += 1;
        return failuresInARow >= PRIMARY_FAILURES_BEFORE_DOWN
          ? markDown("repeated_failures", PRIMARY_DOWN_AFTER_FAILURES_MS)
          : null;
      default:
        // A safety refusal or a problem with this request's inputs says Flow itself is working.
        failuresInARow = 0;
        return null;
    }
  }

  return { primaryDown, startOverflow, notePrimaryOutcome };
}
