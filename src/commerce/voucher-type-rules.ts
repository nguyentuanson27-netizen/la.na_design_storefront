import { normalizePromotionCampaignName } from "./promotion-campaign-name.ts";
import { normalizeVoucherCode, type VoucherIssuance, type VoucherRuleIssue, type VoucherVisibility } from "./voucher-rule-validation.ts";

/**
 * Voucher types (ADR 0020 D-2): what a valid type is, and the ladder rule between its tiers.
 *
 * Pure validation of untrusted input (the Admin form). It decides shape and bounds only; rows, locks and activation live in the Admin
 * service. A type has a name, a place in the stack (`priority`: smaller is applied first) and its distribution; a CODE type owns the one
 * code that unlocks all its tiers.
 */

export type VoucherTypeValues = Readonly<{
  name: string;
  priority: number;
  issuance: VoucherIssuance;
  visibility: VoucherVisibility;
  /** Canonical code, present exactly when `issuance` is CODE. */
  code: string | null;
}>;

export type VoucherTypeValidation =
  | Readonly<{ ok: true; value: VoucherTypeValues }>
  | Readonly<{ ok: false; issues: readonly VoucherRuleIssue[] }>;

export const MIN_VOUCHER_TYPE_PRIORITY = 1;
export const MAX_VOUCHER_TYPE_PRIORITY = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateVoucherType(input: unknown): VoucherTypeValidation {
  if (!isRecord(input)) return { ok: false, issues: [{ code: "input-invalid", field: "input" }] };
  const issues: VoucherRuleIssue[] = [];
  const issue = (code: string, field: string) => void issues.push({ code, field });

  const name = normalizePromotionCampaignName(input.name);
  if (!name.ok) issue("name-invalid", "name");

  const priority = input.priority;
  if (typeof priority !== "number" || !Number.isSafeInteger(priority) || priority < MIN_VOUCHER_TYPE_PRIORITY || priority > MAX_VOUCHER_TYPE_PRIORITY) {
    issue("type-priority-invalid", "priority");
  }

  const issuance = input.issuance;
  if (issuance !== "AUTO" && issuance !== "CODE") issue("issuance-invalid", "issuance");
  const visibility = input.visibility;
  if (visibility !== "PUBLIC" && visibility !== "PRIVATE") issue("visibility-invalid", "visibility");
  if (issuance === "AUTO" && visibility === "PRIVATE") issue("private-requires-code", "visibility");

  let code: string | null = null;
  const absent = input.code === undefined || input.code === null;
  if (issuance === "CODE") {
    code = normalizeVoucherCode(input.code);
    if (code === null) issue(absent ? "code-required" : "code-invalid", "code");
  } else if (issuance === "AUTO" && !absent) {
    issue("code-not-allowed", "code");
  }

  if (issues.length > 0 || !name.ok) return { ok: false, issues };
  return {
    ok: true,
    value: Object.freeze({ name: name.name, priority: priority as number, issuance: issuance as VoucherIssuance, visibility: visibility as VoucherVisibility, code }),
  };
}

/** The slice of a tier the ladder rule looks at. */
export type LadderTier = Readonly<{
  id: string;
  minEligibleSubtotalVnd: number | null;
  discount: Readonly<{ type: "FIXED_AMOUNT_VND"; amountVnd: number }> | Readonly<{ type: "PERCENTAGE"; percent: number; maxDiscountVnd: number | null }> | null;
  /** A canonical string of the scope, so two tiers with the same scope compare equal. */
  scopeKey: string;
}>;

const CAP_UNLIMITED = Number.POSITIVE_INFINITY;

/**
 * Does the rung with the HIGHER threshold (`high`) always save the shopper at least as much as the lower one, and more somewhere?
 * A fixed amount: strictly more. A percentage saves `min(round(E x percent / 100), cap)` on the in-scope subtotal E, so it is only
 * never worse when BOTH the percent and the cap are not lower (no cap is the highest cap), and better when either is higher.
 * A rung that is better on small carts but capped lower on big ones would make AUTO pick the lower rung where the higher one is
 * reached, so it is refused rather than left to surprise the shopper.
 */
function higherRungBeats(high: NonNullable<LadderTier["discount"]>, low: NonNullable<LadderTier["discount"]>): boolean {
  if (high.type === "FIXED_AMOUNT_VND" && low.type === "FIXED_AMOUNT_VND") return high.amountVnd > low.amountVnd;
  if (high.type === "PERCENTAGE" && low.type === "PERCENTAGE") {
    const highCap = high.maxDiscountVnd ?? CAP_UNLIMITED;
    const lowCap = low.maxDiscountVnd ?? CAP_UNLIMITED;
    return high.percent >= low.percent && highCap >= lowCap && (high.percent > low.percent || highCap > lowCap);
  }
  return true;
}

/**
 * The ladder rule (ADR 0020 D-7): between two tiers of one type that have the same scope and the same kind of discount, a higher
 * threshold must give a discount that is never lower and somewhere higher (see `higherRungBeats`), and no two share a threshold --
 * otherwise the lower rung can never be reached (it is always beaten) or the higher one is pointless. Tiers of different scope or
 * discount kind are not compared: the optimizer evaluates them as they are. Returns the id of the first tier `candidate`
 * conflicts with, or null.
 */
export function findLadderConflict(candidate: LadderTier, others: readonly LadderTier[]): string | null {
  if (candidate.discount === null) return null;
  const threshold = candidate.minEligibleSubtotalVnd ?? 0;
  for (const other of others) {
    if (other.id === candidate.id || other.scopeKey !== candidate.scopeKey || other.discount === null || other.discount.type !== candidate.discount.type) continue;
    const theirThreshold = other.minEligibleSubtotalVnd ?? 0;
    if (theirThreshold === threshold) return other.id;
    const candidateIsHigher = threshold > theirThreshold;
    if (!higherRungBeats(candidateIsHigher ? candidate.discount : other.discount, candidateIsHigher ? other.discount : candidate.discount)) return other.id;
  }
  return null;
}
