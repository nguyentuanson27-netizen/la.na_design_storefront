import { normalizePromotionCampaignName } from "./promotion-campaign-name.ts";
import { validateVoucherScope, type VoucherScopeConfig } from "./voucher-scope.ts";

/**
 * Voucher v1 (V01): what a valid voucher campaign is (spec §3.1).
 *
 * Pure validation of untrusted input (admin form fields, or a persisted row being re-read). It decides
 * shape and bounds only; rows, locks and activation live in the admin service. The result is either the
 * normalized, frozen values or every issue found, so an admin sees all problems in one round trip.
 */

export type VoucherKind = "MERCHANDISE" | "SHIPPING_FREE";
export type VoucherIssuance = "AUTO" | "CODE";
export type VoucherVisibility = "PUBLIC" | "PRIVATE";

export type VoucherDiscount =
  | Readonly<{ type: "FIXED_AMOUNT_VND"; amountVnd: number }>
  | Readonly<{ type: "PERCENTAGE"; percent: number; maxDiscountVnd: number | null }>;

export type VoucherCampaignValues = Readonly<{
  name: string;
  kind: VoucherKind;
  issuance: VoucherIssuance;
  visibility: VoucherVisibility;
  /** Canonical code, present exactly when `issuance` is CODE. */
  code: string | null;
  /** Present exactly when `kind` is MERCHANDISE. SHIPPING_FREE always waives 100% of the remaining fee. */
  discount: VoucherDiscount | null;
  /** Threshold on the in-scope paid subtotal before this voucher, shipping excluded. */
  minEligibleSubtotalVnd: number | null;
  scope: VoucherScopeConfig;
  startsAt: Date | null;
  endsAt: Date | null;
  /** Total redemptions across all shoppers; null means unlimited. */
  maxUses: number | null;
  maxBudgetVnd: number | null;
}>;

export type VoucherRuleIssue = Readonly<{ code: string; field: string }>;

export type VoucherRuleValidation =
  | Readonly<{ ok: true; value: VoucherCampaignValues }>
  | Readonly<{ ok: false; issues: readonly VoucherRuleIssue[] }>;

/** Bounds keep persisted payloads and BigInt-free money paths inside the safe-integer range. */
export const MAX_VOUCHER_VND = 100_000_000_000;
export const MAX_VOUCHER_BUDGET_VND = 1_000_000_000_000;
export const MAX_VOUCHER_USES = 100_000_000;
export const MIN_VOUCHER_PERCENT = 1;
export const MAX_VOUCHER_PERCENT = 99;

const CODE_PATTERN = /^[A-Z0-9_-]{3,32}$/;

/**
 * Canonical form of a voucher code: trimmed, upper-cased, `[A-Z0-9_-]{3,32}`. Returns null for anything
 * else. A code is a distribution tool, not an identity check, so this only bounds and normalizes it.
 */
export function normalizeVoucherCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return CODE_PATTERN.test(code) ? code : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMoney(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= max;
}

function isOptionalDate(value: unknown): value is Date | null {
  return value === null || (value instanceof Date && Number.isFinite(value.getTime()));
}

function absent(value: unknown): boolean {
  return value === undefined || value === null;
}

export function validateVoucherCampaign(input: unknown): VoucherRuleValidation {
  if (!isRecord(input)) return { ok: false, issues: [{ code: "input-invalid", field: "input" }] };
  const issues: VoucherRuleIssue[] = [];
  const issue = (code: string, field: string) => void issues.push({ code, field });

  const name = normalizePromotionCampaignName(input.name);
  if (!name.ok) issue("name-invalid", "name");

  const kind = input.kind;
  if (kind !== "MERCHANDISE" && kind !== "SHIPPING_FREE") issue("kind-invalid", "kind");
  const issuance = input.issuance;
  if (issuance !== "AUTO" && issuance !== "CODE") issue("issuance-invalid", "issuance");
  const visibility = input.visibility;
  if (visibility !== "PUBLIC" && visibility !== "PRIVATE") issue("visibility-invalid", "visibility");

  // PRIVATE needs a code to be reachable at all; AUTO is applied without one, so it must be public.
  if (issuance === "AUTO" && visibility === "PRIVATE") issue("private-requires-code", "visibility");

  let code: string | null = null;
  if (issuance === "CODE") {
    code = normalizeVoucherCode(input.code);
    if (code === null) issue(absent(input.code) ? "code-required" : "code-invalid", "code");
  } else if (issuance === "AUTO" && !absent(input.code)) {
    issue("code-not-allowed", "code");
  }

  const minimum = input.minEligibleSubtotalVnd;
  let minEligibleSubtotalVnd: number | null = null;
  if (!absent(minimum)) {
    if (isMoney(minimum, MAX_VOUCHER_VND)) minEligibleSubtotalVnd = minimum;
    else issue("min-subtotal-invalid", "minEligibleSubtotalVnd");
  }

  let discount: VoucherDiscount | null = null;
  if (kind === "SHIPPING_FREE") {
    if (!absent(input.discount)) issue("discount-not-allowed", "discount");
  } else if (kind === "MERCHANDISE") {
    discount = validateDiscount(input.discount, minEligibleSubtotalVnd, issue);
  }

  const scope = validateVoucherScope(input.scope);
  if (!scope.ok) for (const scopeIssue of scope.issues) issue(scopeIssue.code, `scope.${scopeIssue.field}`);

  const startsAt = input.startsAt ?? null;
  const endsAt = input.endsAt ?? null;
  if (!isOptionalDate(startsAt) || !isOptionalDate(endsAt) || (startsAt !== null && endsAt !== null && startsAt >= endsAt)) {
    issue("window-invalid", "window");
  }

  let maxUses: number | null = null;
  if (!absent(input.maxUses)) {
    if (typeof input.maxUses === "number" && Number.isSafeInteger(input.maxUses) && input.maxUses >= 1 && input.maxUses <= MAX_VOUCHER_USES) {
      maxUses = input.maxUses;
    } else issue("max-uses-invalid", "maxUses");
  }
  let maxBudgetVnd: number | null = null;
  if (!absent(input.maxBudgetVnd)) {
    if (isMoney(input.maxBudgetVnd, MAX_VOUCHER_BUDGET_VND)) maxBudgetVnd = input.maxBudgetVnd;
    else issue("max-budget-invalid", "maxBudgetVnd");
  }

  if (issues.length > 0 || !name.ok || !scope.ok) return { ok: false, issues };
  return {
    ok: true,
    value: Object.freeze({
      name: name.name,
      kind: kind as VoucherKind,
      issuance: issuance as VoucherIssuance,
      visibility: visibility as VoucherVisibility,
      code,
      discount,
      minEligibleSubtotalVnd,
      scope: scope.scope,
      startsAt: startsAt as Date | null,
      endsAt: endsAt as Date | null,
      maxUses,
      maxBudgetVnd,
    }),
  };
}

function validateDiscount(
  raw: unknown,
  minEligibleSubtotalVnd: number | null,
  issue: (code: string, field: string) => void,
): VoucherDiscount | null {
  if (!isRecord(raw)) {
    issue("discount-required", "discount");
    return null;
  }
  if (raw.type === "FIXED_AMOUNT_VND") {
    if (!absent(raw.percent) || !absent(raw.maxDiscountVnd)) issue("discount-fields-mismatch", "discount");
    if (!isMoney(raw.amountVnd, MAX_VOUCHER_VND)) {
      issue("fixed-amount-invalid", "discount.amountVnd");
      return null;
    }
    // A fixed discount must leave a positive payable amount, so the threshold is required and above it.
    if (minEligibleSubtotalVnd === null) {
      issue("fixed-min-required", "minEligibleSubtotalVnd");
    } else if (minEligibleSubtotalVnd <= raw.amountVnd) {
      issue("fixed-min-not-above-amount", "minEligibleSubtotalVnd");
    }
    return Object.freeze({ type: "FIXED_AMOUNT_VND" as const, amountVnd: raw.amountVnd });
  }
  if (raw.type === "PERCENTAGE") {
    if (!absent(raw.amountVnd)) issue("discount-fields-mismatch", "discount");
    const percent = raw.percent;
    if (typeof percent !== "number" || !Number.isSafeInteger(percent) || percent < MIN_VOUCHER_PERCENT || percent > MAX_VOUCHER_PERCENT) {
      issue("percent-invalid", "discount.percent");
      return null;
    }
    let maxDiscountVnd: number | null = null;
    if (!absent(raw.maxDiscountVnd)) {
      if (isMoney(raw.maxDiscountVnd, MAX_VOUCHER_VND)) maxDiscountVnd = raw.maxDiscountVnd;
      else issue("max-discount-invalid", "discount.maxDiscountVnd");
    }
    return Object.freeze({ type: "PERCENTAGE" as const, percent, maxDiscountVnd });
  }
  issue("discount-type-invalid", "discount.type");
  return null;
}
