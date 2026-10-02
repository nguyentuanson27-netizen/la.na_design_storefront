import { Prisma, type PrismaClient } from "../generated/prisma/client.ts";
import type { AdminProductDirectoryQuery } from "./admin-product-directory.ts";
import { ADMIN_PRODUCT_DIRECTORY_LIMITS } from "./admin-product-directory.ts";
import {
  directoryHealthMetricsSql,
  jsTrimmedSql,
  missingEditorialCondition,
  missingImageCondition,
  missingSeoCondition,
  stockedInactiveCondition,
  zeroActiveCondition,
} from "./admin-product-health.ts";
import {
  metadataPairKey,
  readPublishMetadataReadiness,
  type PublishedMetadataPair,
} from "../seo/product-metadata-uniqueness.ts";
import type {
  BulkProductCollectionResult,
  BulkProductCollectionUpdate,
  BulkProductContentStatusResult,
  BulkProductContentStatusUpdate,
  ProductContentSnapshot,
  SaveProductContentOutcome,
} from "./product-content-admin.ts";
import { PRODUCT_CONTENT_LIMITS } from "./product-content-admin.ts";

const MAX_ADMIN_PRODUCTS = 100;

/**
 * B5: the transaction-level advisory lock every write that leaves a row `PUBLISHED` takes before it
 * reads the published catalog.
 *
 * The pair invariant is a read-then-write, and under Read Committed two concurrent publishes of the
 * same copy both see a conflict-free catalog and both commit. A unique index would be the other
 * mechanism, but it needs a migration the existing catalog is not guaranteed to survive: nothing has
 * ever constrained these columns, so a legacy pair of duplicate published rows would fail the
 * migration on a live database and there is no owner decision about rewriting that copy.
 *
 * One fixed key serializes all publishes rather than only same-pair ones. That is the smaller
 * mechanism — no key derivation, no lock ordering, no deadlock class — and it costs nothing here:
 * publishing is a rare, human-paced admin action, not a request-path write. The key itself is
 * arbitrary and only has to be identical in every such transaction.
 *
 * Know what this does and does not buy. It is a **cooperative protocol**: the application owns the
 * invariant, the database does not. Every write path here joins it, so no admin action can produce
 * a duplicate published pair — but the schema carries no constraint on the normalized pair, so
 * manual SQL, a data migration or a restore still can. W2a asks for enforcement "in the database
 * and in the admin publish path"; this is the second half only, and
 * `docs/audits/seo-metadata-uniqueness-w2a.md` records the first as still open. Any new path that
 * writes a `PUBLISHED` row must take this lock and run the same check, or the guarantee lapses.
 *
 * Exported so the concurrency regression can hold the real lock rather than simulate contention:
 * a race test that cannot lose is not a test.
 */
export const PUBLISHED_SEO_PAIR_LOCK_KEY = 529_029_001;

/** The website-owned fields a save reads back; the Pancake mirror is never among them. */
const productContentSelect = {
  productId: true,
  status: true,
  editorialDescription: true,
  careInstructions: true,
  sizeGuide: true,
  seoTitle: true,
  seoDescription: true,
  collectionSlugs: true,
} as const;

type PublishedPairRow = { slug: string; seoTitle: string; seoDescription: string };
type PublishCandidateRow = {
  id: string;
  slug: string;
  seoTitle: string | null;
  seoDescription: string | null;
};

/**
 * The database mirror of `normalizeMetadataText`: Unicode canonical composition, then exactly the
 * whitespace `String.prototype.trim()` strips. Same order, same result, so a pair that the domain
 * calls equal is the pair this query matches.
 */
function normalizedMetadataTextSql(column: Prisma.Sql): Prisma.Sql {
  return jsTrimmedSql(Prisma.sql`NORMALIZE(${column}, NFC)`);
}

const publishedStatusCondition = Prisma.sql`pc."status" = CAST('PUBLISHED' AS "ProductContentStatus")`;

/**
 * The published products already holding any of `pairs`, one row per colliding pair.
 *
 * `DISTINCT ON` bounds the result by the number of pairs asked about rather than by how many rows
 * happen to share one — a legacy catalog may hold several — while still naming a real slug for each,
 * so the operator gets a product to open rather than a count. The normalized pair travels back with
 * the slug so a bulk caller can map a collision to the member it blocks without re-deriving it.
 *
 * `excludedProductIds` is what keeps a product from colliding with itself on re-save.
 */
function publishedPairConflictSql(
  pairs: readonly PublishedMetadataPair[],
  excludedProductIds: readonly string[],
): Prisma.Sql {
  const normalizedTitle = normalizedMetadataTextSql(Prisma.sql`pc."seoTitle"`);
  const normalizedDescription = normalizedMetadataTextSql(Prisma.sql`pc."seoDescription"`);
  const candidatePairs = Prisma.join(
    pairs.map((pair) => Prisma.sql`(${pair.seoTitle}::text, ${pair.seoDescription}::text)`),
    ", ",
  );

  return Prisma.sql`
    SELECT DISTINCT ON ("seoTitle", "seoDescription") "slug", "seoTitle", "seoDescription"
    FROM (
      SELECT
        p."slug" AS "slug",
        ${normalizedTitle} AS "seoTitle",
        ${normalizedDescription} AS "seoDescription"
      FROM "ProductContent" pc
      JOIN "ProductMirror" p ON p."id" = pc."productId"
      WHERE ${publishedStatusCondition}
        AND pc."productId" <> ALL(${[...excludedProductIds]}::text[])
        AND (${normalizedTitle}, ${normalizedDescription}) IN (VALUES ${candidatePairs})
    ) AS matches
    ORDER BY "seoTitle", "seoDescription", "slug"
  `;
}

/** Rolls the membership batch back when a target is already at the editable collection limit. */
class CollectionMembershipLimitError extends Error {
  constructor() {
    super("Bulk collection membership would exceed the editable limit");
    this.name = "CollectionMembershipLimitError";
  }
}

function parseAdminListLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ADMIN_PRODUCTS) {
    throw new RangeError(`Admin product list limit must be between 1 and ${MAX_ADMIN_PRODUCTS}`);
  }
  return limit;
}

function parseAdminPageSize(pageSize: number): number {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_ADMIN_PRODUCTS) {
    throw new RangeError(`Admin page size must be between 1 and ${MAX_ADMIN_PRODUCTS}`);
  }
  return pageSize;
}

/**
 * The directory predicate, built once as SQL and shared by the page query, the total count and
 * every facet/health chip count.
 *
 * It is SQL rather than a Prisma `where` because two health dimensions have no Prisma
 * expression — summed multi-warehouse stock and storefront-equivalent media resolution — and
 * routing them through a materialized ID list would put the whole matching catalog into an
 * `IN (...)` list, one bind parameter per product. Keeping every condition in one builder means
 * a chip's count and the page its link opens cannot describe different result sets.
 *
 * The translated conditions match what Prisma generated before, including `ILIKE '%' || $1 || '%'`
 * search semantics and treating a product with no `ProductContent` row as an unedited draft.
 */
function adminSearchCondition(query: AdminProductDirectoryQuery): Prisma.Sql | null {
  if (!query.query) return null;
  return Prisma.sql`(
    p."name" ILIKE ('%' || ${query.query} || '%')
    OR p."slug" ILIKE ('%' || ${query.query} || '%')
    OR p."productCode" ILIKE ('%' || ${query.query} || '%')
  )`;
}

function adminActivityCondition(query: AdminProductDirectoryQuery): Prisma.Sql | null {
  if (!query.activity) return null;
  return Prisma.sql`p."isActive" = ${query.activity === "active"}`;
}

/** A product with no `ProductContent` row is an unedited draft, not a separate state. */
function adminStatusCondition(query: AdminProductDirectoryQuery): Prisma.Sql | null {
  if (query.status === null) return null;
  if (query.status === "DRAFT") {
    return Prisma.sql`(
      pc."productId" IS NULL
      OR pc."status" = CAST(${query.status}::text AS "ProductContentStatus")
    )`;
  }
  return Prisma.sql`pc."status" = CAST(${query.status}::text AS "ProductContentStatus")`;
}

function adminCollectionCondition(query: AdminProductDirectoryQuery): Prisma.Sql | null {
  if (query.uncategorized) {
    return Prisma.sql`(
      pc."productId" IS NULL
      OR COALESCE(ARRAY_LENGTH(pc."collectionSlugs", 1), 0) = 0
    )`;
  }
  if (query.collection) {
    return Prisma.sql`${query.collection} = ANY(COALESCE(pc."collectionSlugs", ARRAY[]::TEXT[]))`;
  }
  return null;
}

/** Health is always a full-catalog predicate, never a filter over the rows of the current page. */
function adminHealthCondition(query: AdminProductDirectoryQuery): Prisma.Sql | null {
  switch (query.health) {
    case "zero-active":
      return zeroActiveCondition(Prisma.sql`p`);
    case "stocked-inactive":
      return stockedInactiveCondition(Prisma.sql`p`);
    case "missing-image":
      return missingImageCondition(Prisma.sql`p`);
    case "missing-seo":
      return missingSeoCondition(Prisma.sql`pc`);
    case "missing-editorial":
      return missingEditorialCondition(Prisma.sql`pc`);
    case null:
      return null;
  }
}

function adminWhere(query: AdminProductDirectoryQuery): Prisma.Sql {
  const conditions = [
    adminSearchCondition(query),
    adminActivityCondition(query),
    adminStatusCondition(query),
    adminCollectionCondition(query),
    adminHealthCondition(query),
  ].filter((condition): condition is Prisma.Sql => condition !== null);

  return conditions.length === 0
    ? Prisma.sql`TRUE`
    : Prisma.join(conditions, " AND ");
}

/** Every directory read starts from the same row source, so the conditions can share aliases. */
const adminDirectoryFrom = Prisma.sql`
  FROM "ProductMirror" p
  LEFT JOIN "ProductContent" pc ON pc."productId" = p."id"
`;

function adminDirectoryCountSql(query: AdminProductDirectoryQuery): Prisma.Sql {
  return Prisma.sql`
    SELECT COUNT(*)::bigint AS "count"
    ${adminDirectoryFrom}
    WHERE ${adminWhere(query)}
  `;
}

function adminSortSql(sort: AdminProductDirectoryQuery["sort"]): Prisma.Sql {
  switch (sort) {
    case "name-desc":
      return Prisma.sql`p."name" DESC, p."id" ASC`;
    case "updated-desc":
      return Prisma.sql`p."updatedAt" DESC, p."id" ASC`;
    case "synced-desc":
      return Prisma.sql`p."syncedAt" DESC, p."id" ASC`;
    case "name-asc":
      return Prisma.sql`p."name" ASC, p."id" ASC`;
  }
}

type CollectionMembershipRow = { slug: string; count: bigint };
type DirectoryCountRow = { count: bigint };
type DirectoryIdRow = { id: string };
type DirectoryHealthMetricsRow = {
  id: string;
  presentVariantCount: bigint;
  activeVariantCount: bigint;
  stockedInactiveCount: bigint;
  missingImage: boolean;
};

export type AdminProductDirectoryMetrics = {
  presentVariantCount: number;
  activeVariantCount: number;
  stockedInactiveCount: number;
  missingImage: boolean;
};

function metricCountToNumber(value: bigint): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Admin directory metric is outside safe integer bounds");
  }
  return parsed;
}

function directoryCountToNumber(rows: readonly DirectoryCountRow[]): number {
  return rows[0] ? metricCountToNumber(rows[0].count) : 0;
}

function membershipCountToNumber(value: bigint): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Collection membership count is outside safe integer bounds");
  }
  return parsed;
}

export function createProductContentRepository(client: PrismaClient) {
  async function productExists(productId: string): Promise<boolean> {
    return (
      (await client.productMirror.findUnique({
        where: { id: productId },
        select: { id: true },
      })) !== null
    );
  }

  /** The write itself, identical whether or not it had to run inside the publish transaction. */
  function upsertContent(
    tx: Prisma.TransactionClient,
    content: ProductContentSnapshot,
  ): Promise<ProductContentSnapshot> {
    const { productId, ...fields } = content;
    return tx.productContent.upsert({
      where: { productId },
      create: { productId, ...fields },
      update: fields,
      select: productContentSelect,
    });
  }

  /**
   * B5's publish invariant, enforced where the row is actually written.
   *
   * The service refuses an incomplete publish before it ever gets here, and this repeats the check
   * rather than trusting it: this function is the last thing between admin input and a `PUBLISHED`
   * row, and an invariant the storefront depends on should not rest on a caller remembering to ask.
   *
   * A write that does not leave the row published skips all of it — unpublishing can only shrink the
   * published set, so it cannot break uniqueness.
   */
  async function saveContent(content: ProductContentSnapshot): Promise<SaveProductContentOutcome> {
    if (content.status !== "PUBLISHED") {
      return { ok: true, content: await upsertContent(client, content) };
    }

    const readiness = readPublishMetadataReadiness(content);
    if (!readiness.ok) {
      return { ok: false, block: { reason: readiness.reason, conflictingSlugs: [] } };
    }

    return client.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${PUBLISHED_SEO_PAIR_LOCK_KEY})`);

      const conflicts = await tx.$queryRaw<PublishedPairRow[]>(
        publishedPairConflictSql([readiness.pair], [content.productId]),
      );
      if (conflicts.length > 0) {
        return {
          ok: false,
          block: {
            reason: "SEO_PAIR_CONFLICT",
            conflictingSlugs: conflicts.map((row) => row.slug),
          },
        } as const;
      }

      return { ok: true, content: await upsertContent(tx, content) } as const;
    });
  }

  /**
   * The same invariant for a whole batch: every member must carry complete copy, no two members may
   * claim the same pair, and no member may claim a pair a product outside the batch already holds.
   *
   * Blocking aborts the entire batch, matching how this operation already treats a stale selection
   * or a membership limit. Publishing the members that happen to pass would leave the operator with
   * a partially applied action whose result they never asked for.
   */
  async function readBulkPublishBlock(
    tx: Prisma.TransactionClient,
    productIds: readonly string[],
  ): Promise<BulkProductContentStatusResult | null> {
    const candidates = await tx.$queryRaw<PublishCandidateRow[]>(Prisma.sql`
      SELECT p."id" AS "id", p."slug" AS "slug", pc."seoTitle", pc."seoDescription"
      FROM "ProductMirror" p
      LEFT JOIN "ProductContent" pc ON pc."productId" = p."id"
      WHERE p."id" = ANY(${[...productIds]}::text[])
      ORDER BY p."slug"
    `);

    const incompleteSlugs: string[] = [];
    const pairByKey = new Map<string, { pair: PublishedMetadataPair; slugs: string[] }>();
    for (const candidate of candidates) {
      const readiness = readPublishMetadataReadiness(candidate);
      if (!readiness.ok) {
        incompleteSlugs.push(candidate.slug);
        continue;
      }
      const key = metadataPairKey(readiness.pair.seoTitle, readiness.pair.seoDescription);
      const group = pairByKey.get(key);
      if (group) group.slugs.push(candidate.slug);
      else pairByKey.set(key, { pair: readiness.pair, slugs: [candidate.slug] });
    }

    if (incompleteSlugs.length > 0) {
      return { ok: false, reason: "SEO_INCOMPLETE", blockedSlugs: incompleteSlugs };
    }

    const duplicatedInsideBatch = [...pairByKey.values()]
      .filter((group) => group.slugs.length > 1)
      .flatMap((group) => group.slugs);
    if (duplicatedInsideBatch.length > 0) {
      return {
        ok: false,
        reason: "SEO_PAIR_CONFLICT",
        blockedSlugs: [...duplicatedInsideBatch].sort(),
      };
    }
    if (pairByKey.size === 0) return null;

    const conflicts = await tx.$queryRaw<PublishedPairRow[]>(
      publishedPairConflictSql(
        [...pairByKey.values()].map((group) => group.pair),
        productIds,
      ),
    );
    if (conflicts.length === 0) return null;

    const takenKeys = new Set(
      conflicts.map((row) => metadataPairKey(row.seoTitle, row.seoDescription)),
    );
    const blockedSlugs = [...pairByKey]
      .filter(([key]) => takenKeys.has(key))
      .flatMap(([, group]) => group.slugs);

    return { ok: false, reason: "SEO_PAIR_CONFLICT", blockedSlugs: blockedSlugs.sort() };
  }

  async function updateStatusesAtomically(
    input: BulkProductContentStatusUpdate,
  ): Promise<BulkProductContentStatusResult> {
    const { productIds, status } = input;

    return client.$transaction(async (tx) => {
      const productCount = await tx.productMirror.count({
        where: { id: { in: productIds } },
      });
      if (productCount !== productIds.length) {
        return { ok: false, reason: "PRODUCT_NOT_FOUND" } as const;
      }

      // B5: publishing is the only status that has a precondition, and it is checked under the same
      // lock and in the same transaction as the write it guards.
      if (status === "PUBLISHED") {
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${PUBLISHED_SEO_PAIR_LOCK_KEY})`);
        const blocked = await readBulkPublishBlock(tx, productIds);
        if (blocked) return blocked;
      }

      // Create content rows only for products that do not have one yet, then patch the single
      // website-owned status field for the whole batch. Unrelated editorial/Pancake fields are
      // never reconstructed from stale table data.
      await tx.productContent.createMany({
        data: productIds.map((productId) => ({ productId, status })),
        skipDuplicates: true,
      });
      await tx.productContent.updateMany({
        where: { productId: { in: productIds } },
        data: { status },
      });

      return { ok: true, updatedCount: productIds.length } as const;
    });
  }

  /**
   * Adds or removes exactly one validated collection slug for the selected products.
   *
   * The membership array is patched database-side (`array_append` / `array_remove`) instead of
   * being rebuilt from directory data, so a product's other collections, editorial fields, SEO
   * text and mirrored Pancake columns are never rewritten from a stale browser snapshot. Any
   * missing or no-longer-present target aborts the whole batch before the first write.
   */
  async function updateCollectionMembershipAtomically(
    input: BulkProductCollectionUpdate,
  ): Promise<BulkProductCollectionResult> {
    const { productIds, collectionSlug, operation } = input;

    try {
      return await client.$transaction(async (tx) => {
      const presentCount = await tx.productMirror.count({
        where: { id: { in: productIds }, isPresent: true },
      });
      if (presentCount !== productIds.length) {
        return { ok: false, reason: "PRODUCT_NOT_FOUND" } as const;
      }

      if (operation === "remove") {
        const changedCount = await tx.$executeRaw(Prisma.sql`
          UPDATE "ProductContent"
          SET "collectionSlugs" = ARRAY_REMOVE("collectionSlugs", ${collectionSlug}),
              "updatedAt" = NOW()
          WHERE "productId" = ANY(${productIds}::text[])
            AND ${collectionSlug} = ANY("collectionSlugs")
        `);
        return { ok: true, matchedCount: productIds.length, changedCount } as const;
      }

      // Products without content yet get a minimal DRAFT row carrying only the requested slug.
      const created = await tx.productContent.createMany({
        data: productIds.map((productId) => ({ productId, collectionSlugs: [collectionSlug] })),
        skipDuplicates: true,
      });

      // The editor accepts at most `collectionCount` memberships per product, so the limit is
      // enforced inside the UPDATE rather than by a separate probe: under Read Committed the
      // predicate is re-evaluated against whatever a concurrent editor save committed, so no
      // interleaving can push a product past a limit its own editor could no longer save back.
      const appended = await tx.$executeRaw(Prisma.sql`
        UPDATE "ProductContent"
        SET "collectionSlugs" = ARRAY_APPEND("collectionSlugs", ${collectionSlug}),
            "updatedAt" = NOW()
        WHERE "productId" = ANY(${productIds}::text[])
          AND NOT (${collectionSlug} = ANY("collectionSlugs"))
          AND COALESCE(ARRAY_LENGTH("collectionSlugs", 1), 0)
            < ${PRODUCT_CONTENT_LIMITS.collectionCount}
      `);

      // Anything still missing the slug was at the limit, so the whole batch rolls back.
      const remainingRows = await tx.$queryRaw<{ count: bigint }[]>(Prisma.sql`
        SELECT COUNT(*)::bigint AS "count"
        FROM "ProductContent"
        WHERE "productId" = ANY(${productIds}::text[])
          AND NOT (${collectionSlug} = ANY("collectionSlugs"))
      `);
      if (remainingRows[0] && membershipCountToNumber(remainingRows[0].count) > 0) {
        throw new CollectionMembershipLimitError();
      }

      return {
        ok: true,
        matchedCount: productIds.length,
        changedCount: created.count + appended,
      } as const;
      });
    } catch (error) {
      if (error instanceof CollectionMembershipLimitError) {
        return { ok: false, reason: "COLLECTION_LIMIT_REACHED" };
      }
      throw error;
    }
  }

  async function findForEditor(productId: string) {
    return client.productMirror.findUnique({
      where: { id: productId },
      select: {
        id: true,
        name: true,
        slug: true,
        primaryImageUrl: true,
        sourceDescription: true,
        isActive: true,
        variants: {
          orderBy: [{ color: "asc" }, { size: "asc" }, { id: "asc" }],
          select: {
            id: true,
            sku: true,
            color: true,
            size: true,
            pancakeRetailPrice: true,
            pancakeRetailPriceAfterDiscount: true,
            pancakeImageUrls: true,
            isPresent: true,
            isActive: true,
            warehouseStocks: {
              select: {
                quantity: true,
              },
            },
            // Composite membership is read from the persisted P17 mirror only. The editor never
            // infers a parent → child relation from names, SKUs or categories.
            compositeComponents: {
              orderBy: [{ componentVariantId: "asc" }],
              select: {
                quantity: true,
                componentVariant: {
                  select: {
                    id: true,
                    sku: true,
                    color: true,
                    size: true,
                    isPresent: true,
                    isActive: true,
                    warehouseStocks: {
                      orderBy: [{ pancakeWarehouseId: "asc" }],
                      select: { quantity: true },
                    },
                    product: {
                      select: {
                        id: true,
                        name: true,
                        slug: true,
                        isPresent: true,
                        isActive: true,
                      },
                    },
                  },
                },
              },
            },
            // Incoming membership belongs to the child variant's admin read model. It is used only
            // to expose the existing global VariantMirror activation state; the editor still never
            // creates, removes or infers composite edges.
            compositeParents: {
              orderBy: [{ parentVariantId: "asc" }],
              select: {
                quantity: true,
                parentVariant: {
                  select: {
                    id: true,
                    sku: true,
                    color: true,
                    size: true,
                    isPresent: true,
                    isActive: true,
                    product: {
                      select: {
                        id: true,
                        name: true,
                        slug: true,
                        isPresent: true,
                        isActive: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        content: {
          select: {
            status: true,
            editorialDescription: true,
            careInstructions: true,
            sizeGuide: true,
            seoTitle: true,
            seoDescription: true,
            collectionSlugs: true,
            updatedAt: true,
          },
        },
      },
    });
  }

  async function listForAdmin(limit: number) {
    return client.productMirror.findMany({
      take: parseAdminListLimit(limit),
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: {
        id: true,
        name: true,
        slug: true,
        primaryImageUrl: true,
        isActive: true,
        syncedAt: true,
        variants: {
          select: {
            pancakeRetailPrice: true,
            pancakeRetailPriceAfterDiscount: true,
            size: true,
            color: true,
          },
        },
        content: {
          select: {
            status: true,
            updatedAt: true,
          },
        },
      },
    });
  }

  /**
   * Server-derived row metrics for the products actually shown, in one bounded query. The row
   * health an operator reads therefore comes from the same database truth as the filters and
   * their counts, not from a second client-side interpretation of the mirrored data.
   */
  async function readDirectoryMetrics(
    productIds: readonly string[],
  ): Promise<ReadonlyMap<string, AdminProductDirectoryMetrics>> {
    if (productIds.length === 0) return new Map();

    const rows = await client.$queryRaw<DirectoryHealthMetricsRow[]>(
      directoryHealthMetricsSql(productIds),
    );
    return new Map(
      rows.map((row) => [
        row.id,
        {
          presentVariantCount: metricCountToNumber(row.presentVariantCount),
          activeVariantCount: metricCountToNumber(row.activeVariantCount),
          stockedInactiveCount: metricCountToNumber(row.stockedInactiveCount),
          missingImage: row.missingImage,
        },
      ]),
    );
  }

  /**
   * Selection, ordering and pagination run as one SQL statement over the whole catalog; Prisma
   * then hydrates only the page's rows by ID. That keeps the filter — health dimensions included —
   * a database predicate applied before pagination, with a bounded number of statements and no
   * catalog-sized parameter list.
   */
  async function listDirectoryPage({
    query,
    pageSize = ADMIN_PRODUCT_DIRECTORY_LIMITS.pageSize,
  }: Readonly<{ query: AdminProductDirectoryQuery; pageSize?: number }>) {
    const take = parseAdminPageSize(pageSize);
    const totalCount = directoryCountToNumber(
      await client.$queryRaw<DirectoryCountRow[]>(adminDirectoryCountSql(query)),
    );
    const totalPages = Math.max(Math.ceil(totalCount / take), 1);
    const page = Math.min(query.page, totalPages);

    const idRows = await client.$queryRaw<DirectoryIdRow[]>(Prisma.sql`
      SELECT p."id"
      ${adminDirectoryFrom}
      WHERE ${adminWhere(query)}
      ORDER BY ${adminSortSql(query.sort)}
      LIMIT ${take}
      OFFSET ${(page - 1) * take}
    `);
    const pageIds = idRows.map(({ id }) => id);

    const rows =
      pageIds.length === 0
        ? []
        : await client.productMirror.findMany({
            where: { id: { in: pageIds } },
            select: {
              id: true,
              name: true,
              slug: true,
              primaryImageUrl: true,
              isActive: true,
              syncedAt: true,
              variants: {
                select: {
                  pancakeRetailPrice: true,
                  pancakeRetailPriceAfterDiscount: true,
                  size: true,
                  color: true,
                },
              },
              content: {
                select: {
                  status: true,
                  collectionSlugs: true,
                  updatedAt: true,
                },
              },
            },
          });

    // The ordering is the SQL statement's, not the hydration query's.
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    const products = pageIds.map((id) => {
      const row = rowsById.get(id);
      if (!row) throw new Error("Admin directory result changed during read");
      return row;
    });

    const metrics = await readDirectoryMetrics(pageIds);

    return { products, metrics, page, pageSize: take, totalCount, totalPages };
  }

  /**
   * Counts each facet against the exact query its own link opens, using the same `adminWhere` as
   * `listDirectoryPage`. Callers pass the switch-to targets — see `buildAdminProductFacetTargets`
   * and `buildAdminProductHealthTargets` — so a chip's count and its href cannot drift apart.
   */
  async function countDirectoryFacets<Key extends string>(
    targets: Readonly<Record<Key, AdminProductDirectoryQuery>>,
  ): Promise<Record<Key, number>> {
    const entries = Object.entries(targets) as [Key, AdminProductDirectoryQuery][];
    const counted = await Promise.all(
      entries.map(
        async ([key, target]) =>
          [
            key,
            directoryCountToNumber(
              await client.$queryRaw<DirectoryCountRow[]>(adminDirectoryCountSql(target)),
            ),
          ] as const,
      ),
    );
    return Object.fromEntries(counted) as Record<Key, number>;
  }

  /**
   * `collectionSlugs` is a scalar list, so membership is unnested and grouped database-side. The
   * result set is one row per slug actually in use, not one per product, so this stays bounded by
   * the number of collections rather than by catalog size.
   *
   * A slug repeated inside one product's list counts once per occurrence, matching what the
   * membership editor writes back.
   */
  async function countProductsByCollectionSlug(): Promise<ReadonlyMap<string, number>> {
    const rows = await client.$queryRaw<CollectionMembershipRow[]>(Prisma.sql`
      SELECT collection AS "slug", COUNT(*)::bigint AS "count"
      FROM "ProductContent" pc
      CROSS JOIN LATERAL UNNEST(pc."collectionSlugs") AS collection
      GROUP BY collection
    `);
    return new Map(rows.map(({ slug, count }) => [slug, membershipCountToNumber(count)]));
  }

  /**
   * The read-only half of the same contract: which published products already hold this product's
   * current pair. It powers the admin's draft warning, so an editor sees the collision while the
   * copy is still a draft instead of discovering it at publish time.
   *
   * A product with incomplete copy has no pair to collide with and reports nothing — B5 lets a draft
   * be incomplete, and the editor's SEO health already surfaces that separately.
   */
  async function findPublishedPairConflicts(
    content: Readonly<{
      productId: string;
      seoTitle: string | null;
      seoDescription: string | null;
    }>,
  ): Promise<readonly string[]> {
    const readiness = readPublishMetadataReadiness(content);
    if (!readiness.ok) return [];

    const conflicts = await client.$queryRaw<PublishedPairRow[]>(
      publishedPairConflictSql([readiness.pair], [content.productId]),
    );
    return conflicts.map((row) => row.slug);
  }

  return {
    productExists,
    saveContent,
    findPublishedPairConflicts,
    updateStatusesAtomically,
    updateCollectionMembershipAtomically,
    findForEditor,
    listForAdmin,
    listDirectoryPage,
    countDirectoryFacets,
    countProductsByCollectionSlug,
  };
}
