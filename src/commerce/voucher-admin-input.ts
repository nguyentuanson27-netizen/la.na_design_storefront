import { parseStrictVietnamDateTime } from "./promotion-admin-input.ts";
import type { VoucherRuleIssue } from "./voucher-rule-validation.ts";

/**
 * Voucher v1 (V07): turns the Admin form's fields into the object `validateVoucherCampaign` checks.
 *
 * This is parsing only, never the contract: the service re-validates everything. A duplicated scalar field, a
 * file upload, a non-digit number or a malformed date is refused here so it can never become a second
 * authority for the value.
 */

export type VoucherFormParse =
  | Readonly<{ ok: true; input: Record<string, unknown> }>
  | Readonly<{ ok: false; issues: readonly VoucherRuleIssue[] }>;

/** One string value, "" when absent, or null when the field was repeated or is not text. */
function single(form: FormData, name: string): string | null {
  const values = form.getAll(name);
  return values.length === 0 ? "" : values.length === 1 && typeof values[0] === "string" ? values[0] : null;
}

/** "" -> null (optional and empty); digits only otherwise, so "1e3", "1.5" and "-1" are NaN and fail validation. */
function optionalWhole(raw: string | null, maxDigits: number): number | null {
  if (raw === null) return Number.NaN;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  return new RegExp(`^[1-9][0-9]{0,${maxDigits - 1}}$`).test(trimmed) ? Number(trimmed) : Number.NaN;
}

export function parseVoucherCampaignForm(form: FormData): VoucherFormParse {
  const startsRaw = single(form, "startsAt");
  const endsRaw = single(form, "endsAt");
  const starts = parseStrictVietnamDateTime(startsRaw);
  const ends = parseStrictVietnamDateTime(endsRaw);
  if (startsRaw === null || endsRaw === null || !starts.ok || !ends.ok) {
    return { ok: false, issues: [{ code: "window-invalid", field: "window" }] };
  }

  // A tier names the type it belongs to; blank is an ordinary voucher. A repeated field is refused like any other.
  const typeRaw = single(form, "typeId");
  if (typeRaw === null) return { ok: false, issues: [{ code: "type-invalid", field: "typeId" }] };

  const kind = single(form, "kind");
  const issuance = single(form, "issuance");
  const discountType = single(form, "discountType");
  const scopeMode = single(form, "scopeMode");

  const discount =
    kind === "SHIPPING_FREE"
      ? undefined
      : discountType === "FIXED_AMOUNT_VND"
        ? { type: "FIXED_AMOUNT_VND", amountVnd: optionalWhole(single(form, "amountVnd"), 12) ?? Number.NaN }
        : discountType === "PERCENTAGE"
          ? {
              type: "PERCENTAGE",
              percent: optionalWhole(single(form, "percent"), 2) ?? Number.NaN,
              maxDiscountVnd: optionalWhole(single(form, "maxDiscountVnd"), 12),
            }
          : { type: discountType };

  const excludeProductIds = form.getAll("excludeProductId");
  return {
    ok: true,
    input: {
      name: single(form, "name"),
      typeId: typeRaw.trim() === "" ? null : typeRaw.trim(),
      kind,
      issuance,
      visibility: single(form, "visibility"),
      code: issuance === "CODE" ? single(form, "code") : null,
      discount,
      minEligibleSubtotalVnd: optionalWhole(single(form, "minEligibleSubtotalVnd"), 12),
      scope:
        scopeMode === "TARGETED"
          ? { mode: "TARGETED", categoryKeys: form.getAll("categoryKey"), includeProductIds: form.getAll("includeProductId"), excludeProductIds }
          : { mode: scopeMode, excludeProductIds },
      startsAt: starts.date,
      endsAt: ends.date,
      maxUses: optionalWhole(single(form, "maxUses"), 9),
      maxBudgetVnd: optionalWhole(single(form, "maxBudgetVnd"), 13),
    },
  };
}

export function parseVoucherIdentity(form: FormData): { id: string; revision: number } | null {
  const id = single(form, "campaignId");
  const revision = single(form, "revision");
  if (id === null || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || revision === null || !/^[1-9][0-9]{0,9}$/.test(revision)) return null;
  const number = Number(revision);
  return number < 2_147_483_647 ? { id, revision: number } : null;
}

/** The new code typed on a Copy; null when absent or repeated. */
export function parseVoucherCopyCode(form: FormData): string | null {
  const raw = single(form, "code");
  return raw === null || raw.trim() === "" ? null : raw;
}

/** The Admin's type form: a name, the place in the stack, and the distribution. Parsing only; `validateVoucherType` is the contract. */
export function parseVoucherTypeForm(form: FormData): VoucherFormParse {
  const issuance = single(form, "issuance");
  return {
    ok: true,
    input: {
      name: single(form, "name"),
      priority: optionalWhole(single(form, "priority"), 4),
      issuance,
      visibility: single(form, "visibility"),
      code: issuance === "CODE" ? single(form, "code") : null,
    },
  };
}

/** The type being edited and the revision of the form's copy (the optimistic token); null when either is missing, repeated or malformed. */
export function parseVoucherTypeIdentity(form: FormData): { id: string; revision: number } | null {
  const id = single(form, "typeId");
  const revision = single(form, "revision");
  if (id === null || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || revision === null || !/^[1-9][0-9]{0,9}$/.test(revision)) return null;
  const number = Number(revision);
  return number < 2_147_483_647 ? { id, revision: number } : null;
}
