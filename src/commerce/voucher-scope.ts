import { categoryByKey } from "./category-taxonomy.ts";
import { expandScopeCategoryKeys } from "./gift-quantity-scope.ts";

/**
 * Voucher v1 (V01): which paid products a voucher looks at (spec §3.3).
 *
 * Pure and storage-free. Deliberately a separate resolver from `gift-quantity-scope.ts`: that module's
 * `GLOBAL_ALL_PAID_LINES` refuses every target on purpose, while a voucher needs `ALL_SHOP` together
 * with an exclude list. Only the category expansion (`expandScopeCategoryKeys`) is shared, so a voucher
 * agrees with the listing page and with Gift & Quantity about what a parent category covers.
 *
 *   - ALL_SHOP:  in the shop AND NOT excluded.
 *   - TARGETED:  in the shop AND (category match OR explicitly included) AND NOT excluded.
 *
 * Exclusion always wins. Membership is read at evaluation time from the facts the caller supplies, so a
 * product that joins a category later is covered without republishing the voucher.
 */

export const VOUCHER_SCOPE_ALL_SHOP = "ALL_SHOP" as const;
export const VOUCHER_SCOPE_TARGETED = "TARGETED" as const;

export const MAX_VOUCHER_SCOPE_CATEGORIES = 50;
export const MAX_VOUCHER_SCOPE_INCLUDED_PRODUCTS = 500;
export const MAX_VOUCHER_SCOPE_EXCLUDED_PRODUCTS = 500;
const MAX_ID_LENGTH = 64;

export type VoucherScopeConfig =
  | Readonly<{ mode: typeof VOUCHER_SCOPE_ALL_SHOP; excludeProductIds: readonly string[] }>
  | Readonly<{
      mode: typeof VOUCHER_SCOPE_TARGETED;
      categoryKeys: readonly string[];
      includeProductIds: readonly string[];
      excludeProductIds: readonly string[];
    }>;

export type VoucherScopeIssueCode =
  | "scope-mode-invalid"
  | "scope-all-shop-with-targets"
  | "scope-empty"
  | "scope-category-unknown"
  | "scope-category-too-many"
  | "scope-included-too-many"
  | "scope-excluded-too-many"
  | "scope-product-id-invalid"
  | "scope-duplicate-entry";

export type VoucherScopeIssue = Readonly<{ code: VoucherScopeIssueCode; field: string }>;

export type VoucherScopeValidation =
  | Readonly<{ ok: true; scope: VoucherScopeConfig }>
  | Readonly<{ ok: false; issues: readonly VoucherScopeIssue[] }>;

/** What the resolver knows about a product. `shopId` is the product's own shop, never client data. */
export type VoucherProductFacts = Readonly<{
  productId: string;
  shopId: string;
  categoryKeys: readonly string[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasEntries(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null;
}

function normalizeIdList(
  value: unknown,
  field: string,
  max: number,
  tooMany: VoucherScopeIssueCode,
  issues: VoucherScopeIssue[],
): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    issues.push({ code: "scope-product-id-invalid", field });
    return [];
  }
  if (value.length > max) {
    issues.push({ code: tooMany, field });
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > MAX_ID_LENGTH || entry.trim() !== entry) {
      issues.push({ code: "scope-product-id-invalid", field });
    } else if (seen.has(entry)) {
      issues.push({ code: "scope-duplicate-entry", field });
    } else {
      seen.add(entry);
      out.push(entry);
    }
  }
  return out;
}

/** Validates and normalizes untrusted scope input; exclude wins, so an excluded include is dropped. */
export function validateVoucherScope(input: unknown): VoucherScopeValidation {
  if (!isRecord(input)) return { ok: false, issues: [{ code: "scope-mode-invalid", field: "scope" }] };
  const issues: VoucherScopeIssue[] = [];

  if (input.mode === VOUCHER_SCOPE_ALL_SHOP) {
    // Categories and includes next to ALL_SHOP are redundant and ambiguous (spec §3.3): refuse them.
    if (hasEntries(input.categoryKeys) || hasEntries(input.includeProductIds)) {
      return { ok: false, issues: [{ code: "scope-all-shop-with-targets", field: "scope" }] };
    }
    const excludeProductIds = normalizeIdList(
      input.excludeProductIds,
      "excludeProductIds",
      MAX_VOUCHER_SCOPE_EXCLUDED_PRODUCTS,
      "scope-excluded-too-many",
      issues,
    );
    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, scope: Object.freeze({ mode: VOUCHER_SCOPE_ALL_SHOP, excludeProductIds: Object.freeze(excludeProductIds) }) };
  }

  if (input.mode !== VOUCHER_SCOPE_TARGETED) {
    return { ok: false, issues: [{ code: "scope-mode-invalid", field: "mode" }] };
  }

  const categoryKeys: string[] = [];
  const rawCategories = input.categoryKeys ?? [];
  if (!Array.isArray(rawCategories)) {
    issues.push({ code: "scope-category-unknown", field: "categoryKeys" });
  } else if (rawCategories.length > MAX_VOUCHER_SCOPE_CATEGORIES) {
    issues.push({ code: "scope-category-too-many", field: "categoryKeys" });
  } else {
    const seen = new Set<string>();
    for (const key of rawCategories) {
      if (typeof key !== "string" || categoryByKey(key) === null) {
        issues.push({ code: "scope-category-unknown", field: "categoryKeys" });
      } else if (seen.has(key)) {
        issues.push({ code: "scope-duplicate-entry", field: "categoryKeys" });
      } else {
        seen.add(key);
        categoryKeys.push(key);
      }
    }
  }

  const includeProductIds = normalizeIdList(
    input.includeProductIds,
    "includeProductIds",
    MAX_VOUCHER_SCOPE_INCLUDED_PRODUCTS,
    "scope-included-too-many",
    issues,
  );
  const excludeProductIds = normalizeIdList(
    input.excludeProductIds,
    "excludeProductIds",
    MAX_VOUCHER_SCOPE_EXCLUDED_PRODUCTS,
    "scope-excluded-too-many",
    issues,
  );

  const excluded = new Set(excludeProductIds);
  const effectiveIncludes = includeProductIds.filter((id) => !excluded.has(id));
  // A targeted scope that selects nothing (only exclusions) would never match a line.
  if (categoryKeys.length === 0 && effectiveIncludes.length === 0 && issues.length === 0) {
    issues.push({ code: "scope-empty", field: "scope" });
  }
  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    scope: Object.freeze({
      mode: VOUCHER_SCOPE_TARGETED,
      categoryKeys: Object.freeze(categoryKeys),
      includeProductIds: Object.freeze(effectiveIncludes),
      excludeProductIds: Object.freeze(excludeProductIds),
    }),
  };
}

export type VoucherScopeResolver = (product: VoucherProductFacts) => boolean;

/**
 * Builds the membership predicate for one shop. A product of another shop never matches, whatever its
 * id or categories say; the shop comes from the campaign row, not from the request.
 */
export function buildVoucherScopeResolver(scope: VoucherScopeConfig, shopId: string): VoucherScopeResolver {
  const excluded = new Set(scope.excludeProductIds);
  if (scope.mode === VOUCHER_SCOPE_ALL_SHOP) {
    return (product) => product.shopId === shopId && !excluded.has(product.productId);
  }
  const covered = expandScopeCategoryKeys(scope.categoryKeys);
  const included = new Set(scope.includeProductIds);
  return (product) => {
    if (product.shopId !== shopId || excluded.has(product.productId)) return false;
    return included.has(product.productId) || product.categoryKeys.some((key) => covered.has(key));
  };
}
