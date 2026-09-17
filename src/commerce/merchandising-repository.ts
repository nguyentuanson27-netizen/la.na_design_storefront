/**
 * Persistence for the five website-owned merchandising models (ADR 0013).
 *
 * Every ordered write is a **full replacement inside one transaction**: delete the surface's rows,
 * insert the validated set. There is deliberately no incremental add/remove path. ADR §4.6 requires
 * it for membership — so a product is never observed mid-edit spanning two trees — and the same
 * shape is used for the three ordered surfaces for a narrower reason: `position` is unique per
 * surface, so an incremental reorder would have to shuffle rows through the unique index and could
 * collide half-way. Replacing the set makes the intermediate state unobservable.
 *
 * Reads filter by the storefront's existing availability truth (`isPresent`/`isActive`). A
 * merchandising row never overrides availability, publication or promotion truth — it only selects
 * and orders (ADR §4.7).
 */

import type { PrismaClient } from "../generated/prisma/client.ts";
import {
  APPROVED_CATEGORY_MEMBERSHIP_POLICY,
  categoryListingKeys,
  parseCategoryMembership,
  type CategoryKey,
} from "./category-taxonomy.ts";
import { compareCategoryRankedProducts } from "./storefront-related-products.ts";
import {
  MerchandisingError,
  parseCategoryEditorialMedia,
  parseCategoryProductOrder,
  parseHomepageFeaturedSelection,
  parseRelatedProductOverrides,
} from "./merchandising-input.ts";

/** The storefront visibility predicate, matching `visibleProductWhere` in `storefront-catalog.ts`. */
function visibleProduct(shopId: number) {
  return { pancakeShopId: shopId, isPresent: true, isActive: true };
}

/**
 * Rejects ids that do not resolve to a visible product of this shop.
 *
 * The foreign keys already guarantee the product *exists*; what they cannot say is that it belongs
 * to this shop and is sellable. Without this an admin could rank a product from another shop, or a
 * withdrawn one, and the mismatch would only surface as a silently short PLP.
 */
async function requireVisibleProducts(
  tx: Pick<PrismaClient, "productMirror">,
  shopId: number,
  productIds: readonly string[],
): Promise<void> {
  if (productIds.length === 0) return;

  const found = await tx.productMirror.findMany({
    where: { ...visibleProduct(shopId), id: { in: [...productIds] } },
    select: { id: true },
  });
  if (found.length !== productIds.length) {
    throw new MerchandisingError("merchandising-invalid-product");
  }
}

/**
 * The isolation level the two-bucket category read runs at.
 *
 * `READ COMMITTED` — PostgreSQL's default — is **not** sufficient here, and a plain transaction does
 * not help: at that level every *statement* takes a fresh snapshot, which is exactly the hazard.
 * `RepeatableRead` takes one snapshot for the whole transaction, which is the property the buckets
 * depend on. The read is read-only, so it cannot hit the serialization failures that make
 * `RepeatableRead` awkward for writers.
 */
export const CATEGORY_READ_ISOLATION_LEVEL = "RepeatableRead" as const;

/** Just enough of a client or transaction handle to run the two bucket reads. */
export type CategoryCandidateReader = Pick<PrismaClient, "categoryProductOrder" | "productMirror">;

export type CategoryCandidateRow = Readonly<{
  product: Readonly<{ id: string; slug: string; name: string }>;
  position: number | null;
}>;

/** The product shape every candidate read projects. */
const CANDIDATE_PRODUCT_FIELDS = { id: true, slug: true, name: true } as const;

type CategoryBucketArgs = {
  shopId: number;
  rankCategoryKey: CategoryKey;
  membershipKeys: readonly CategoryKey[];
  limit: number;
};

/**
 * Bucket 1 — products the merchandiser ranked in `rankCategoryKey`, `position` ascending.
 *
 * Ordered by the same key it truncates on, so the bound cannot drop a row that would have won.
 */
export async function readRankedCategoryBucket(
  reader: CategoryCandidateReader,
  { shopId, rankCategoryKey, membershipKeys, limit }: CategoryBucketArgs,
): Promise<CategoryCandidateRow[]> {
  const rows = await reader.categoryProductOrder.findMany({
    where: {
      categoryKey: rankCategoryKey,
      product: {
        ...visibleProduct(shopId),
        categoryMemberships: { some: { categoryKey: { in: [...membershipKeys] } } },
      },
    },
    orderBy: [{ position: "asc" }],
    take: limit,
    select: { position: true, product: { select: CANDIDATE_PRODUCT_FIELDS } },
  });
  return rows.map((row) => ({ product: row.product, position: row.position as number | null }));
}

/**
 * Bucket 2 — candidates with **no** rank in `rankCategoryKey`, `name` then `id`.
 *
 * The `none` predicate is what makes this complementary to bucket 1, and is also why the two must
 * observe one snapshot: it is evaluated against whatever ranking state this statement can see.
 */
export async function readUnrankedCategoryBucket(
  reader: CategoryCandidateReader,
  { shopId, rankCategoryKey, membershipKeys, limit }: CategoryBucketArgs,
): Promise<CategoryCandidateRow[]> {
  const products = await reader.productMirror.findMany({
    where: {
      ...visibleProduct(shopId),
      categoryMemberships: { some: { categoryKey: { in: [...membershipKeys] } } },
      categoryOrders: { none: { categoryKey: rankCategoryKey } },
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: limit,
    select: CANDIDATE_PRODUCT_FIELDS,
  });
  return products.map((product) => ({ product, position: null as number | null }));
}

/**
 * The two complementary bucket reads, as one unit.
 *
 * Exported and taking its own reader so the snapshot boundary is explicit in the code rather than
 * implied: these two statements are only complementary while they observe the same committed
 * ranking state, and the caller is responsible for giving them one. Review `5232098227` found them
 * running as independent statements under `Promise.all`, where a `replaceCategoryProductOrder()`
 * committing in between produces either:
 *
 * - a **duplicate** — bucket 1 sees a product as ranked while bucket 2, on a later snapshot, sees
 *   the rank already deleted, so the product lands in both; or
 * - an **omission** — bucket 2 excludes it as ranked, and bucket 1, on a later snapshot, no longer
 *   finds the rank, so it lands in neither.
 *
 * De-duplicating the merge would hide the first and do nothing about the second, which is why the
 * fix is the shared snapshot rather than a filter on the way out.
 *
 * The buckets are awaited in sequence rather than with `Promise.all`: they share one transaction,
 * so there is nothing to gain from overlapping them, and sequencing makes the intent legible.
 */
export async function readCategoryCandidateBuckets(
  reader: CategoryCandidateReader,
  args: CategoryBucketArgs,
): Promise<CategoryCandidateRow[]> {
  const ranked = await readRankedCategoryBucket(reader, args);
  const unranked = await readUnrankedCategoryBucket(reader, args);
  return [...ranked, ...unranked];
}

export function createMerchandisingRepository(client: PrismaClient) {
  // -------------------------------------------------------------------------
  // §3 Homepage Featured
  // -------------------------------------------------------------------------

  async function replaceHomepageFeatured({
    shopId,
    productIds,
  }: {
    shopId: number;
    productIds: unknown;
  }): Promise<readonly string[]> {
    const selection = parseHomepageFeaturedSelection(productIds);

    return client.$transaction(async (tx) => {
      await requireVisibleProducts(tx, shopId, selection.productIds);
      await tx.homepageFeaturedProduct.deleteMany({});
      if (selection.productIds.length > 0) {
        await tx.homepageFeaturedProduct.createMany({
          data: selection.productIds.map((productId, position) => ({ productId, position })),
        });
      }
      return selection.productIds;
    });
  }

  /**
   * The Featured section's products, in the admin's order.
   *
   * Unavailable products are skipped at read time, and an empty result means the section is empty.
   * Master spec §20 forbids falling back to newest/bestseller logic here, so this returns the short
   * list rather than topping it up — the absence is the answer.
   */
  async function listHomepageFeatured({ shopId }: { shopId: number }) {
    const rows = await client.homepageFeaturedProduct.findMany({
      where: { product: visibleProduct(shopId) },
      orderBy: [{ position: "asc" }],
      select: { position: true, product: { select: { id: true, slug: true, name: true } } },
    });
    return rows.map((row) => row.product);
  }

  // -------------------------------------------------------------------------
  // §4.5 / §4.6 Category membership
  // -------------------------------------------------------------------------

  /**
   * Full replacement of one product's category assignment.
   *
   * This transaction is the *only* place the one-top-level invariant is enforced, which is why no
   * other write path may exist: `parseCategoryMembership()` refuses a cross-tree selection before
   * anything is written, and the delete-then-insert means no reader observes a half-applied edit.
   * The database cannot enforce it — ADR §4.5 records why teaching SQL the taxonomy was rejected —
   * so `findCategoryMembershipViolations()` audits what this boundary is trusted to prevent.
   */
  async function replaceCategoryMembership({
    shopId,
    productId,
    categoryKeys,
  }: {
    shopId: number;
    productId: string;
    categoryKeys: unknown;
  }): Promise<readonly CategoryKey[]> {
    const membership = parseCategoryMembership(categoryKeys, APPROVED_CATEGORY_MEMBERSHIP_POLICY);

    return client.$transaction(async (tx) => {
      await requireVisibleProducts(tx, shopId, [productId]);
      await tx.productCategoryMembership.deleteMany({ where: { productId } });
      if (membership.categoryKeys.length > 0) {
        await tx.productCategoryMembership.createMany({
          data: membership.categoryKeys.map((categoryKey) => ({ productId, categoryKey })),
        });
      }
      return membership.categoryKeys;
    });
  }

  async function readCategoryMembership(productId: string): Promise<readonly CategoryKey[]> {
    const rows = await client.productCategoryMembership.findMany({
      where: { productId },
      select: { categoryKey: true },
    });
    return rows.map((row) => row.categoryKey);
  }

  /** Every membership row, for the ADR §4.8 pre-activation audit. */
  async function listCategoryMembershipsForAudit(limit: number) {
    return client.productCategoryMembership.findMany({
      take: limit,
      orderBy: [{ productId: "asc" }, { categoryKey: "asc" }],
      select: { productId: true, categoryKey: true },
    });
  }

  // -------------------------------------------------------------------------
  // §5 Category PLP order
  // -------------------------------------------------------------------------

  /**
   * Full replacement of one category's manual ranking.
   *
   * Every ranked product must actually be listed by this category — its membership key must be in
   * `categoryListingKeys(categoryKey)`. That check is what makes a parent ranking meaningful: a
   * product assigned only to `Áo dài Tết` has no membership row for `aoDai`, yet `/ao-dai` lists it
   * and must be able to rank it, so membership-row equality would be the wrong test.
   */
  async function replaceCategoryProductOrder({
    shopId,
    input,
  }: {
    shopId: number;
    input: unknown;
  }): Promise<readonly string[]> {
    const { categoryKey, productIds } = parseCategoryProductOrder(input);
    const listingKeys = [...categoryListingKeys(categoryKey)];

    return client.$transaction(async (tx) => {
      await requireVisibleProducts(tx, shopId, productIds);

      if (productIds.length > 0) {
        const listed = await tx.productCategoryMembership.findMany({
          where: { productId: { in: [...productIds] }, categoryKey: { in: listingKeys } },
          select: { productId: true },
          distinct: ["productId"],
        });
        if (listed.length !== productIds.length) {
          throw new MerchandisingError("merchandising-invalid-product");
        }
      }

      await tx.categoryProductOrder.deleteMany({ where: { categoryKey } });
      if (productIds.length > 0) {
        await tx.categoryProductOrder.createMany({
          data: productIds.map((productId, position) => ({ categoryKey, productId, position })),
        });
      }
      return productIds;
    });
  }

  /**
   * Candidates for one category, bounded *without* breaking the ADR §7 order.
   *
   * The naive shape — one query with `take: limit` — is wrong, and wrong in a way that hides: the
   * database has to order by *something* to truncate, that something is not the §7 order (which
   * depends on a rank in a second table and is finished in TypeScript), and so a merchandised
   * winner outside the sampled slice can never be selected at all. Review `5709811796` caught
   * exactly that: ordering by `productId` and taking 16 meant a ranked product whose id sorted
   * 17th was unreachable.
   *
   * Two bounded queries fix it without moving the contract into SQL:
   *
   * - **ranked** — `CategoryProductOrder` rows for this category, `position` ascending, take `limit`;
   * - **unranked** — products with membership here and *no* rank here, `name` then `id`, take `limit`.
   *
   * Each query orders by the same key it truncates on, so neither can drop a row that would have
   * won. Their union contains the true first `limit` in §7 order: that prefix is either the first
   * `limit` ranked products, or every ranked product followed by the first unranked ones — and both
   * buckets supply `limit` of their own kind. The caller still sorts, so the decision stays in
   * `compareCategoryRankedProducts()` and remains testable without a database.
   */
  async function listCategoryCandidates({
    shopId,
    rankCategoryKey,
    membershipKeys,
    limit,
  }: {
    shopId: number;
    /** The category whose ranking applies — a PLP ranks by its own key, even for inherited rows. */
    rankCategoryKey: CategoryKey;
    /** The membership keys that make a product a candidate at all. */
    membershipKeys: readonly CategoryKey[];
    limit: number;
  }): Promise<CategoryCandidateRow[]> {
    if (membershipKeys.length === 0 || limit <= 0) return [];

    // One snapshot for both buckets — see `readCategoryCandidateBuckets`.
    return client.$transaction(
      (tx) => readCategoryCandidateBuckets(tx, { shopId, rankCategoryKey, membershipKeys, limit }),
      { isolationLevel: CATEGORY_READ_ISOLATION_LEVEL },
    );
  }

  /**
   * One category's PLP, in the order ADR §5 and §7 specify.
   *
   * Membership matches the whole listing key set, which is the single place parent projection
   * happens (§4.7): a product assigned to a subcategory appears on the parent page because this
   * query widens, not because a derived row was written. The ranking, by contrast, is keyed by the
   * page's own category, so `/ao-dai` ranks an inherited product with its `aoDai` position.
   */
  async function listCategoryProducts({
    shopId,
    categoryKey,
    limit,
  }: {
    shopId: number;
    categoryKey: CategoryKey;
    limit: number;
  }) {
    const candidates = await listCategoryCandidates({
      shopId,
      rankCategoryKey: categoryKey,
      membershipKeys: categoryListingKeys(categoryKey),
      limit,
    });

    // De-duplicate defensively. The buckets are complementary under one snapshot, so this should
    // never drop anything; it is here so that a future caller assembling candidates from another
    // source cannot render the same product twice. It is *not* the fix for review `5232098227` —
    // that anomaly also produced omissions, which no output filter can repair.
    const seen = new Set<string>();
    return candidates
      .sort(compareCategoryRankedProducts)
      .filter((entry) => {
        if (seen.has(entry.product.id)) return false;
        seen.add(entry.product.id);
        return true;
      })
      .slice(0, limit)
      .map((entry) => entry.product);
  }

  // -------------------------------------------------------------------------
  // §6 Category editorial media
  // -------------------------------------------------------------------------

  async function saveCategoryEditorialMedia(input: unknown) {
    const media = parseCategoryEditorialMedia(input);
    const { categoryKey, ...fields } = media;

    return client.categoryEditorialMedia.upsert({
      where: { categoryKey },
      create: { categoryKey, ...fields },
      update: fields,
      select: { categoryKey: true, heroImageUrl: true, megaMenuImageUrl: true },
    });
  }

  /** `null` means no editorial image; the UI uses its approved no-image behaviour (ADR §6). */
  async function readCategoryEditorialMedia(categoryKey: CategoryKey) {
    return client.categoryEditorialMedia.findUnique({
      where: { categoryKey },
      select: { categoryKey: true, heroImageUrl: true, megaMenuImageUrl: true },
    });
  }

  /** Every media row, for the ADR §4.8 pre-activation audit. */
  async function listCategoryEditorialMediaForAudit(limit: number) {
    return client.categoryEditorialMedia.findMany({
      take: limit,
      orderBy: [{ categoryKey: "asc" }],
      select: { categoryKey: true },
    });
  }

  /** Every ranking row, for the ADR §4.8 pre-activation audit. */
  async function listCategoryProductOrderForAudit(limit: number) {
    return client.categoryProductOrder.findMany({
      take: limit,
      orderBy: [{ categoryKey: "asc" }, { position: "asc" }],
      select: { categoryKey: true, productId: true },
    });
  }

  // -------------------------------------------------------------------------
  // §7 Related-product overrides
  // -------------------------------------------------------------------------

  async function replaceRelatedProductOverrides({
    shopId,
    input,
  }: {
    shopId: number;
    input: unknown;
  }): Promise<readonly string[]> {
    const { productId, relatedProductIds } = parseRelatedProductOverrides(input);

    return client.$transaction(async (tx) => {
      await requireVisibleProducts(tx, shopId, [productId, ...relatedProductIds]);
      await tx.relatedProductOverride.deleteMany({ where: { productId } });
      if (relatedProductIds.length > 0) {
        await tx.relatedProductOverride.createMany({
          data: relatedProductIds.map((relatedProductId, position) => ({
            productId,
            relatedProductId,
            position,
          })),
        });
      }
      return relatedProductIds;
    });
  }

  /** Stage 1 candidates: the admin's picks, in their order, filtered by availability. */
  async function listRelatedProductOverrides({
    shopId,
    productId,
  }: {
    shopId: number;
    productId: string;
  }) {
    const rows = await client.relatedProductOverride.findMany({
      where: { productId, related: visibleProduct(shopId) },
      orderBy: [{ position: "asc" }],
      select: { related: { select: { id: true, slug: true, name: true } } },
    });
    return rows.map((row) => row.related);
  }

  /**
   * Stage 2–3 candidates for one exact category key.
   *
   * Returned unordered on purpose: `listRelatedStorefrontProducts()` owns the §7 order so it can be
   * pinned by domain tests without a database. The `position` carried alongside is this category's
   * rank, which is what lets related products agree with the PLP the visitor came from.
   *
   * Membership is the exact key rather than the listing set, because the resolver visits each key
   * in turn and widening here would make stage 2 and stage 3 return the same rows.
   */
  async function listCategoryRelatedCandidates({
    shopId,
    categoryKey,
    limit,
  }: {
    shopId: number;
    categoryKey: CategoryKey;
    limit: number;
  }) {
    return listCategoryCandidates({
      shopId,
      rankCategoryKey: categoryKey,
      membershipKeys: [categoryKey],
      limit,
    });
  }

  return {
    replaceHomepageFeatured,
    listHomepageFeatured,
    replaceCategoryMembership,
    readCategoryMembership,
    listCategoryMembershipsForAudit,
    replaceCategoryProductOrder,
    listCategoryProducts,
    saveCategoryEditorialMedia,
    readCategoryEditorialMedia,
    listCategoryEditorialMediaForAudit,
    listCategoryProductOrderForAudit,
    replaceRelatedProductOverrides,
    listRelatedProductOverrides,
    listCategoryRelatedCandidates,
  };
}
