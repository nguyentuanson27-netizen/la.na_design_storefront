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

function indexTaxonomy(): {
  byKey: Map<CategoryKey, CategoryNode>;
  byPath: Map<string, CategoryNode>;
} {
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

  for (const root of CATEGORY_NAVIGATION) visit(root, null, root.key);
  return { byKey, byPath };
}

const { byKey: NODES_BY_KEY, byPath: NODES_BY_PATH } = indexTaxonomy();

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
 * pass the owner-approved value explicitly; there is deliberately no default, so no admin path can
 * silently adopt a rule nobody approved.
 */
export type CategoryMembershipPolicy = Readonly<{
  requireLeafMembership: boolean;
}>;

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
