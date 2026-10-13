import { categoryByKey, categoryListingKeys } from "./category-taxonomy.ts";

/**
 * Gift & Quantity Promotions v1 (GQ02): which paid lines a gift/tier campaign looks at.
 *
 * Pure and storage-free. It owns three decisions and nothing else:
 *   - the shape and bounds of a campaign scope (Dynamic / Fixed / Global),
 *   - whether one product is inside a scope (exclude always wins),
 *   - how the eligible quantity `Q` and subtotal `S` are summed from paid lines.
 *
 * Category hierarchy is NOT invented here (ADR 0016 D-07): choosing a parent category covers the
 * membership keys `categoryListingKeys` returns, exactly like a listing page, so the promotion
 * agrees with what the shopper sees on the PLP.
 */

export const GLOBAL_ALL_PAID_LINES = "GLOBAL_ALL_PAID_LINES" as const;
export const DYNAMIC_CATEGORY = "DYNAMIC_CATEGORY" as const;
export const FIXED_PRODUCT_SET = "FIXED_PRODUCT_SET" as const;

export type ScopeMode = typeof GLOBAL_ALL_PAID_LINES | typeof DYNAMIC_CATEGORY | typeof FIXED_PRODUCT_SET;

/** Bounds keep pricing cost and persisted payloads bounded no matter what an admin submits. */
export const MAX_SCOPE_CATEGORIES = 50;
export const MAX_SCOPE_INCLUDED_PRODUCTS = 500;
export const MAX_SCOPE_EXCLUDED_PRODUCTS = 500;
export const MAX_FROZEN_PRODUCTS = 5_000;
/** Bound on a single product id; `ProductMirror.id` is a cuid. */
const MAX_ID_LENGTH = 64;

/** The configured, editable part of a scope. */
export type ScopeConfig =
  | Readonly<{ mode: typeof GLOBAL_ALL_PAID_LINES }>
  | Readonly<{
      mode: typeof DYNAMIC_CATEGORY | typeof FIXED_PRODUCT_SET;
      categoryKeys: readonly string[];
      includeProductIds: readonly string[];
      excludeProductIds: readonly string[];
    }>;

/** The audit record written when a Fixed scope is frozen (GQ04 persists it). */
export type FrozenProductSet = Readonly<{
  productIds: readonly string[];
  frozenAt: Date;
  /** Campaign revision the snapshot was taken at. */
  campaignRevision: number;
}>;

export type ScopeIssueCode =
  | "scope-mode-invalid"
  | "scope-global-not-allowed"
  | "scope-global-with-targets"
  | "scope-empty"
  | "scope-category-unknown"
  | "scope-category-too-many"
  | "scope-included-too-many"
  | "scope-excluded-too-many"
  | "scope-product-id-invalid"
  | "scope-duplicate-entry"
  | "scope-frozen-too-many"
  | "scope-frozen-empty";

export type ScopeIssue = Readonly<{ code: ScopeIssueCode; field: string }>;

export type ScopeValidation =
  | Readonly<{ ok: true; scope: ScopeConfig }>
  | Readonly<{ ok: false; issues: readonly ScopeIssue[] }>;

export type ScopeContext = Readonly<{
  /**
   * True only for `GIFT_ITEM` + `ORDER_SUBTOTAL` + `ALL_PAID_LINES`. Every other campaign needs a
   * real scope, so the global scope is refused for them rather than silently covering the store.
   */
  allowGlobal: boolean;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeIdList(
  value: unknown,
  field: string,
  max: number,
  tooMany: ScopeIssueCode,
  issues: ScopeIssue[],
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
      continue;
    }
    if (seen.has(entry)) {
      issues.push({ code: "scope-duplicate-entry", field });
      continue;
    }
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

/**
 * Validates and normalizes untrusted scope input. The server calls this; the admin form's own
 * checks are a convenience, never the contract (spec FR-01).
 */
export function validateScopeConfig(input: unknown, context: ScopeContext): ScopeValidation {
  if (!isRecord(input)) return { ok: false, issues: [{ code: "scope-mode-invalid", field: "scope" }] };
  const mode = input.mode;
  const issues: ScopeIssue[] = [];

  if (mode === GLOBAL_ALL_PAID_LINES) {
    if (!context.allowGlobal) return { ok: false, issues: [{ code: "scope-global-not-allowed", field: "mode" }] };
    const hasTargets = ["categoryKeys", "includeProductIds", "excludeProductIds"].some((field) => {
      const value = input[field];
      return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null;
    });
    if (hasTargets) return { ok: false, issues: [{ code: "scope-global-with-targets", field: "scope" }] };
    return { ok: true, scope: Object.freeze({ mode: GLOBAL_ALL_PAID_LINES }) };
  }

  if (mode !== DYNAMIC_CATEGORY && mode !== FIXED_PRODUCT_SET) {
    return { ok: false, issues: [{ code: "scope-mode-invalid", field: "mode" }] };
  }

  // Categories are config identity: only approved taxonomy keys are accepted.
  const rawCategories = input.categoryKeys ?? [];
  const categoryKeys: string[] = [];
  if (!Array.isArray(rawCategories)) {
    issues.push({ code: "scope-category-unknown", field: "categoryKeys" });
  } else if (rawCategories.length > MAX_SCOPE_CATEGORIES) {
    issues.push({ code: "scope-category-too-many", field: "categoryKeys" });
  } else {
    const seen = new Set<string>();
    for (const key of rawCategories) {
      if (categoryByKey(key) === null) {
        issues.push({ code: "scope-category-unknown", field: "categoryKeys" });
      } else if (seen.has(key as string)) {
        issues.push({ code: "scope-duplicate-entry", field: "categoryKeys" });
      } else {
        seen.add(key as string);
        categoryKeys.push(key as string);
      }
    }
  }

  const includeProductIds = normalizeIdList(
    input.includeProductIds,
    "includeProductIds",
    MAX_SCOPE_INCLUDED_PRODUCTS,
    "scope-included-too-many",
    issues,
  );
  const excludeProductIds = normalizeIdList(
    input.excludeProductIds,
    "excludeProductIds",
    MAX_SCOPE_EXCLUDED_PRODUCTS,
    "scope-excluded-too-many",
    issues,
  );

  // Exclude wins (spec FR-01): a product named on both lists is excluded, so it is dropped from the
  // include list here, once, and every writer persists this normalized scope. The database keeps one
  // role per (campaign, product), so persisting both would be refused there.
  const effectiveIncludes = applyExcludeWins(includeProductIds, excludeProductIds);

  // A scope that selects nothing (only exclusions, or nothing at all) would never match a line.
  if (categoryKeys.length === 0 && effectiveIncludes.length === 0 && issues.length === 0) {
    issues.push({ code: "scope-empty", field: "scope" });
  }
  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    scope: Object.freeze({
      mode,
      categoryKeys: Object.freeze(categoryKeys),
      includeProductIds: Object.freeze(effectiveIncludes),
      excludeProductIds: Object.freeze(excludeProductIds),
    }),
  };
}

/** The include list without any product that is also excluded: exclude wins. Order is kept. */
export function applyExcludeWins(
  includeProductIds: readonly string[],
  excludeProductIds: readonly string[],
): string[] {
  const excluded = new Set(excludeProductIds);
  return includeProductIds.filter((id) => !excluded.has(id));
}

/** What the resolver knows about a product: its id and its persisted category membership keys. */
export type ScopeProductFacts = Readonly<{
  productId: string;
  categoryKeys: readonly string[];
}>;

/** Every membership key a set of selected categories covers (parent includes its descendants). */
export function expandScopeCategoryKeys(categoryKeys: readonly string[]): ReadonlySet<string> {
  const covered = new Set<string>();
  for (const key of categoryKeys) {
    for (const listingKey of categoryListingKeys(key)) covered.add(listingKey);
  }
  return covered;
}

/**
 * The selection rule shared by Dynamic evaluation and the Fixed freeze:
 * (in a selected category OR explicitly included) AND NOT explicitly excluded.
 */
function matchesSelection(
  product: ScopeProductFacts,
  coveredCategories: ReadonlySet<string>,
  included: ReadonlySet<string>,
  excluded: ReadonlySet<string>,
): boolean {
  if (excluded.has(product.productId)) return false;
  if (included.has(product.productId)) return true;
  return product.categoryKeys.some((key) => coveredCategories.has(key));
}

/**
 * Computes the product ids a Fixed scope freezes, from one consistent membership read. Pure: the
 * caller (GQ04, inside the publish transaction) supplies the snapshot and persists the result.
 * Returns an error rather than a truncated set when the bound is exceeded.
 */
export function computeFrozenProductIds(
  scope: ScopeConfig,
  products: readonly ScopeProductFacts[],
): Readonly<{ ok: true; productIds: readonly string[] }> | Readonly<{ ok: false; code: ScopeIssueCode }> {
  if (scope.mode !== FIXED_PRODUCT_SET) return { ok: false, code: "scope-mode-invalid" };
  const covered = expandScopeCategoryKeys(scope.categoryKeys);
  const included = new Set(scope.includeProductIds);
  const excluded = new Set(scope.excludeProductIds);

  const ids = new Set<string>();
  for (const product of products) {
    if (matchesSelection(product, covered, included, excluded)) ids.add(product.productId);
  }
  // An explicit include that the membership snapshot does not list (a product with no category) is
  // still part of the selection, unless excluded.
  for (const id of included) if (!excluded.has(id)) ids.add(id);

  if (ids.size === 0) return { ok: false, code: "scope-frozen-empty" };
  if (ids.size > MAX_FROZEN_PRODUCTS) return { ok: false, code: "scope-frozen-too-many" };
  return { ok: true, productIds: Object.freeze([...ids].sort()) };
}

export type ScopeResolver = (product: ScopeProductFacts) => boolean;

/**
 * Builds the membership predicate for a scope at evaluation time.
 *
 * - Global: every paid line.
 * - Dynamic: reads the product's current membership (the facts the caller passes in).
 * - Fixed: only the frozen ids. A Fixed scope that was never frozen matches nothing (fail closed);
 *   later category membership changes never add products to it.
 */
export function buildScopeResolver(scope: ScopeConfig, frozen: FrozenProductSet | null): ScopeResolver {
  if (scope.mode === GLOBAL_ALL_PAID_LINES) return () => true;

  if (scope.mode === FIXED_PRODUCT_SET) {
    const frozenIds = new Set(frozen?.productIds ?? []);
    const excluded = new Set(scope.excludeProductIds);
    // Exclusion is re-applied defensively: it must win even over a stale snapshot.
    return (product) => frozenIds.has(product.productId) && !excluded.has(product.productId);
  }

  const covered = expandScopeCategoryKeys(scope.categoryKeys);
  const included = new Set(scope.includeProductIds);
  const excluded = new Set(scope.excludeProductIds);
  return (product) => matchesSelection(product, covered, included, excluded);
}

/** A paid cart line as the scope sees it. A set sold as one product is one line, one unit each. */
export type ScopedPaidLine = Readonly<{
  product: ScopeProductFacts;
  quantity: number;
  /** Per-unit price after every discount the caller considers applied, in whole VND. */
  unitPriceVnd: number;
}>;

export type ScopeTotals = Readonly<{
  /** `Q`: units across all variants and all products in scope. */
  quantity: number;
  /** `S`: sum of unit price x quantity in scope, in whole VND. */
  subtotalVnd: number;
}>;

function requirePositiveSafeInteger(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${what} must be a positive safe integer`);
}

/**
 * Sums `Q` and `S` over the paid lines the scope covers. Gifts are never passed in: the caller
 * supplies paid lines only, so a gift can neither raise `Q`/`S` nor reach a threshold.
 */
export function sumScopeTotals(resolver: ScopeResolver, lines: readonly ScopedPaidLine[]): ScopeTotals {
  let quantity = 0;
  let subtotalVnd = 0;
  for (const line of lines) {
    requirePositiveSafeInteger(line.quantity, "Paid line quantity");
    if (!Number.isSafeInteger(line.unitPriceVnd) || line.unitPriceVnd <= 0) {
      throw new RangeError("Paid line unit price must be a positive safe integer");
    }
    if (!resolver(line.product)) continue;
    quantity += line.quantity;
    subtotalVnd += line.quantity * line.unitPriceVnd;
    if (!Number.isSafeInteger(quantity) || !Number.isSafeInteger(subtotalVnd)) {
      throw new RangeError("Scope totals overflow the safe integer range");
    }
  }
  return { quantity, subtotalVnd };
}
