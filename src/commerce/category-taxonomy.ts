import { CATEGORY_NAVIGATION, type CategoryDefinition } from "../brand/category.config.ts";

/**
 * The canonical Brand #2 category authority (ADR 0013 §4).
 *
 * Category *identity* is code/config, not persisted data: `CATEGORY_NAVIGATION` already declares
 * every approved category once, and the route manifest, sitemap, indexable-path patterns and
 * navigation all derive from it. A `CategoryDefinition` table could not create a route — App Router
 * needs `src/app/<slug>/page.tsx` on disk — so persisting the taxonomy would add a second authority
 * that can disagree with the routes while buying nothing.
 *
 * Category *membership* is the opposite: it is website-owned editorial data with no truthful source
 * in code, so it is persisted and admin-assigned. This module is the boundary between the two — it
 * turns the config into the queries and invariants every membership consumer shares, so PLP order,
 * category media and same-category related products all key to one identity.
 *
 * What this module deliberately does not do: infer membership from `CollectionDefinition`,
 * `ProductContent.collectionSlugs`, `CollectionDefinition.pancakeCategoryIds`, or navigation shape.
 * `/collections` stays a separate editorial namespace.
 */

/**
 * The stable identity of a category, persisted in membership rows.
 *
 * Deliberately the config `key` (`aoDaiCachTan`) rather than the route path (`/ao-dai/cach-tan`):
 * the master spec still expects category SEO copy to be drafted for approval, so a slug may yet be
 * renamed. Keying rows to the path would turn an SEO edit into a data migration; keying them to the
 * stable code identity makes it a config-only change.
 */
export type CategoryKey = string;

export type CategoryNode = Readonly<{
  key: CategoryKey;
  /** The crawlable route path this category serves. Deterministic identity for path → category. */
  path: string;
  label: string;
  parentKey: CategoryKey | null;
  /** The root of this node's tree. A node that is itself top-level is its own `topLevelKey`. */
  topLevelKey: CategoryKey;
  childKeys: readonly CategoryKey[];
}>;

/**
 * An indexed taxonomy. Usually the current one, but `buildCategoryTaxonomy` can index a *proposed*
 * one so a taxonomy change can be audited against existing membership rows before it is activated
 * (§4.8). Without that seam the gate could only run after the deploy that breaks the invariant.
 */
export type CategoryTaxonomy = Readonly<{
  byKey: ReadonlyMap<CategoryKey, CategoryNode>;
  byPath: ReadonlyMap<string, CategoryNode>;
}>;

export function buildCategoryTaxonomy(
  roots: readonly CategoryDefinition[],
): CategoryTaxonomy {
  const byKey = new Map<CategoryKey, CategoryNode>();
  const byPath = new Map<string, CategoryNode>();

  const visit = (
    definition: CategoryDefinition,
    parentKey: CategoryKey | null,
    topLevelKey: CategoryKey,
  ): void => {
    const children = definition.children ?? [];
    const node: CategoryNode = Object.freeze({
      key: definition.key,
      path: definition.href,
      label: definition.label,
      parentKey,
      topLevelKey,
      childKeys: Object.freeze(children.map((child) => child.key)),
    });

    // A duplicate key or path would make identity ambiguous for every consumer downstream, so it
    // fails at module load rather than resolving to whichever entry happened to be indexed last.
    if (byKey.has(node.key)) {
      throw new Error(`Duplicate category key in taxonomy: ${node.key}`);
    }
    if (byPath.has(node.path)) {
      throw new Error(`Duplicate category path in taxonomy: ${node.path}`);
    }
    byKey.set(node.key, node);
    byPath.set(node.path, node);

    for (const child of children) visit(child, node.key, topLevelKey);
  };

  for (const root of roots) visit(root, null, root.key);
  return Object.freeze({ byKey, byPath });
}

/** The taxonomy the running application serves. */
export const CURRENT_CATEGORY_TAXONOMY: CategoryTaxonomy =
  buildCategoryTaxonomy(CATEGORY_NAVIGATION);

const NODES_BY_KEY = CURRENT_CATEGORY_TAXONOMY.byKey;
const NODES_BY_PATH = CURRENT_CATEGORY_TAXONOMY.byPath;

/** Every approved category key, parent before its own children, in declared order. */
export const CATEGORY_KEYS: readonly CategoryKey[] = Object.freeze([...NODES_BY_KEY.keys()]);

/** Every approved top-level category key, in declared order. */
export const TOP_LEVEL_CATEGORY_KEYS: readonly CategoryKey[] = Object.freeze(
  CATEGORY_NAVIGATION.map((root) => root.key),
);

export function categoryByKey(key: unknown): CategoryNode | null {
  if (typeof key !== "string") return null;
  return NODES_BY_KEY.get(key) ?? null;
}

/** Deterministic route path → category identity. Query state is not part of the path. */
export function categoryByPath(path: unknown): CategoryNode | null {
  if (typeof path !== "string") return null;
  return NODES_BY_PATH.get(path) ?? null;
}

/** `key` and every category beneath it, parent first. */
export function descendantCategoryKeys(key: CategoryKey): readonly CategoryKey[] {
  const root = NODES_BY_KEY.get(key);
  if (!root) return [];

  const collected: CategoryKey[] = [];
  const walk = (node: CategoryNode): void => {
    collected.push(node.key);
    for (const childKey of node.childKeys) {
      const child = NODES_BY_KEY.get(childKey);
      if (child) walk(child);
    }
  };
  walk(root);
  return Object.freeze(collected);
}

/**
 * The membership keys a listing for `key` must match — the category itself plus every descendant.
 *
 * This is how child membership projects into the parent PLP (ADR 0013 §4 invariant 6) *without*
 * persisting a derived parent row (invariant 9): assigning `Áo dài Tết` makes the product appear on
 * `/ao-dai` because the `/ao-dai` query widens, not because a second row was written. Admins
 * therefore never duplicate an assignment into the parent just to be listed there.
 */
export function categoryListingKeys(key: CategoryKey): readonly CategoryKey[] {
  return descendantCategoryKeys(key);
}

/** The node's ancestors, root first, excluding the node itself. Breadcrumb order (F3b). */
export function categoryAncestorKeys(key: CategoryKey): readonly CategoryKey[] {
  const ancestors: CategoryKey[] = [];
  let current = NODES_BY_KEY.get(key)?.parentKey ?? null;
  while (current) {
    ancestors.unshift(current);
    current = NODES_BY_KEY.get(current)?.parentKey ?? null;
  }
  return Object.freeze(ancestors);
}

/**
 * The largest number of categories one product could legitimately hold.
 *
 * Derived from the taxonomy rather than written down: top-level exclusivity caps a product at one
 * tree, so the bound is the biggest tree. A hand-written number would silently stop bounding the
 * input the first time a category is added.
 */
export const MAX_CATEGORY_MEMBERSHIPS: number = Math.max(
  ...TOP_LEVEL_CATEGORY_KEYS.map((key) => descendantCategoryKeys(key).length),
);

export type CategoryMembershipReason =
  | "category-membership-shape"
  | "category-membership-unknown-key"
  | "category-membership-duplicate"
  | "category-membership-too-many"
  | "category-membership-multiple-top-level"
  | "category-membership-parent-only";

export class CategoryMembershipError extends Error {
  readonly reason: CategoryMembershipReason;

  constructor(reason: CategoryMembershipReason) {
    super("Category membership is invalid");
    this.name = "CategoryMembershipError";
    this.reason = reason;
  }
}

/**
 * The one membership rule the owner has not settled.
 *
 * For a parent with children (`Áo dài`, `Set đồ`), may a product be assigned directly to the parent
 * and to no child? The schema and every query above support either answer, so this is a validation
 * flag rather than a structural choice — flipping it later needs no migration, only a policy change
 * and a data review of rows already written.
 *
 * `requireLeafMembership: true` rejects parent-only assignment; `false` permits it. Callers must
 * pass the policy explicitly; there is deliberately no default, so no admin path can silently adopt
 * a rule nobody approved — it has to name the one it is applying.
 */
export type CategoryMembershipPolicy = Readonly<{
  requireLeafMembership: boolean;
}>;

/**
 * The owner's decision, approved 2026-09-16: a product may be assigned directly to a parent
 * category with no subcategory. Recorded in
 * `docs/specs/la-na-design-owner-approved-facts-and-decisions.md` (the fact authority, which carries
 * the provenance) and in ADR 0013 §4.4.
 *
 * Such a product lists on the parent page and on no subcategory page, which is the truthful
 * outcome — nobody has said which subcategory it belongs to, so nothing may guess one. Admin write
 * paths pass this constant; changing the decision is this one value plus a review of existing rows,
 * and no migration.
 */
export const APPROVED_CATEGORY_MEMBERSHIP_POLICY: CategoryMembershipPolicy = Object.freeze({
  requireLeafMembership: false,
});

export type ValidatedCategoryMembership = Readonly<{
  /** `null` only when the product is assigned to no category at all. */
  topLevelKey: CategoryKey | null;
  /** Normalized, duplicate-free, in the taxonomy's declared order. */
  categoryKeys: readonly CategoryKey[];
}>;

/**
 * Fail-closed validation of an admin membership submission.
 *
 * Enforces the owner-approved invariants: known keys only, no duplicates, bounded size, and at most
 * one top-level tree per product. An empty selection is valid and means the product is assigned to
 * no category — it is not the same as a rejected submission.
 */
export function parseCategoryMembership(
  input: unknown,
  policy: CategoryMembershipPolicy,
): ValidatedCategoryMembership {
  if (!Array.isArray(input)) throw new CategoryMembershipError("category-membership-shape");
  if (input.length > MAX_CATEGORY_MEMBERSHIPS) {
    throw new CategoryMembershipError("category-membership-too-many");
  }

  const seen = new Set<CategoryKey>();
  const nodes: CategoryNode[] = [];
  for (const candidate of input) {
    const node = categoryByKey(candidate);
    if (!node) throw new CategoryMembershipError("category-membership-unknown-key");
    if (seen.has(node.key)) throw new CategoryMembershipError("category-membership-duplicate");
    seen.add(node.key);
    nodes.push(node);
  }

  if (nodes.length === 0) {
    return Object.freeze({ topLevelKey: null, categoryKeys: Object.freeze([]) });
  }

  const topLevelKeys = new Set(nodes.map((node) => node.topLevelKey));
  if (topLevelKeys.size > 1) {
    throw new CategoryMembershipError("category-membership-multiple-top-level");
  }

  if (policy.requireLeafMembership) {
    // A parent that has children is only a valid assignment when some child is also assigned.
    // Leaf categories (`/vay-dam`, `/phu-kien`) have no children and are always assignable.
    const assignedParentWithoutChild = nodes.some(
      (node) => node.childKeys.length > 0 && !node.childKeys.some((child) => seen.has(child)),
    );
    if (assignedParentWithoutChild) {
      throw new CategoryMembershipError("category-membership-parent-only");
    }
  }

  const [topLevelKey] = [...topLevelKeys];
  return Object.freeze({
    topLevelKey: topLevelKey ?? null,
    // Declared taxonomy order, so equal selections persist identically regardless of admin input
    // order. Membership is a set; ordered merchandising is a separate concern (ADR 0013 §5).
    categoryKeys: Object.freeze(
      CATEGORY_KEYS.filter((key) => seen.has(key)),
    ),
  });
}

export type CategoryMembershipRow = Readonly<{
  productId: string;
  categoryKey: CategoryKey;
}>;

export type CategoryMembershipViolationReason =
  | "unknown-category"
  | "multiple-top-level";

export type CategoryMembershipViolation = Readonly<{
  productId: string;
  reason: CategoryMembershipViolationReason;
  /** The product's offending keys, in the order encountered. */
  categoryKeys: readonly CategoryKey[];
}>;

/**
 * Reports persisted memberships the schema cannot refuse.
 *
 * Top-level exclusivity is enforced at one validated admin write boundary, not by a database
 * constraint: the taxonomy lives in code, so no foreign key can prove that `categoryKey` sits under
 * a given root (ADR 0013 §4.5). A writer that bypasses that boundary — a fixture, a repair query, a
 * migration script — can therefore split a product across two trees, and a category removed from
 * the taxonomy leaves rows pointing at nothing.
 *
 * A **taxonomy change is itself such a bypass**: re-parenting a category rewrites no row, but it can
 * turn rows that were valid under the old tree into a split product under the new one. That is why
 * `taxonomy` is a parameter — passing a proposed taxonomy answers "what would this deploy break?"
 * *before* it ships, which is the §4.8 activation gate. It defaults to the current taxonomy, which
 * answers "what is broken now?".
 *
 * This is the detection half of that trade, in the shape the repository already uses for facts it
 * cannot constrain in the schema (`mirrored-money-audit`, `merchant-identity-audit`).
 */
export function findCategoryMembershipViolations(
  rows: readonly CategoryMembershipRow[],
  taxonomy: CategoryTaxonomy = CURRENT_CATEGORY_TAXONOMY,
): readonly CategoryMembershipViolation[] {
  const byProduct = new Map<string, CategoryKey[]>();
  for (const row of rows) {
    const keys = byProduct.get(row.productId);
    if (keys) keys.push(row.categoryKey);
    else byProduct.set(row.productId, [row.categoryKey]);
  }

  const violations: CategoryMembershipViolation[] = [];
  for (const [productId, categoryKeys] of byProduct) {
    // The two reasons are judged independently. An unknown key has no knowable tree, but the *known*
    // keys can still prove a split on their own, and reporting only the unknown one would hide a
    // real violation behind a repair-then-re-audit cycle.
    const unknown = categoryKeys.filter((key) => !taxonomy.byKey.has(key));
    if (unknown.length > 0) {
      violations.push(
        Object.freeze({
          productId,
          reason: "unknown-category" as const,
          categoryKeys: Object.freeze(unknown),
        }),
      );
    }

    const known = categoryKeys.filter((key) => taxonomy.byKey.has(key));
    const topLevelKeys = new Set(known.map((key) => taxonomy.byKey.get(key)?.topLevelKey));
    if (topLevelKeys.size > 1) {
      violations.push(
        Object.freeze({
          productId,
          reason: "multiple-top-level" as const,
          categoryKeys: Object.freeze(known),
        }),
      );
    }
  }

  return Object.freeze(violations);
}

/**
 * A persisted row that stores a raw `categoryKey`, whatever table it lives in.
 *
 * Membership is not the only owner keyed this way: `CategoryProductOrder` and
 * `CategoryEditorialMedia` store the same string and carry the same lifecycle risk, because the
 * taxonomy is in code and no foreign key can point at it (ADR 0013 §4.5). An audit that only knew
 * about membership would let a retired key strand PLP order or category media indefinitely.
 */
export type CategoryKeyedRecord = Readonly<{
  /** The persistence owner, e.g. `"CategoryProductOrder"`. Reported so remediation knows where to look. */
  owner: string;
  categoryKey: CategoryKey;
  /** Optional row identity within that owner, e.g. a product id. */
  rowRef?: string;
}>;

export type OrphanedCategoryKey = Readonly<{
  owner: string;
  categoryKey: CategoryKey;
  /** The `rowRef`s seen for this (owner, key), in the order encountered. */
  rowRefs: readonly string[];
}>;

/**
 * Reports rows whose `categoryKey` is not in the taxonomy, across every category-keyed owner.
 *
 * Pass a proposed taxonomy to run this as part of the §4.8 activation gate; it defaults to the
 * current one to answer "what is stranded now?". This is the generic half of the membership audit:
 * `findCategoryMembershipViolations` judges the one-top-level invariant, which only membership has,
 * while this judges key existence, which every owner shares.
 */
export function findOrphanedCategoryKeys(
  records: readonly CategoryKeyedRecord[],
  taxonomy: CategoryTaxonomy = CURRENT_CATEGORY_TAXONOMY,
): readonly OrphanedCategoryKey[] {
  // Grouped owner-then-key rather than by a joined string, so no separator can collide two pairs.
  const byOwner = new Map<string, Map<CategoryKey, string[]>>();

  for (const record of records) {
    if (taxonomy.byKey.has(record.categoryKey)) continue;
    let keys = byOwner.get(record.owner);
    if (!keys) {
      keys = new Map<CategoryKey, string[]>();
      byOwner.set(record.owner, keys);
    }
    const rowRefs = keys.get(record.categoryKey);
    if (rowRefs) {
      if (record.rowRef !== undefined) rowRefs.push(record.rowRef);
    } else {
      keys.set(record.categoryKey, record.rowRef === undefined ? [] : [record.rowRef]);
    }
  }

  const orphans: OrphanedCategoryKey[] = [];
  for (const [owner, keys] of byOwner) {
    for (const [categoryKey, rowRefs] of keys) {
      orphans.push(Object.freeze({ owner, categoryKey, rowRefs: Object.freeze(rowRefs) }));
    }
  }
  return Object.freeze(orphans);
}
