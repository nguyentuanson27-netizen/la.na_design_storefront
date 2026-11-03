import type { GuestCheckoutSubmitResult } from "./guest-checkout-submit.ts";

/**
 * What a guest checkout submit tells us about whether an order exists in Pancake.
 *
 * - `CONFIRMED`: the order was placed.
 * - `NOT_SENT`: nothing was created in Pancake. The order may still exist *locally* (a capacity
 *   refusal and a Pancake hard rejection both close a local order that carries an `orderCode`), but
 *   there is no parcel to ship and nothing to reconcile.
 * - `MAY_EXIST`: an order may exist in Pancake or be about to; it is not ours to say it does not.
 *
 * This is decided by the result's *status*, never by whether it carries an `orderCode`: that code
 * names the local order row, which exists on both sides of this line.
 *
 * The mapping holds because of how `createGuestCheckoutSubmitService` builds its results, and
 * `tests/domain/guest-checkout-submission-disposition.test.ts` drives each path through the real
 * service to keep it so:
 *
 * - `RETRYABLE` is returned only when no external write happened: a snapshot or geo refusal, a
 *   capacity refusal before the write boundary, a validation that could not run, or an order Pancake
 *   refused outright (HTTP 400/401/403/404/422, closed `REJECTED`). Every outcome that cannot be
 *   told apart from success -- a timeout, a 5xx, an unreadable response -- is `SYNC_UNKNOWN`, which
 *   is why `RETRYABLE` is safe to read as "nothing was sent".
 * - `PRICE_CHANGED` is a reprice of a draft that was never submitted.
 * - `PROCESSING` and `SYNC_UNKNOWN` are in flight or unknown.
 *
 * A submit that *throws* has no result and is outside this function: the caller must treat it as
 * `MAY_EXIST`.
 */
export type SubmissionDisposition = "CONFIRMED" | "NOT_SENT" | "MAY_EXIST";

export function submissionDisposition(result: GuestCheckoutSubmitResult): SubmissionDisposition {
  if (result.ok) return "CONFIRMED";
  switch (result.status) {
    case "PRICE_CHANGED":
    case "RETRYABLE":
      return "NOT_SENT";
    case "PROCESSING":
    case "SYNC_UNKNOWN":
      return "MAY_EXIST";
  }
}
