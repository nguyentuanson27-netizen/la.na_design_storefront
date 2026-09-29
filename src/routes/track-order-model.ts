import {
  isShortOrderPublicCode,
  normalizeOrderPublicCodeInput,
} from "../commerce/order-public-code.ts";

/**
 * What the order-tracking route decides, as pure functions — separate from `track-order.ts` for the
 * same reason `checkout-success-model.ts` is: the loader file pulls in the route shell.
 */

export type TrackOrderViewModel = Readonly<{
  /** A short order code to prefill, or null. Never an arbitrary echo of the query string. */
  prefilledOrderCode: string | null;
}>;

export function parsePrefilledOrderCode(value: string | string[] | undefined): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const normalized = normalizeOrderPublicCodeInput(value);
  return isShortOrderPublicCode(normalized) ? normalized : null;
}
