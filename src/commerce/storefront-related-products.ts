/**
 * Related products (ADR 0013 §7), the owner-approved resolution order:
 *
 * 1. manual override, in the admin's order;
 * 2. then products sharing the **same subcategory** — the categories this product is assigned to;
 * 3. then widen to the **same parent tree**;
 * 4. **no collection fallback at any stage.**
 *
 * The shared-collection fallback this module used to implement is gone rather than kept alongside.
 * It answered a different identity question — "what else is in a collection this product is pinned
 * to" — and ADR 0013's *Three distinct merchandising namespaces* section exists because conflating
 * collection with category is the specific mistake that keeps recurring. Keeping it as a last-resort
 * stage would have preserved exactly that conflation under a different name.
 *
 * Ordering is decided here rather than in SQL. Stage order alone was never a contract: PostgreSQL
 * row order is not stable, so identical data could return different related products between runs,
 * and M3a's deterministic-order acceptance could only have passed by accident. Deciding it in a pure
 * function means the whole contract — traversal across categories *and* order within one — is pinned
 * by domain tests with no database.
 */

import { CATEGORY_KEYS, categoryByKey, categoryListingKeys, type CategoryKey } from "./category-taxonomy.ts";

export const MAX_RELATED_PRODUCTS = 4;

/**
 * What the resolver needs of a product to order it. `name` and `id` are the tie-breaks ADR §7 step
 * 2–3 specify, which are the ordering this repository already uses for catalog reads.
 */
export type RelatedProductBase = Readonly<{ id: string; name: string }>;

export type CategoryRankedProduct<T extends RelatedProductBase> = Readonly<{
  product: T;
  /**
   * `CategoryProductOrder.position` for the category currently being visited, or `null` when the
   * merchandiser has not ranked this product *in that category*.
   *
   * Per-category rather than per-product on purpose: the same product can be ranked third on
   * `/ao-dai/tet` and unranked on `/ao-dai`, and §7 step 1 exists so related products agree with
   * the PLP the visitor just came from.
   */
  position: number | null;
}>;

export type RelatedProductSeed = Readonly<{
  id: string;
  /** The product's own `ProductCategoryMembership` rows. Order here does not matter. */
  categoryKeys: readonly CategoryKey[];
}>;

export type ListRelatedStorefrontProductsInput<T extends RelatedProductBase> = Readonly<{
  currentProduct: RelatedProductSeed;
  /**
   * Stage 1. Already in the admin's order (`RelatedProductOverride.position` ascending) and already
   * filtered by storefront availability truth, so an unavailable pick is absent rather than shown.
   */
  loadManualOverrides: () => Promise<readonly T[]>;
  /**
   * Stages 2–3. Candidates whose membership `categoryKey` is exactly `categoryKey`, already filtered
   * by storefront availability truth. Order is not required: this module imposes it.
   */
  loadCategoryCandidates: (categoryKey: CategoryKey) => Promise<readonly CategoryRankedProduct<T>[]>;
  limit?: number;
}>;

/**
 * The product's assigned categories in the taxonomy's **declared order**.
 *
 * The same normalization `parseCategoryMembership()` applies on write, so the stored set and this
 * traversal agree and a product's related list does not depend on the order an admin happened to
 * tick the boxes in.
 *
 * Keys absent from the current taxonomy are dropped rather than thrown on. A read path is the wrong
 * place to fail on a stale key: ADR §4.8's pre-activation gate and `findOrphanedCategoryKeys()` are
 * what surface it, and a PDP should not 500 because a category was retired.
 */
function assignedKeysInDeclaredOrder(keys: readonly CategoryKey[]): readonly CategoryKey[] {
  const assigned = new Set(keys);
  return CATEGORY_KEYS.filter((key) => assigned.has(key));
}

/**
 * The category keys to visit, closest first.
 *
 * Stage 2 is the assigned categories themselves; stage 3 widens to every key in the same tree.
 * Because stage 2's candidates are a subset of stage 3's, plain de-duplication produces
 * "closest first, then widen" with no separate exclusion rule — §7 relies on exactly that.
 *
 * A product whose memberships span two trees violates the one-top-level invariant and cannot be
 * produced by the §4.6 admin boundary. If one exists anyway — a fixture, a repair query — the first
 * assigned key in declared order decides the tree, so the output stays deterministic instead of
 * depending on row order. `findCategoryMembershipViolations()` is what reports it.
 */
function categoryVisitOrder(assignedKeys: readonly CategoryKey[]): readonly CategoryKey[] {
  if (assignedKeys.length === 0) return Object.freeze([]);

  const topLevelKey = categoryByKey(assignedKeys[0])?.topLevelKey ?? null;
  const widened = topLevelKey ? categoryListingKeys(topLevelKey) : [];

  const seen = new Set<CategoryKey>();
  const order: CategoryKey[] = [];
  for (const key of [...assignedKeys, ...widened]) {
    if (seen.has(key)) continue;
    seen.add(key);
    order.push(key);
  }
  return Object.freeze(order);
}

/**
 * ADR §7 order within one category, applied in full before moving to the next:
 *
 * 1. merchandised rank ascending;
 * 2. then everything else by `name` ascending;
 * 3. then `id` ascending as the final tie-break.
 *
 * `id` is unique and never null, so the total order is complete and no tie reaches the database's
 * discretion. Ranked products cannot collide — `@@unique([categoryKey, position])` forbids it — but
 * the comparison still falls through to name and id rather than returning `0`, so a row written
 * around the unique index cannot make the sort unstable.
 */
function compareWithinCategory<T extends RelatedProductBase>(
  left: CategoryRankedProduct<T>,
  right: CategoryRankedProduct<T>,
): number {
  const leftRanked = left.position !== null;
  const rightRanked = right.position !== null;

  if (leftRanked !== rightRanked) return leftRanked ? -1 : 1;
  if (leftRanked && rightRanked && left.position !== right.position) {
    return (left.position ?? 0) - (right.position ?? 0);
  }

  const byName = left.product.name.localeCompare(right.product.name);
  if (byName !== 0) return byName;
  return left.product.id.localeCompare(right.product.id);
}

/**
 * Resolve the related products for one product.
 *
 * The source product is excluded and every stage de-duplicates by product id, so a product that
 * qualifies twice keeps its earliest — closest — placement. Manual picks are never displaced by a
 * filled candidate.
 */
export async function listRelatedStorefrontProducts<T extends RelatedProductBase>({
  currentProduct,
  loadManualOverrides,
  loadCategoryCandidates,
  limit = MAX_RELATED_PRODUCTS,
}: ListRelatedStorefrontProductsInput<T>): Promise<T[]> {
  if (!Number.isSafeInteger(limit) || limit <= 0) return [];

  const seenProductIds = new Set<string>([currentProduct.id]);
  const related: T[] = [];

  const take = (candidate: T): boolean => {
    if (seenProductIds.has(candidate.id)) return false;
    seenProductIds.add(candidate.id);
    related.push(candidate);
    return related.length >= limit;
  };

  for (const override of await loadManualOverrides()) {
    if (take(override)) return related;
  }

  const assignedKeys = assignedKeysInDeclaredOrder(currentProduct.categoryKeys);
  for (const categoryKey of categoryVisitOrder(assignedKeys)) {
    const candidates = [...(await loadCategoryCandidates(categoryKey))].sort(compareWithinCategory);
    for (const candidate of candidates) {
      if (take(candidate.product)) return related;
    }
  }

  return related;
}
