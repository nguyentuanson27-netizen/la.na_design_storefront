import {
  TRY_ON_CLIENT_EVENTS,
  TRY_ON_OPEN_SOURCES,
  TRY_ON_RATINGS,
  type TryOnClientEventName,
  type TryOnOpenSource,
  type TryOnRating,
} from "../commerce/try-on-client-events.ts";
import { TRY_ON_FAILURE_REASONS, type TryOnFailureReason } from "../commerce/try-on-policy.ts";

/**
 * Non-sensitive operational signals for the try-on boundary (spec §15).
 *
 * Follows the existing convention (`pancake-order-submit-runtime.ts`, `promotion-observability.ts`):
 * one JSON object per line on stdout, which ADR 0002 names as the collected stream. No new
 * monitoring platform.
 *
 * What may appear is an allowlist, assembled field by field. The shopper's image, base64, any
 * credential, IP, or an upstream error body has no field to travel in, so a careless future call
 * site cannot leak one by spreading an object into a signal.
 */

export type TryOnSignalName =
  | "try_on.generation_started"
  | "try_on.generation_succeeded"
  | "try_on.generation_failed"
  | "try_on.safety_blocked"
  | "try_on.rate_limited"
  /** The attempt of a request that failed for a reason of ours was given back. */
  | "try_on.attempt_refunded"
  /** A step the shopper took in the browser (see `TryOnClientEvent`); counted, never an image. */
  | "try_on.client_event"
  /** A request sent to the Vertex overflow instead of Flow; `cause` says why. */
  | "try_on.overflow_routed"
  /** Flow marked down after this outcome; requests go to the overflow for a while. */
  | "try_on.primary_marked_down";

/** The provider a generation went to. */
export type TryOnSignalProvider = "vertex" | "flow";

/** Why a request was routed to the overflow, why the overflow refused one, or why Flow went down. */
export type TryOnSignalCause =
  | "primary_busy"
  | "primary_down"
  | "daily_cap"
  | "concurrency"
  | "auth_failed"
  | "provider_busy"
  | "repeated_failures";

const PROVIDERS: readonly TryOnSignalProvider[] = ["vertex", "flow"];
const CAUSES: readonly TryOnSignalCause[] = [
  "primary_busy",
  "primary_down",
  "daily_cap",
  "concurrency",
  "auth_failed",
  "provider_busy",
  "repeated_failures",
];

export type TryOnSignalInput = Readonly<{
  name: TryOnSignalName;
  /** The safe failure class the shopper was shown. */
  reason?: TryOnFailureReason;
  /** Total request latency. */
  latencyMs?: number;
  /** Time spent in the provider call alone. */
  upstreamLatencyMs?: number;
  /** The server-resolved storefront slug, never a client-supplied string. */
  productSlug?: string;
  provider?: TryOnSignalProvider;
  cause?: TryOnSignalCause;
  /** `try_on.client_event` only: which browser-side step, from where, and a thumb if it was one. */
  clientEvent?: TryOnClientEventName;
  source?: TryOnOpenSource;
  rating?: TryOnRating;
}>;

export type TryOnSignal = Readonly<{
  name: TryOnSignalName;
  reason?: TryOnFailureReason;
  latencyMs?: number;
  upstreamLatencyMs?: number;
  productSlug?: string;
  provider?: TryOnSignalProvider;
  cause?: TryOnSignalCause;
  clientEvent?: TryOnClientEventName;
  source?: TryOnOpenSource;
  rating?: TryOnRating;
}>;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 200;

function boundedMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

export function buildTryOnSignal(input: TryOnSignalInput): TryOnSignal {
  const signal: { -readonly [K in keyof TryOnSignal]: TryOnSignal[K] } = { name: input.name };

  if (input.reason !== undefined && TRY_ON_FAILURE_REASONS.includes(input.reason)) {
    signal.reason = input.reason;
  }
  const latencyMs = boundedMs(input.latencyMs);
  if (latencyMs !== undefined) signal.latencyMs = latencyMs;
  const upstreamLatencyMs = boundedMs(input.upstreamLatencyMs);
  if (upstreamLatencyMs !== undefined) signal.upstreamLatencyMs = upstreamLatencyMs;
  if (
    typeof input.productSlug === "string" &&
    input.productSlug.length <= MAX_SLUG_LENGTH &&
    SLUG_PATTERN.test(input.productSlug)
  ) {
    signal.productSlug = input.productSlug;
  }
  if (input.provider !== undefined && PROVIDERS.includes(input.provider)) signal.provider = input.provider;
  if (input.cause !== undefined && CAUSES.includes(input.cause)) signal.cause = input.cause;
  if (input.clientEvent !== undefined && TRY_ON_CLIENT_EVENTS.includes(input.clientEvent)) {
    signal.clientEvent = input.clientEvent;
  }
  if (input.source !== undefined && TRY_ON_OPEN_SOURCES.includes(input.source)) signal.source = input.source;
  if (input.rating !== undefined && TRY_ON_RATINGS.includes(input.rating)) signal.rating = input.rating;
  return signal;
}

function writeToStdout(line: string): void {
  process.stdout.write(line);
}

export function emitTryOnSignal(
  input: TryOnSignalInput,
  write: (line: string) => void = writeToStdout,
): void {
  try {
    write(`${JSON.stringify(buildTryOnSignal(input))}\n`);
  } catch {
    // Telemetry must never fail a shopper's request.
  }
}
