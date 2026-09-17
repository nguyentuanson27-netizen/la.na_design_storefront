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
   * One category's PLP, in the order ADR §5 and §7 specify.
   *
   * Membership matches the whole listing key set, which is the single place parent projection
   * happens (§4.7): a product assigned to a subcategory appears on the parent page because this
   * query widens, not because a derived row was written.
   *
   * Ranked products come first by `position`; the unranked tail is `name` then `id`, the ordering
   * the rest of the catalogue already uses. `id` is unique, so no tie reaches the database.
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
    const listingKeys = [...categoryListingKeys(categoryKey)];
    if (listingKeys.length === 0) return [];

    const memberships = await client.productCategoryMembership.findMany({
      where: { categoryKey: { in: listingKeys }, product: visibleProduct(shopId) },
      select: { product: { select: { id: true, slug: true, name: true } } },
      distinct: ["productId"],
    });

    const ranks = await client.categoryProductOrder.findMany({
      where: { categoryKey, productId: { in: memberships.map((row) => row.product.id) } },
      select: { productId: true, position: true },
    });
    const positionByProductId = new Map(ranks.map((row) => [row.productId, row.position]));

    return memberships
      .map((row) => ({ product: row.product, position: positionByProductId.get(row.product.id) ?? null }))
      .sort((left, right) => {
        const leftRanked = left.position !== null;
        const rightRanked = right.position !== null;
        if (leftRanked !== rightRanked) return leftRanked ? -1 : 1;
        if (leftRanked && rightRanked && left.position !== right.position) {
          return (left.position ?? 0) - (right.position ?? 0);
        }
        const byName = left.product.name.localeCompare(right.product.name);
        return byName !== 0 ? byName : left.product.id.localeCompare(right.product.id);
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
   * Stage 2–3 candidates for one category key.
   *
   * Returned unordered on purpose: `listRelatedStorefrontProducts()` owns the §7 order so it can be
   * pinned by domain tests without a database. The `position` carried alongside is this category's
   * rank, which is what lets related products agree with the PLP the visitor came from.
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
    const memberships = await client.productCategoryMembership.findMany({
      where: { categoryKey, product: visibleProduct(shopId) },
      take: limit,
      orderBy: [{ productId: "asc" }],
      select: { product: { select: { id: true, slug: true, name: true } } },
    });
    if (memberships.length === 0) return [];

    const ranks = await client.categoryProductOrder.findMany({
      where: { categoryKey, productId: { in: memberships.map((row) => row.product.id) } },
      select: { productId: true, position: true },
    });
    const positionByProductId = new Map(ranks.map((row) => [row.productId, row.position]));

    return memberships.map((row) => ({
      product: row.product,
      position: positionByProductId.get(row.product.id) ?? null,
    }));
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
