/**
 * Bounded, redacted promotion signals (#151 G2, master-plan unit U40).
 *
 * The promotion admin surface already returns precise typed failures, and that precision is right
 * where it lands: `PromotionAdminFailure` names the exact catalog rows an admin has to fix. A log
 * is a different audience with different rules. `NO_EFFECTIVE_DISCOUNT`, `UNUSABLE_BASE_PRICE` and
 * `OVERLAPPING_CAMPAIGN` each carry an **unbounded array of internal identifiers**, so writing a
 * failure straight to stdout would publish catalog identifiers at whatever volume a bad campaign
 * happens to produce.
 *
 * This module is the reduction that makes those failures loggable. What it bounds is *volume and
 * shape*, not the existence of identifiers: `docs/specs/promotions-flash-sale-v1.md` §Observability
 * names "campaign ID, target type/ID, variant ID, bounded reason code" as useful context and
 * forbids "customer address/phone/secrets/session handles or raw quote proof". A signal that
 * reduced everything to a count would obey a stricter rule than the spec asks for and would leave
 * an operator holding `OVERLAPPING_CAMPAIGN affectedCount=1` with no way to find the campaign that
 * conflicted. So identifiers survive, capped at `MAX_REPORTED_SIGNAL_IDENTIFIERS` per signal and
 * each individually length-bounded, with the untruncated total kept alongside so a sample is never
 * mistaken for the whole.
 *
 * It exists as a function rather than a convention because
 * `docs/decisions/0002-vps-production-infrastructure.md` states the redaction policy in prose, and
 * prose does not fail a test when a future field carries an unbounded value into a signal.
 *
 * Event names follow the existing `pancake_order.*` convention, and emission follows
 * `pancake-order-submit-runtime.ts`: one JSON object per line on stdout, which
 * `docs/decisions/0002-vps-production-infrastructure.md` names as the collected stream. The writer
 * is injectable so the shaping and the emission can both be asserted without capturing stdout.
 */

import {
  isBoundedPromotionIdentifier,
  type CampaignActivationError,
  type DraftInputError,
} from "../commerce/promotion-activation.ts";
import type { PromotionAdminFailure } from "../commerce/promotion-admin-feedback.ts";
import type { CampaignLifecycleStatus } from "../commerce/promotion-campaign-lifecycle.ts";
import type {
  CampaignRuntimeHealth,
  CampaignRuntimeStatus,
} from "../commerce/promotion-runtime-health.ts";
import type { RenderedQuoteProofRejection } from "../commerce/checkout-quote-proof.ts";
import type { BenefitQuoteSummary } from "../commerce/benefit-quote-summary.ts";

/**
 * Bounds the reason list so one malformed submission cannot turn a diagnostic into a flood.
 *
 * The vocabularies are small — twelve activation errors, five draft-input errors — but the arrays
 * are built per request and nothing in the type stops a caller repeating a code.
 */
export const MAX_REPORTED_ACTIVATION_ERRORS = 12;

/**
 * How many identifiers one signal may carry.
 *
 * A sample, not the set. Triage needs somewhere to start looking — the first conflicting campaign,
 * the first few unpriced variants — and the admin screen still holds the complete list for the
 * person who has to fix it. Ten keeps a log line readable and keeps a 2,000-variant campaign from
 * writing a 2,000-identifier line; `affectedCount` reports the real total so the sample is never
 * read as the whole.
 */
export const MAX_REPORTED_SIGNAL_IDENTIFIERS = 10;

/**
 * How many affected variant detail items one runtime health signal may carry.
 *
 * Each item contains a variant ID, pricing failure reason, and conflicting campaign IDs.
 * Five items provides immediate triage context while keeping the JSON line well below 1 KB.
 */
export const MAX_REPORTED_HEALTH_SAMPLE = 5;

/**
 * How many conflicting campaign IDs one affected variant in a runtime health signal may carry.
 *
 * Three IDs provides immediate triage context on competing promotions while ensuring the
 * complete JSON line remains strictly below 1 KB even with 5 sampled variants.
 */
export const MAX_REPORTED_HEALTH_CONFLICTS = 3;

/**
 * Which admin operation produced the signal.
 *
 * A closed set matching the Server Actions in `src/app/admin/promotions/actions.ts`, so the value
 * is chosen at the call site rather than derived from request input.
 */
export const PROMOTION_ACTIVATION_OPERATIONS = [
  "publish",
  "disable",
  "end-early",
  "copy",
  "create",
  "edit",
] as const;

export type PromotionActivationOperation = (typeof PROMOTION_ACTIVATION_OPERATIONS)[number];

/**
 * The state of `LA_PROMOTION_ACTIVATION_ENABLED` in the process serving one gate-governed request.
 *
 * Emitted by the operation itself — see `reportActivationGate` in `promotion-admin-operation.ts` —
 * because whether the gate has any bearing is a runtime-branch fact, not a property of the action
 * label: `edit` reaches the gated service function only for a Scheduled campaign.
 */
export type PromotionActivationGateSignal = Readonly<{
  name: "promotion.activation_gate";
  operation: PromotionActivationOperation;
  enabled: boolean;
}>;

/** Context common to every rejection, present only when it is known and within bounds. */
type RejectionContext = Readonly<{ campaignId?: string }>;

export type PromotionActivationRejectionSignal = Readonly<
  {
    name: "promotion.activation_rejected";
    operation: PromotionActivationOperation;
  } & RejectionContext &
    (
      | {
          reason: Exclude<
            PromotionAdminFailure["reason"],
            | "ILLEGAL_TRANSITION"
            | "INVALID_CAMPAIGN"
            | "INVALID_DRAFT_INPUT"
            | "NO_EFFECTIVE_DISCOUNT"
            | "UNUSABLE_BASE_PRICE"
            | "OVERLAPPING_CAMPAIGN"
          >;
        }
      | { reason: "ILLEGAL_TRANSITION"; from: CampaignLifecycleStatus }
      | { reason: "INVALID_CAMPAIGN"; errors: readonly CampaignActivationError[] }
      | { reason: "INVALID_DRAFT_INPUT"; errors: readonly DraftInputError[] }
      /** `affectedCount` is the untruncated total; the array is a bounded sample of it. */
      | {
          reason: "NO_EFFECTIVE_DISCOUNT";
          affectedCount: number;
          invalidVariantIds: readonly string[];
        }
      | { reason: "UNUSABLE_BASE_PRICE"; affectedCount: number; variantIds: readonly string[] }
      | {
          reason: "OVERLAPPING_CAMPAIGN";
          affectedCount: number;
          conflictingCampaignIds: readonly string[];
        }
    )
>;

export type PromotionRuntimeHealthSampleItem = Readonly<{
  variantId: string;
  reason: string | null;
  conflictingCampaignIds: readonly string[];
}>;

export type PromotionRuntimeHealthSignal = Readonly<{
  name: "promotion.runtime_health";
  campaignId: string;
  status: CampaignRuntimeStatus;
  coveredVariants: number;
  discountedVariants: number;
  affectedVariants: number;
  affectedTruncated: boolean;
  affectedSample: readonly PromotionRuntimeHealthSampleItem[];
}>;

export type RenderedQuoteProofRejectionSignal = Readonly<{
  name: "checkout.quote_proof_rejected";
  phase: "rendered_quote_verification";
  reason: RenderedQuoteProofRejection;
}>;

/**
 * GQ24 -- the closed vocabulary of buyer-visible benefit checkout outcomes that stop or redirect a
 * submit before anything reaches Pancake. POS-side outcomes (rejected, unknown, drift, requote,
 * withheld) are the existing `pancake_order.*` events, tagged `benefit: true`.
 */
export const BENEFIT_CHECKOUT_OUTCOMES = [
  "QUOTE_STALE",
  "NONCLAIM_UNACKNOWLEDGED",
  "GIFT_SELECTION_INVALID",
  "CHECKOUT_UNAVAILABLE",
  "VENDOR_PROJECTION_INFEASIBLE",
] as const;
export type BenefitCheckoutOutcome = (typeof BENEFIT_CHECKOUT_OUTCOMES)[number];

export type BenefitCheckoutOutcomeSignal = Readonly<{
  name: "benefit.checkout_outcome";
  outcome: BenefitCheckoutOutcome;
  /** Why the proof failed, when the outcome is a proof failure; the same bounded vocabulary as the legacy signal. */
  proofReason?: RenderedQuoteProofRejection;
}>;

export type BenefitQuoteSummarySignal = Readonly<{ name: "benefit.quote_summary" } & BenefitQuoteSummary>;

export type PromotionObservabilitySignal =
  | BenefitCheckoutOutcomeSignal
  | BenefitQuoteSummarySignal
  | PromotionActivationGateSignal
  | PromotionActivationRejectionSignal
  | PromotionRuntimeHealthSignal
  | RenderedQuoteProofRejectionSignal;

export function describeActivationGate({
  operation,
  enabled,
}: Readonly<{
  operation: PromotionActivationOperation;
  enabled: boolean;
}>): PromotionActivationGateSignal {
  return Object.freeze({ name: "promotion.activation_gate", operation, enabled });
}

function boundedReasons<Reason>(reasons: readonly Reason[]): readonly Reason[] {
  return Object.freeze(reasons.slice(0, MAX_REPORTED_ACTIVATION_ERRORS));
}

/**
 * A bounded sample of identifiers.
 *
 * Each candidate passes the same length bound the admin surface applies before any lookup, so an
 * identifier that was never legal input cannot reach a log line by riding inside a failure payload.
 * One that fails the bound is dropped from the sample and still counted in the total.
 */
function boundedIdentifiers(ids: readonly string[]): readonly string[] {
  const sample: string[] = [];
  for (const id of ids) {
    if (sample.length >= MAX_REPORTED_SIGNAL_IDENTIFIERS) break;
    if (isBoundedPromotionIdentifier(id)) sample.push(id);
  }
  return Object.freeze(sample);
}

function boundedHealthConflicts(ids: readonly string[]): readonly string[] {
  const sample: string[] = [];
  for (const id of ids) {
    if (sample.length >= MAX_REPORTED_HEALTH_CONFLICTS) break;
    if (isBoundedPromotionIdentifier(id)) sample.push(id);
  }
  return Object.freeze(sample);
}

/**
 * The campaign the operation acted on, when it is known and legal.
 *
 * For the operations that take one, this value is raw browser input: the same string the service
 * refuses before it opens a transaction. It is bounded here for the same reason, and omitted rather
 * than truncated when it fails — a truncated identifier reads like a real one.
 */
function rejectionContext(campaignId: string | undefined): RejectionContext {
  if (campaignId === undefined) return {};
  const trimmed = campaignId.trim();
  return isBoundedPromotionIdentifier(trimmed) ? { campaignId: trimmed } : {};
}

/**
 * Reduces one activation failure to a signal safe to write to stdout.
 *
 * The switch is exhaustive over `PromotionAdminFailure["reason"]`, so a reason added to that union
 * stops compiling here rather than silently emitting nothing — the failure mode of a catch-all
 * default is a new rejection class that is invisible in production for as long as nobody notices.
 */
export function describeActivationRejection({
  operation,
  failure,
  campaignId,
}: Readonly<{
  operation: PromotionActivationOperation;
  failure: PromotionAdminFailure;
  campaignId?: string;
}>): PromotionActivationRejectionSignal {
  const name = "promotion.activation_rejected" as const;
  const context = rejectionContext(campaignId);

  switch (failure.reason) {
    case "ACTIVATION_DISABLED":
    case "CAMPAIGN_NOT_FOUND":
    case "TARGET_EXPANSION_LIMIT_EXCEEDED":
    case "DUPLICATE_TARGET":
    case "MALFORMED_FIXED_PRICE":
    case "INVALID_PERCENTAGE":
    case "INVALID_CAMPAIGN_KIND":
    case "INVALID_DISCOUNT_TYPE":
    case "INVALID_DATE_TIME":
    case "FORBIDDEN":
      return Object.freeze({ name, operation, ...context, reason: failure.reason });

    case "ILLEGAL_TRANSITION":
      // The lifecycle status is a closed vocabulary, not an identifier.
      return Object.freeze({
        name,
        operation,
        ...context,
        reason: failure.reason,
        from: failure.from,
      });

    case "INVALID_CAMPAIGN":
      return Object.freeze({
        name,
        operation,
        ...context,
        reason: failure.reason,
        errors: boundedReasons(failure.errors),
      });

    case "INVALID_DRAFT_INPUT":
      return Object.freeze({
        name,
        operation,
        ...context,
        reason: failure.reason,
        errors: boundedReasons(failure.errors),
      });

    case "NO_EFFECTIVE_DISCOUNT":
      return Object.freeze({
        name,
        operation,
        ...context,
        reason: failure.reason,
        affectedCount: failure.invalidVariantIds.length,
        invalidVariantIds: boundedIdentifiers(failure.invalidVariantIds),
      });

    case "UNUSABLE_BASE_PRICE":
      return Object.freeze({
        name,
        operation,
        ...context,
        reason: failure.reason,
        affectedCount: failure.variantIds.length,
        variantIds: boundedIdentifiers(failure.variantIds),
      });

    case "OVERLAPPING_CAMPAIGN":
      return Object.freeze({
        name,
        operation,
        ...context,
        reason: failure.reason,
        affectedCount: failure.conflictingCampaignIds.length,
        conflictingCampaignIds: boundedIdentifiers(failure.conflictingCampaignIds),
      });
  }
}

/**
 * Reduces runtime campaign health to a bounded signal safe to emit to stdout.
 *
 * Health diagnostics report why variants fail or recover at runtime (e.g. PARTIALLY_INVALID,
 * FULLY_INVALID). Affected variants are sampled up to MAX_REPORTED_SIGNAL_IDENTIFIERS (10)
 * with individual identifiers bounded. Prices and customer data are never carried.
 */
export function describeCampaignRuntimeHealth(
  health: CampaignRuntimeHealth,
): PromotionRuntimeHealthSignal {
  const boundedSample: PromotionRuntimeHealthSampleItem[] = [];
  for (const item of health.affected) {
    if (boundedSample.length >= MAX_REPORTED_HEALTH_SAMPLE) break;
    if (isBoundedPromotionIdentifier(item.variantId)) {
      boundedSample.push(
        Object.freeze({
          variantId: item.variantId,
          reason: item.reason,
          conflictingCampaignIds: boundedHealthConflicts(item.conflictingCampaignIds),
        }),
      );
    }
  }

  const campaignId = isBoundedPromotionIdentifier(health.campaignId.trim())
    ? health.campaignId.trim()
    : "";

  return Object.freeze({
    name: "promotion.runtime_health",
    campaignId,
    status: health.status,
    coveredVariants: health.coveredVariants,
    discountedVariants: health.discountedVariants,
    affectedVariants: health.affectedVariants,
    affectedTruncated:
      health.affectedTruncated || health.affected.length > boundedSample.length,
    affectedSample: Object.freeze(boundedSample),
  });
}

/**
 * Describes a rendered quote proof rejection during the checkout snapshot phase (P9a).
 *
 * Distinguishes the checkout snapshot phase ("rendered_quote_verification") from the downstream
 * catalog re-verification phase ("catalog_submission" via pancake_order.quote_repriced).
 * Zero proof tokens, MAC signatures, cart UUIDs or customer PII are logged.
 */
export function describeRenderedQuoteProofRejection({
  reason,
}: Readonly<{
  reason: RenderedQuoteProofRejection;
}>): RenderedQuoteProofRejectionSignal {
  return Object.freeze({
    name: "checkout.quote_proof_rejected",
    phase: "rendered_quote_verification",
    reason,
  });
}

export function describeBenefitCheckoutOutcome({
  outcome,
  proofReason,
}: Readonly<{ outcome: BenefitCheckoutOutcome; proofReason?: RenderedQuoteProofRejection }>): BenefitCheckoutOutcomeSignal {
  return Object.freeze({
    name: "benefit.checkout_outcome" as const,
    outcome,
    ...(proofReason === undefined ? {} : { proofReason }),
  });
}

/** Counts only, each clamped to a small non-negative integer so a malformed input cannot widen a log line. */
export function describeBenefitQuoteSummary(summary: BenefitQuoteSummary): BenefitQuoteSummarySignal {
  const bounded = (value: number) => (Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 100_000) : 0);
  return Object.freeze({
    name: "benefit.quote_summary" as const,
    paidLines: bounded(summary.paidLines),
    giftLines: bounded(summary.giftLines),
    stackConflicts: bounded(summary.stackConflicts),
    tierPriceInvalid: bounded(summary.tierPriceInvalid),
    tierConfigInvalid: bounded(summary.tierConfigInvalid),
    entitledSlots: bounded(summary.entitledSlots),
    selectedSlots: bounded(summary.selectedSlots),
    unclaimedSlots: bounded(summary.unclaimedSlots),
    stockShortSlots: bounded(summary.stockShortSlots),
  });
}

/** Where a signal is written. Injectable so tests assert real emission rather than a spy on stdout. */
export type PromotionSignalWriter = (line: string) => void;

function writeToStdout(line: string): void {
  process.stdout.write(line);
}

/** Maximum allowed UTF-8 bytes for an emitted NDJSON signal line, strictly below 1024 bytes. */
export const MAX_SIGNAL_UTF8_BYTES = 1024;

/**
 * Truncates a string by Unicode code points to avoid splitting surrogate pairs or multibyte characters.
 */
function safeTruncateUnicode(str: string, maxCodePoints: number): string {
  const chars = Array.from(str);
  if (chars.length <= maxCodePoints) return str;
  return chars.slice(0, maxCodePoints).join("");
}

/**
 * Produces a structurally reduced version of the signal to bring its serialized size under budget.
 */
function normalizeSignalForBudget(
  signal: PromotionObservabilitySignal,
): Record<string, unknown> {
  switch (signal.name) {
    case "promotion.runtime_health": {
      const sample = signal.affectedSample.slice(0, 1).map((item) => ({
        variantId: safeTruncateUnicode(item.variantId, 48),
        reason: item.reason,
        conflictingCampaignIds: item.conflictingCampaignIds
          .slice(0, 1)
          .map((id) => safeTruncateUnicode(id, 48)),
      }));

      return {
        name: signal.name,
        campaignId: safeTruncateUnicode(signal.campaignId, 48),
        status: signal.status,
        coveredVariants: signal.coveredVariants,
        discountedVariants: signal.discountedVariants,
        affectedVariants: signal.affectedVariants,
        affectedTruncated: true,
        affectedSample: sample,
      };
    }

    case "promotion.activation_rejected": {
      const base: Record<string, unknown> = {
        name: signal.name,
        operation: signal.operation,
        reason: signal.reason,
      };
      if (signal.campaignId) {
        base.campaignId = safeTruncateUnicode(signal.campaignId, 48);
      }
      if ("affectedCount" in signal) {
        base.affectedCount = signal.affectedCount;
      }
      if ("from" in signal) {
        base.from = signal.from;
      }
      if ("invalidVariantIds" in signal) {
        base.invalidVariantIds = signal.invalidVariantIds
          .slice(0, 2)
          .map((id) => safeTruncateUnicode(id, 48));
      } else if ("variantIds" in signal) {
        base.variantIds = signal.variantIds
          .slice(0, 2)
          .map((id) => safeTruncateUnicode(id, 48));
      } else if ("conflictingCampaignIds" in signal) {
        base.conflictingCampaignIds = signal.conflictingCampaignIds
          .slice(0, 2)
          .map((id) => safeTruncateUnicode(id, 48));
      } else if ("errors" in signal) {
        base.errors = signal.errors.slice(0, 3);
      }
      return base;
    }

    case "promotion.activation_gate":
      return {
        name: signal.name,
        operation: signal.operation,
        enabled: signal.enabled,
      };

    case "benefit.checkout_outcome":
    case "benefit.quote_summary":
      // Fixed-shape, counts and enum values only: already far below the budget.
      return { ...signal };

    case "checkout.quote_proof_rejected":
      return {
        name: signal.name,
        phase: signal.phase,
        reason: signal.reason,
      };
  }
}

/**
 * Minimal semantic fallback guaranteed to fit well within 1024 UTF-8 bytes (<256 bytes typical),
 * retaining all essential diagnostic fields (event name, status, reason, bounded allowlisted identifiers).
 */
function minimalFallbackSignal(
  signal: PromotionObservabilitySignal,
): Record<string, unknown> {
  switch (signal.name) {
    case "promotion.runtime_health":
      return {
        name: signal.name,
        campaignId: safeTruncateUnicode(signal.campaignId, 32),
        status: signal.status,
        coveredVariants: signal.coveredVariants,
        discountedVariants: signal.discountedVariants,
        affectedVariants: signal.affectedVariants,
        affectedTruncated: true,
        affectedSample: [],
      };

    case "promotion.activation_rejected": {
      const result: Record<string, unknown> = {
        name: signal.name,
        operation: signal.operation,
        reason: signal.reason,
      };
      if (signal.campaignId) {
        result.campaignId = safeTruncateUnicode(signal.campaignId, 32);
      }
      if ("affectedCount" in signal) {
        result.affectedCount = signal.affectedCount;
      }
      if ("from" in signal) {
        result.from = signal.from;
      }
      return result;
    }

    case "promotion.activation_gate":
      return {
        name: signal.name,
        operation: signal.operation,
        enabled: signal.enabled,
      };

    case "benefit.checkout_outcome":
    case "benefit.quote_summary":
      // Fixed-shape, counts and enum values only: already far below the budget.
      return { ...signal };

    case "checkout.quote_proof_rejected":
      return {
        name: signal.name,
        phase: signal.phase,
        reason: signal.reason,
      };
  }
}

/**
 * Serializes a promotion signal into an NDJSON line strictly under 1024 UTF-8 bytes.
 * Uses structural normalization and semantic fallback without raw byte slicing.
 */
export function serializePromotionSignal(signal: PromotionObservabilitySignal): string {
  try {
    const raw = `${JSON.stringify(signal)}\n`;
    if (Buffer.byteLength(raw, "utf8") < MAX_SIGNAL_UTF8_BYTES) {
      return raw;
    }

    const normalized = normalizeSignalForBudget(signal);
    const normalizedJson = `${JSON.stringify(normalized)}\n`;
    if (Buffer.byteLength(normalizedJson, "utf8") < MAX_SIGNAL_UTF8_BYTES) {
      return normalizedJson;
    }

    const minimal = minimalFallbackSignal(signal);
    const minimalJson = `${JSON.stringify(minimal)}\n`;
    if (Buffer.byteLength(minimalJson, "utf8") < MAX_SIGNAL_UTF8_BYTES) {
      return minimalJson;
    }

    return `${JSON.stringify({ name: signal.name })}\n`;
  } catch {
    return `${JSON.stringify({ name: typeof signal?.name === "string" ? signal.name : "promotion.signal" })}\n`;
  }
}

/**
 * Writes one signal as a single JSON line strictly bounded to <1024 UTF-8 bytes.
 *
 * Failures are swallowed for the same reason `emitSafely` swallows them in `pancake-order-submit.ts`:
 * observability must never change an admin outcome. A promotion that was refused for a real reason
 * must not additionally fail because a log write did.
 */
export function emitPromotionSignal(
  signal: PromotionObservabilitySignal,
  write: PromotionSignalWriter = writeToStdout,
): void {
  try {
    const line = serializePromotionSignal(signal);
    if (Buffer.byteLength(line, "utf8") < MAX_SIGNAL_UTF8_BYTES) {
      write(line);
    }
  } catch {
    // Intentionally ignored: fail-open error isolation protecting business path.
  }
}
