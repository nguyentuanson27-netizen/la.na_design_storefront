import { VIETNAM_UTC_OFFSET, VIETNAM_UTC_OFFSET_MINUTES } from "../brand/schema.ts";

/**
 * I9 — the owner-approved preorder availability cycle (ADR 0011, superseding its blocked state).
 *
 * ADR 0011 refused to publish Google's `backorder` because the repository had no truthful date to
 * put beside it, and named the two tempting fabrications explicitly: a rolling `today + 15`, and an
 * order ETA. The owner approved a third thing on 2026-09-18 — an **automatic per-variant cycle**
 * whose date is fixed when the cycle opens and never recomputed.
 *
 * That single sentence is the whole design, and everything below exists to protect it:
 *
 * - the date is derived **once**, from the day the cycle opened, not from the day anyone asks;
 * - an observation that finds an already-open cycle is a **no-op**, so the sync can rerun all day;
 * - an expired cycle is **not** rolled forward — publication stops instead (owner rule 8), because
 *   silently granting another fifteen days is exactly the moving product fact ADR 0011 rejected.
 *
 * This module is pure. It holds no clock and reads no database, so every rule above is decidable
 * from its arguments — which is what makes "did the date move?" a question tests can answer.
 */

/** Owner-approved on 2026-09-18: a cycle promises availability fifteen calendar days after it opens. */
export const PREORDER_AVAILABILITY_WINDOW_DAYS = 15;

/**
 * Vietnam is UTC+07:00 year-round and observes no daylight saving, so a fixed offset is exact
 * rather than an approximation. `promotion-admin-input.ts` already reads owner-entered campaign
 * times this way; using the same convention keeps one notion of "a Vietnamese day" in the codebase.
 */
/** A Vietnam calendar day as `YYYY-MM-DD`. Deliberately a date, with no time and no zone. */
export type VietnamCalendarDate = string;

const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseCalendarDate(
  value: unknown,
): Readonly<{ year: number; month: number; day: number }> | null {
  if (typeof value !== "string") return null;
  const match = CALENDAR_DATE_PATTERN.exec(value);
  if (match === null) return null;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  // Round-tripping through UTC rejects what the regex cannot: month 13, and February 30 in a
  // non-leap year. `Date.UTC` would silently roll both forward into a real but different day.
  const asUtc = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(asUtc.getTime())) return null;
  if (
    asUtc.getUTCFullYear() !== year ||
    asUtc.getUTCMonth() !== month - 1 ||
    asUtc.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function formatCalendarDate(instant: Date): VietnamCalendarDate {
  const year = String(instant.getUTCFullYear()).padStart(4, "0");
  const month = String(instant.getUTCMonth() + 1).padStart(2, "0");
  const day = String(instant.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Which Vietnamese calendar day an instant falls on.
 *
 * `null` for an unusable instant rather than a fallback: this value becomes a published product
 * fact, so an `Invalid Date` that resolved to "today" would be a fabricated one.
 */
export function vietnamCalendarDate(instant: Date): VietnamCalendarDate | null {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) return null;
  const shifted = new Date(instant.getTime() + VIETNAM_UTC_OFFSET_MINUTES * 60_000);
  if (Number.isNaN(shifted.getTime())) return null;
  return formatCalendarDate(shifted);
}

/**
 * Calendar-day arithmetic, which is what the owner approved — not 15 × 24 hours.
 *
 * The two happen to agree for Vietnam because it has no daylight saving, but the rule is stated in
 * calendar days and month and year lengths are the part that actually varies. Going through UTC
 * midnight keeps February and December correct without a lookup table.
 */
export function addVietnamCalendarDays(
  date: VietnamCalendarDate,
  days: number,
): VietnamCalendarDate | null {
  const parsed = parseCalendarDate(date);
  if (parsed === null) return null;
  if (!Number.isSafeInteger(days)) return null;
  const shifted = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days));
  if (Number.isNaN(shifted.getTime())) return null;
  return formatCalendarDate(shifted);
}

/**
 * Has the promised day passed?
 *
 * Strictly after, so a variant is still publishable **on** its availability date — that day is the
 * promise being kept, not the day it is broken. Lexicographic comparison is exact for `YYYY-MM-DD`,
 * but both sides are parsed first so a malformed value fails closed as expired rather than
 * comparing as a string that happens to sort early.
 */
export function isAvailabilityDateExpired(
  availabilityDate: VietnamCalendarDate,
  today: VietnamCalendarDate,
): boolean {
  if (parseCalendarDate(availabilityDate) === null) return true;
  if (parseCalendarDate(today) === null) return true;
  return today > availabilityDate;
}

/**
 * The same day, written the way a Vietnamese shopper reads one.
 *
 * `availability_date` must be visible on the landing page, and `2026-10-03` beside otherwise
 * entirely Vietnamese copy is a rough edge, so the page renders `03/10/2026`. It is a pure string
 * transform rather than `toLocaleDateString`, deliberately: a locale-aware formatter would depend
 * on the viewer's browser locale and the runtime's zone, which means the server and the client
 * could disagree about the same date and React would report a hydration mismatch on a fact we
 * already hold exactly. Only the presentation changes — the feed and the JSON-LD keep the ISO
 * value, which is what Google's schema wants.
 *
 * `null` for a date this module cannot parse, so a malformed one renders nothing rather than
 * something misread.
 */
export function formatVietnamCalendarDate(
  availabilityDate: VietnamCalendarDate,
): string | null {
  const parsed = parseCalendarDate(availabilityDate);
  if (parsed === null) return null;
  const day = String(parsed.day).padStart(2, "0");
  const month = String(parsed.month).padStart(2, "0");
  return `${day}/${month}/${parsed.year}`;
}


export type SerializedVietnamAvailabilityDate = Readonly<{
  /** Google Merchant XML format documented for availability_date. */
  merchant: string;
  /** Schema.org DateTime spelling used by Offer.availabilityStarts. */
  schema: string;
}>;

/**
 * Serialize one persisted Vietnam calendar day for the two public machine-readable boundaries.
 *
 * Persistence stays date-only because the owner approved a calendar-day fact. The public formats
 * require timezone-qualified DateTimes, so both are derived here from that same validated day and
 * can differ only in wire spelling, never in the day they claim.
 */
export function serializeVietnamAvailabilityDate(
  availabilityDate: VietnamCalendarDate,
): SerializedVietnamAvailabilityDate | null {
  if (parseCalendarDate(availabilityDate) === null) return null;
  const merchantOffset = VIETNAM_UTC_OFFSET.replace(":", "");
  return Object.freeze({
    merchant: `${availabilityDate}T00:00${merchantOffset}`,
    schema: `${availabilityDate}T00:00:00${VIETNAM_UTC_OFFSET}`,
  });
}

/**
 * The persisted state of one variant's cycle.
 *
 * `cycleStartDate` and `availabilityDate` are both null exactly when no cycle is open. The two
 * `last*` fields are the previous trusted observation, and they are what make an edge detectable:
 * without them a rerun could not tell "still sold out" from "just sold out".
 */
export type AvailabilityCycleState = Readonly<{
  cycleStartDate: VietnamCalendarDate | null;
  availabilityDate: VietnamCalendarDate | null;
  lastStockNonPositive: boolean;
  lastPreorder: boolean;
}>;

export type AvailabilityObservation = Readonly<{
  /** Ready stock is at or below zero. Derived from mirrored catalog stock, never from a request. */
  stockNonPositive: boolean;
  /** The variant's resolved selling mode is `PREORDER`. */
  isPreorder: boolean;
  /** When the website observed this state. */
  observedAt: Date;
}>;

const NO_CYCLE = Object.freeze({ cycleStartDate: null, availabilityDate: null });

/**
 * Fold one trusted observation into a variant's cycle.
 *
 * Idempotent by construction: the only branch that writes a date is the one that finds **no** open
 * cycle, so observing the same state twice cannot produce two different answers. That is why the
 * function takes the previous state rather than reading a clock — "has a cycle already opened?" is
 * the entire question, and it is answerable from the arguments alone.
 *
 * `previous === null` means this variant has never been observed, which owner rule 3's second
 * bullet makes a cycle-opening event in its own right when the variant is already sold out on
 * preorder. It uses the day the website *saw* that state; it never guesses when the stock actually
 * ran out, which is the historical backfill the owner ruled out.
 */
export function observeAvailabilityCycle(
  previous: AvailabilityCycleState | null,
  observation: AvailabilityObservation,
): AvailabilityCycleState {
  const { stockNonPositive, isPreorder, observedAt } = observation;
  const seen = { lastStockNonPositive: stockNonPositive, lastPreorder: isPreorder };

  // Leaving preorder, or having ready stock again, ends the cycle. Owner rule 7 and rule 3's third
  // bullet are the same statement from two directions: what closes a cycle is what will let the
  // next sold-out observation open a fresh one.
  if (!isPreorder || !stockNonPositive) {
    return Object.freeze({ ...NO_CYCLE, ...seen });
  }

  // Sold out on preorder with a cycle already open: preserve it exactly. This is the branch that
  // makes a rerun free, and the branch that refuses to extend an expired date.
  if (previous !== null && previous.cycleStartDate !== null && previous.availabilityDate !== null) {
    return Object.freeze({
      cycleStartDate: previous.cycleStartDate,
      availabilityDate: previous.availabilityDate,
      ...seen,
    });
  }

  const cycleStartDate = vietnamCalendarDate(observedAt);
  const availabilityDate =
    cycleStartDate === null
      ? null
      : addVietnamCalendarDays(cycleStartDate, PREORDER_AVAILABILITY_WINDOW_DAYS);
  if (cycleStartDate === null || availabilityDate === null) {
    // No trustworthy day, so no cycle. Failing closed here costs a backorder listing; failing open
    // would publish a date the website invented.
    return Object.freeze({ ...NO_CYCLE, ...seen });
  }

  return Object.freeze({ cycleStartDate, availabilityDate, ...seen });
}
