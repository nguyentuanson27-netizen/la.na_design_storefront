/**
 * The gift / quantity-tier admin mutation funnel (GQ05).
 *
 * Same security property as `promotion-admin-operation.ts`: nothing the caller supplied is parsed,
 * read or acted on until `authorize()` has resolved, and an unauthorized caller is told only
 * `FORBIDDEN` -- never whether the campaign exists. Everything Next-specific (the `"use server"`
 * boundary, the session lookup, `revalidatePath`) is injected, so this order of operations is
 * testable.
 *
 * Only a bounded, categorical line is ever logged for a refusal: the operation label and the typed
 * reason. Never a campaign id, a name, a product id or any request-derived text.
 */

import { AuthorizationError } from "../auth/authorization.ts";
import {
  describeGiftQuantityFailure,
  type GiftQuantityFailure,
  type GiftQuantityFailureDescription,
} from "../commerce/gift-quantity-admin-feedback.ts";

export const GIFT_QUANTITY_ADMIN_OPERATIONS = [
  "create",
  "edit",
  "copy",
  "publish",
  "edit-scheduled",
  "disable",
  "end-early",
] as const;
export type GiftQuantityAdminOperation = (typeof GIFT_QUANTITY_ADMIN_OPERATIONS)[number];

export type GiftQuantityOperationResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; failure: GiftQuantityFailure }>;

export type GiftQuantityActionOutcome =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; failure: GiftQuantityFailureDescription }>;

export type GiftQuantityRefusalSignal = Readonly<{
  event: "gift_quantity_admin_refused";
  operation: GiftQuantityAdminOperation;
  reason: GiftQuantityFailure["reason"];
}>;

export async function runGiftQuantityAdminOperation<Session>({
  operation,
  authorize,
  run,
  onCommitted,
  emit = () => undefined,
}: Readonly<{
  /** Chosen at the call site from a closed set, never derived from request input. */
  operation: GiftQuantityAdminOperation;
  authorize: () => Promise<Session>;
  run: (session: Session) => Promise<GiftQuantityOperationResult>;
  /** Cache invalidation for a committed write. Runs only on success. */
  onCommitted: () => void;
  emit?: (signal: GiftQuantityRefusalSignal) => void;
}>): Promise<GiftQuantityActionOutcome> {
  let session: Session;
  try {
    session = await authorize();
  } catch (error) {
    if (error instanceof AuthorizationError) {
      // Unauthenticated and non-admin look identical to the browser, and neither reaches the domain.
      return {
        ok: false,
        failure: describeGiftQuantityFailure({ reason: "FORBIDDEN" }),
      };
    }
    throw error;
  }

  const outcome = await run(session);
  if (outcome.ok) {
    onCommitted();
    return { ok: true };
  }
  emit({ event: "gift_quantity_admin_refused", operation, reason: outcome.failure.reason });
  return { ok: false, failure: describeGiftQuantityFailure(outcome.failure) };
}
