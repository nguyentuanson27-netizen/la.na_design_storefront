/**
 * The promotion admin mutation funnel (#151 G2, master-plan unit U40).
 *
 * Every promotion Server Action runs the same way: re-authorize on the server, hand the decision to
 * the P4 service, translate whatever comes back, and emit a bounded signal for anything refused.
 *
 * It lives here, outside `src/app/admin/promotions/actions.ts`, for one reason: a `"use server"`
 * module cannot be imported by a test. Leaving the funnel in the action file would leave its
 * emission provable only by reading the source, and a signal that is only asserted structurally is
 * a signal nobody has watched fire. Everything Next-specific — the `"use server"` boundary, the
 * session lookup, `revalidatePath` — is injected, so the action file keeps owning the wiring and
 * this file owns the order of operations.
 *
 * The order is the security property `tests/domain/promotion-admin-actions-structure.test.ts`
 * pins: nothing the caller supplied is parsed, read or acted on until `authorize()` has resolved.
 *
 * Two rules follow from that and are enforced here rather than left to call-site discipline:
 *
 * 1. **Nothing request-derived is logged before authorization succeeds.** `campaignId` arrives as a
 *    raw form field, and `isBoundedPromotionIdentifier` only says it is short — not that it names a
 *    campaign, and not that the caller was entitled to name one. Attaching it to a refusal an
 *    unauthenticated caller triggered would let anyone with the URL write chosen strings into
 *    promotion telemetry and mis-attribute refusals to a campaign they never touched. So the
 *    identifier is only put in a signal on the far side of `authorize()`.
 * 2. **An unauthenticated request produces no promotion signal at all.** It never reached the
 *    promotion domain, so it has no promotion outcome to report; the auth layer owns that event.
 *    An authenticated non-admin is a different fact worth one bounded, categorical line, and its
 *    volume is bounded by real sessions. Both still return the same `FORBIDDEN` outcome to the
 *    browser — the response must not disclose which of the two happened.
 *
 * The activation gate is reported by the operation itself, through `reportActivationGate` on the
 * context, rather than inferred from the action's label. An action label is too coarse: `edit`
 * routes to `editScheduledPromotionCampaign`, whose outcome the gate decides, only when the
 * campaign is Scheduled — a Draft edit, a malformed input or a missing campaign never reaches a
 * gate-governed path, and stamping gate state on those would claim a bearing the flag does not
 * have.
 */

import { summarizeThresholdWarnings } from "../commerce/list-price.ts";
import { AuthorizationError } from "../auth/authorization.ts";
import { isPromotionActivationEnabled } from "../commerce/promotion-activation.ts";
import {
  describePromotionFailure,
  translatePromotionWriteError,
  type PromotionAdminFailure,
  type PromotionFailureDescription,
} from "../commerce/promotion-admin-feedback.ts";
import {
  describeActivationGate,
  describeActivationRejection,
  emitPromotionSignal,
  type PromotionActivationOperation,
  type PromotionObservabilitySignal,
} from "./promotion-observability.ts";

/** What the P4 service hands back to an action. */
export type PromotionOperationResult =
  | Readonly<{ ok: true; warnings?: readonly Readonly<{ variantId: string; minimumPercent: number | null }>[]; warningSummary?: Readonly<{ count: number; minimumPercent: number | null }> }>
  | Readonly<{ ok: false; failure: PromotionAdminFailure }>;

/**
 * What the action hands back to the page. Only the typed reason travels; the operator-facing
 * sentence is looked up on the server when the page re-renders.
 */
export type PromotionActionOutcome =
  | Readonly<{ ok: true; warningCount?: number; minimumPercent?: number | null }>
  | Readonly<{ ok: false; failure: PromotionFailureDescription }>;

export type PromotionOperationContext = Readonly<{
  /**
   * Called from the branch that is about to enter a code path whose outcome
   * `LA_PROMOTION_ACTIVATION_ENABLED` decides.
   *
   * Promotion rollback is an environment flip, so the gate's state in the running process is the
   * fact an operator needs to confirm the flip landed — and a boot-time line says nothing about the
   * process serving this request. Reported at most once per operation.
   */
  reportActivationGate: () => void;
}>;

export type PromotionAdminOperationInput<Session> = Readonly<{
  /** Chosen at the call site from a closed set, never derived from request input. */
  operation: PromotionActivationOperation;
  /** Raw browser input where the operation takes one; never logged before authorization. */
  campaignId?: string;
  authorize: () => Promise<Session>;
  run: (session: Session, context: PromotionOperationContext) => Promise<PromotionOperationResult>;
  /** Cache invalidation for a committed write. Runs only on success. */
  onCommitted: () => void;
  emit?: (signal: PromotionObservabilitySignal) => void;
  env?: Readonly<Record<string, string | undefined>>;
}>;

export async function runPromotionAdminOperation<Session>({
  operation,
  campaignId,
  authorize,
  run,
  onCommitted,
  emit = (signal) => emitPromotionSignal(signal),
  env = process.env,
}: PromotionAdminOperationInput<Session>): Promise<PromotionActionOutcome> {
  const forbidden: PromotionActionOutcome = {
    ok: false,
    failure: {
      reason: "FORBIDDEN",
      message: "Bạn không có quyền thực hiện thao tác này.",
      wroteNothing: true,
    },
  };

  // Authorization is re-established here rather than inherited from the page render. A Server
  // Action is its own request, and a session can have ended since the page was drawn.
  let session: Session;
  try {
    session = await authorize();
  } catch (error) {
    if (error instanceof AuthorizationError) {
      if (error.code === "FORBIDDEN") {
        // Categorical only: no campaign identifier, because nothing the caller sent has been
        // established as naming a campaign they were entitled to act on.
        emit(describeActivationRejection({ operation, failure: { reason: "FORBIDDEN" } }));
      }
      return forbidden;
    }
    throw error;
  }

  let gateReported = false;
  const context: PromotionOperationContext = {
    reportActivationGate: () => {
      if (gateReported) return;
      gateReported = true;
      emit(describeActivationGate({ operation, enabled: isPromotionActivationEnabled(env) }));
    },
  };

  try {
    const outcome = await run(session, context);
    if (outcome.ok) {
      onCommitted();
      const warnings = outcome.warnings ?? [];
      const summary = outcome.warningSummary ?? summarizeThresholdWarnings(warnings);
      return { ok: true, ...(warnings.length ? { warningCount: summary.count, minimumPercent: summary.minimumPercent } : {}) };
    }
    emit(describeActivationRejection({ operation, campaignId, failure: outcome.failure }));
    return { ok: false, failure: describePromotionFailure(outcome.failure) };
  } catch (error) {
    // Only the one violation the surface can describe better than the driver can. Anything else
    // is re-thrown so a genuine fault reaches the error boundary and the logs instead of being
    // rendered as a form message.
    const translated = translatePromotionWriteError(error);
    if (translated === null) throw error;
    emit(describeActivationRejection({ operation, campaignId, failure: translated }));
    return { ok: false, failure: describePromotionFailure(translated) };
  }
}
