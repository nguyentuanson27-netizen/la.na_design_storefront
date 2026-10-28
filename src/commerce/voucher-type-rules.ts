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

/** The magnitude the ladder compares: the fixed amount, or the percent (a cap only lowers it, so it is compared as the percent). */
const magnitude = (tier: LadderTier): number | null => (tier.discount === null ? null : tier.discount.type === "FIXED_AMOUNT_VND" ? tier.discount.amountVnd : tier.discount.percent);

/**
 * The ladder rule (ADR 0020 D-7): between two tiers of one type that have the same scope and the same kind of discount, a higher
 * threshold must give a strictly higher discount, and no two share a threshold -- otherwise the lower rung can never be reached
 * (it is always beaten) or the higher one is pointless. Tiers of different scope or discount kind are not compared: the optimizer
 * evaluates them as they are. Returns the id of the first tier `candidate` conflicts with, or null.
 */
export function findLadderConflict(candidate: LadderTier, others: readonly LadderTier[]): string | null {
  const mine = magnitude(candidate);
  if (mine === null || candidate.discount === null) return null;
  const threshold = candidate.minEligibleSubtotalVnd ?? 0;
  for (const other of others) {
    if (other.id === candidate.id || other.scopeKey !== candidate.scopeKey || other.discount === null || other.discount.type !== candidate.discount.type) continue;
    const theirs = magnitude(other)!;
    const theirThreshold = other.minEligibleSubtotalVnd ?? 0;
    if (theirThreshold === threshold) return other.id;
    if (theirThreshold < threshold ? theirs >= mine : theirs <= mine) return other.id;
  }
  return null;
}
