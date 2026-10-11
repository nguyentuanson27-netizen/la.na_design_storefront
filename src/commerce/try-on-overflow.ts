import type { TryOnFailureReason } from "./try-on-policy.ts";
import type { TryOnGenerationSlot } from "./try-on-rate-limit.ts";

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
 * - a cap on Vertex generations per calendar day in Vietnam time (UTC+7), counted when a slot is
 *   taken because that is when the spend is committed, whatever the outcome;
 * - a cap on Vertex generations in flight;
 * - Flow's health: an auth failure marks it down for 30 min, a BUSY from the worker itself (both of
 *   its models out of quota) for 10 min, and three generic failures or timeouts in a row for 15 min.
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
  | Exclude<TryOnGenerationSlot, Readonly<{ ok: false }>>
  | Readonly<{ ok: false; reason: "BUSY"; cause: "daily_cap" | "concurrency" }>;

export type TryOnPrimaryDown = Readonly<{
  cause: "auth_failed" | "provider_busy" | "repeated_failures";
  forMs: number;
}>;

export type TryOnPrimaryOutcome = Readonly<{ ok: true }> | Readonly<{ ok: false; reason: TryOnFailureReason }>;

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
    }
    if (usedToday >= options.dailyCap) return { ok: false, reason: "BUSY", cause: "daily_cap" };
    if (inFlight >= maxConcurrent) return { ok: false, reason: "BUSY", cause: "concurrency" };
    usedToday += 1;
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
        return markDown("provider_busy", PRIMARY_DOWN_AFTER_PROVIDER_BUSY_MS);
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
