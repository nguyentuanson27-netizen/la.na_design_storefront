import { TRY_ON_FAILURE_REASONS, type TryOnFailureReason } from "./try-on-policy.ts";

/**
 * The steps a shopper takes in the browser that the server cannot see (spec §15 amendment
 * 2026-11-09). The server already knows when a generation starts, succeeds or fails; what it cannot
 * know is who opened the dialog, from where, how far they got, what they did with the picture, and
 * whether it was any good. Those are what say whether try-on helps sell, so the browser reports them.
 *
 * Shared by the browser (which builds the payload) and the endpoint (which re-reads it): the closed
 * lists here are the whole vocabulary, so neither side can invent a field. There is no field an
 * image, a file name, free text or anything about the person could travel in.
 */

export const TRY_ON_CLIENT_EVENTS = [
  "open",
  "photo_selected",
  "continue",
  "generate",
  "result_shown",
  "result_error",
  "retry",
  "download",
  "share",
  "zoom",
  "to_cart",
  "feedback",
] as const;
export type TryOnClientEventName = (typeof TRY_ON_CLIENT_EVENTS)[number];

/** Where the dialog was opened from. */
export const TRY_ON_OPEN_SOURCES = ["link", "nudge", "media", "card", "dock", "deeplink"] as const;
export type TryOnOpenSource = (typeof TRY_ON_OPEN_SOURCES)[number];

export const TRY_ON_RATINGS = ["up", "down"] as const;
export type TryOnRating = (typeof TRY_ON_RATINGS)[number];

export type TryOnClientEvent = Readonly<{
  event: TryOnClientEventName;
  productSlug?: string;
  source?: TryOnOpenSource;
  rating?: TryOnRating;
  /** `result_error` only: the safe class the shopper was shown. */
  reason?: TryOnFailureReason;
}>;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 200;

/** The event in `payload` if it is exactly within the vocabulary above; anything else is `null`. */
export function parseTryOnClientEvent(payload: unknown): TryOnClientEvent | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const event = TRY_ON_CLIENT_EVENTS.find((name) => name === record.event);
  if (event === undefined) return null;

  const parsed: { -readonly [K in keyof TryOnClientEvent]: TryOnClientEvent[K] } = { event };
  const { productSlug, source, rating, reason } = record;
  if (typeof productSlug === "string" && productSlug.length <= MAX_SLUG_LENGTH && SLUG_PATTERN.test(productSlug)) {
    parsed.productSlug = productSlug;
  }
  const knownSource = TRY_ON_OPEN_SOURCES.find((value) => value === source);
  if (knownSource !== undefined) parsed.source = knownSource;
  const knownRating = TRY_ON_RATINGS.find((value) => value === rating);
  if (knownRating !== undefined) parsed.rating = knownRating;
  const knownReason = TRY_ON_FAILURE_REASONS.find((value) => value === reason);
  if (knownReason !== undefined) parsed.reason = knownReason;
  // A rating is the whole point of a feedback event.
  if (event === "feedback" && parsed.rating === undefined) return null;
  return parsed;
}
