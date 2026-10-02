import { Prisma } from "../generated/prisma/client.ts";
import { MAX_MEDIA_CANDIDATES_SCANNED } from "./product-media.ts";

/**
 * Database-side equivalents of the operational health predicates the admin directory filters on.
 *
 * These exist because the hardest dimensions cannot be expressed as Prisma predicates:
 * `stocked-inactive` needs the *summed* warehouse quantity per variant (several warehouses can
 * cancel out to zero or below), `missing-image` needs the exact effective storefront media
 * resolution, and the two content dimensions need `String.prototype.trim()` semantics rather than
 * Postgres' own. All of them must be evaluated against the full catalog before pagination, so they
 * are written as bounded set-based SQL instead of post-filtering the current page.
 */

/**
 * The whitespace `String.prototype.trim()` strips: WhiteSpace + LineTerminator, i.e. the ASCII
 * blanks plus NBSP, ZWNBSP, LS/PS and the Unicode space separators. `parseTrustedProductImageUrl`
 * trims before every other check, so the SQL mirror has to trim exactly the same set.
 */
const JS_TRIM_CLASS =
  "[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]";

/** The anchored form of {@link JS_TRIM_CLASS}: what `String.prototype.trim()` removes from an end. */
const JS_TRIM_PATTERN = `^${JS_TRIM_CLASS}+|${JS_TRIM_CLASS}+$`;

/** The reviewed Pancake CDN path shape, mirroring `PANCAKE_MEDIA_PATH_REGEX`. */
const PANCAKE_MEDIA_PATH_PATTERN =
  "^/[a-zA-Z0-9_-]+/[0-9]+/[0-9]+/[0-9]+/[a-zA-Z0-9_.-]+\\.(jpg|png)$";

const TRUSTED_IMAGE_AUTHORITY = "content.pancake.vn";
const MAX_IMAGE_URL_LENGTH = 4096;

/**
 * Normalizes one raw candidate URL the way `parseTrustedProductImageUrl` does before it decides:
 *
 * - `trimmed` is the JS-trimmed input every raw check (length, `..`, authority) runs against;
 * - `authority` is the raw authority slice, so a credential, port or embedded control character
 *   fails exactly as it does in the parser;
 * - `pathFinal` is the WHATWG-normalized path: query/fragment removed, tab/newline/carriage
 *   return stripped anywhere in the URL, and `/./` segments resolved.
 */
function normalizedCandidateColumns(url: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT
      input."trimmed",
      SPLIT_PART(SUBSTR(input."trimmed", 9), '/', 1) AS "authority",
      REGEXP_REPLACE(
        TRANSLATE(
          SPLIT_PART(SPLIT_PART(
            SUBSTR(input."trimmed", 9 + LENGTH(SPLIT_PART(SUBSTR(input."trimmed", 9), '/', 1))),
            '#', 1
          ), '?', 1),
          CHR(9) || CHR(10) || CHR(13),
          ''
        ),
        '(/\\.)+/', '/', 'g'
      ) AS "pathFinal"
    FROM (
      SELECT REGEXP_REPLACE(
        ${url},
        ${JS_TRIM_PATTERN},
        '',
        'g'
      ) AS "trimmed"
    ) input
  `;
}

/** The trust decision over the normalized columns produced by `normalizedCandidateColumns`. */
const TRUSTED_CANDIDATE_CONDITION = Prisma.sql`
  norm."trimmed" <> ''
  AND LENGTH(norm."trimmed") <= ${MAX_IMAGE_URL_LENGTH}
  AND POSITION('/..' IN norm."trimmed") = 0
  AND POSITION('../' IN norm."trimmed") = 0
  AND POSITION('%2e%2e' IN LOWER(norm."trimmed")) = 0
  AND LOWER(LEFT(norm."trimmed", 8)) = 'https://'
  AND norm."authority" = ${TRUSTED_IMAGE_AUTHORITY}
  AND POSITION('..' IN norm."pathFinal") = 0
  AND norm."pathFinal" ~ ${PANCAKE_MEDIA_PATH_PATTERN}
`;

/** Single-value parity probe used by the media parity regression. */
export function trustedProductImageUrlProbeSql(url: string): Prisma.Sql {
  return Prisma.sql`
    SELECT (${TRUSTED_CANDIDATE_CONDITION}) AS "trusted"
    FROM (${normalizedCandidateColumns(Prisma.sql`${url}`)}) norm
  `;
}

function scopeCondition(column: Prisma.Sql, productIds: readonly string[] | null): Prisma.Sql {
  return productIds === null
    ? Prisma.sql`TRUE`
    : Prisma.sql`${column} = ANY(${[...productIds]}::text[])`;
}

/**
 * `TRUE` when the effective storefront media resolution would return no primary image for the
 * product bound to `productAlias`.
 *
 * The candidate list is the resolver's own, in its own order: `ProductMirror.primaryImageUrl`
 * first, then the `pancakeImageUrls` string entries of variants with `isPresent = true AND
 * isActive = true` ordered by `pancakeVariationId ASC`, each array's order preserved. `LIMIT
 * MAX_MEDIA_CANDIDATES_SCANNED` is the resolver's raw-candidate scan budget, so a trusted
 * candidate at #100 clears the blocker and one at #101 does not.
 *
 * Written as a correlated `NOT EXISTS` so the per-candidate trust normalization stops at the
 * first trusted candidate instead of being evaluated for the whole catalog's media.
 */
export function missingImageCondition(productAlias: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    NOT EXISTS (
      SELECT 1
      FROM (
        SELECT candidate."url"
        FROM (
          SELECT
            0 AS "sourceRank",
            0::bigint AS "variantRank",
            0::bigint AS "imageRank",
            ${productAlias}."primaryImageUrl" AS "url"
          WHERE ${productAlias}."primaryImageUrl" IS NOT NULL
            AND ${productAlias}."primaryImageUrl" <> ''
          UNION ALL
          SELECT
            1 AS "sourceRank",
            ordered."variantRank",
            image."imageRank",
            image."value" #>> '{}' AS "url"
          FROM (
            SELECT
              v."pancakeImageUrls",
              ROW_NUMBER() OVER (ORDER BY v."pancakeVariationId" ASC) AS "variantRank"
            FROM "VariantMirror" v
            WHERE v."productId" = ${productAlias}."id"
              AND v."isPresent" = TRUE
              AND v."isActive" = TRUE
              AND JSONB_TYPEOF(v."pancakeImageUrls") = 'array'
          ) ordered
          CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS(ordered."pancakeImageUrls")
            WITH ORDINALITY AS image("value", "imageRank")
          WHERE JSONB_TYPEOF(image."value") = 'string'
        ) candidate
        ORDER BY candidate."sourceRank" ASC, candidate."variantRank" ASC, candidate."imageRank" ASC
        LIMIT ${MAX_MEDIA_CANDIDATES_SCANNED}
      ) scanned
      CROSS JOIN LATERAL (${normalizedCandidateColumns(Prisma.sql`scanned."url"`)}) norm
      WHERE ${TRUSTED_CANDIDATE_CONDITION}
    )
  `;
}

/**
 * Present variants with their summed warehouse stock.
 *
 * A non-finite mirrored quantity makes the sum unusable rather than positive, matching the
 * quick-action's refusal to treat malformed stock as sellable.
 */
function variantStockCte(productIds: readonly string[] | null): Prisma.Sql {
  return Prisma.sql`
    "health_variant_stock" AS (
      SELECT
        v."productId",
        v."id",
        v."isActive",
        CASE
          WHEN BOOL_AND(
            ws."quantity" IS NULL
            OR (
              ws."quantity" <> 'NaN'::float8
              AND ws."quantity" <> 'Infinity'::float8
              AND ws."quantity" <> '-Infinity'::float8
            )
          ) THEN COALESCE(SUM(ws."quantity"), 0::float8)
          ELSE NULL
        END AS "stock"
      FROM "VariantMirror" v
      LEFT JOIN "WarehouseStock" ws ON ws."variantId" = v."id"
      WHERE v."isPresent" = TRUE
        AND ${scopeCondition(Prisma.sql`v."productId"`, productIds)}
      GROUP BY v."id"
    )
  `;
}

/**
 * `TRUE` when the product bound to `productAlias` has at least one present inactive variant whose
 * **summed** warehouse stock is positive.
 *
 * The sum is the point: several warehouses can cancel each other out, so
 * `warehouseStocks: { some: { quantity: { gt: 0 } } }` would call a variant stocked when nothing
 * is sellable. A non-finite mirrored quantity makes the sum unusable rather than positive, which
 * is the same reading the combined quick action applies before it activates anything.
 */
export function stockedInactiveCondition(productAlias: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    EXISTS (
      SELECT 1
      FROM "VariantMirror" v
      LEFT JOIN "WarehouseStock" ws ON ws."variantId" = v."id"
      WHERE v."productId" = ${productAlias}."id"
        AND v."isPresent" = TRUE
        AND v."isActive" = FALSE
      GROUP BY v."id"
      HAVING BOOL_AND(
          ws."quantity" IS NULL
          OR (
            ws."quantity" <> 'NaN'::float8
            AND ws."quantity" <> 'Infinity'::float8
            AND ws."quantity" <> '-Infinity'::float8
          )
        )
        AND COALESCE(SUM(ws."quantity"), 0::float8) > 0
    )
  `;
}

/** `TRUE` when the product has no present variant that is active. */
export function zeroActiveCondition(productAlias: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    NOT EXISTS (
      SELECT 1
      FROM "VariantMirror" v
      WHERE v."productId" = ${productAlias}."id"
        AND v."isPresent" = TRUE
        AND v."isActive" = TRUE
    )
  `;
}

/**
 * Server-derived row metrics for one bounded set of directory rows. One query for the whole page
 * rather than a per-product read, so the directory keeps a fixed query count.
 */
export function directoryHealthMetricsSql(productIds: readonly string[]): Prisma.Sql {
  return Prisma.sql`
    WITH ${variantStockCte(productIds)}
    SELECT
      p."id",
      COUNT(stock."id")::bigint AS "presentVariantCount",
      COUNT(stock."id") FILTER (WHERE stock."isActive")::bigint AS "activeVariantCount",
      COUNT(stock."id") FILTER (
        WHERE stock."isActive" = FALSE AND stock."stock" > 0
      )::bigint AS "stockedInactiveCount",
      ${missingImageCondition(Prisma.sql`p`)} AS "missingImage"
    FROM "ProductMirror" p
    LEFT JOIN "health_variant_stock" stock ON stock."productId" = p."id"
    WHERE p."id" = ANY(${[...productIds]}::text[])
    GROUP BY p."id"
  `;
}

/**
 * `TRUE` when `column` holds no operator-written text, mirroring the `hasText` reading
 * `src/commerce/catalog-acceptance.ts` applies to the same fields: a value counts as present only
 * when characters survive `String.prototype.trim()`.
 *
 * `BTRIM` would not do. Postgres trims ASCII blanks only, while the editor's own
 * `parseTextField` trims the full JS whitespace set before deciding whether to persist `NULL`, so
 * a legacy NBSP-only value has to read as missing on both sides. `NULL` is missing as well, which
 * is what makes a product with no `ProductContent` row — the directory's unedited draft — match.
 */
function blankTextCondition(column: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(
    ${column} IS NULL
    OR ${jsTrimmedSql(column)} = ''
  )`;
}

/**
 * `column` with exactly the whitespace `String.prototype.trim()` strips removed from both ends.
 *
 * Exported because the B5 published-metadata pair comparison has to trim the same set on the same
 * columns: one trim authority, so a value cannot read as blank to the health filters and as text to
 * the publish gate.
 */
export function jsTrimmedSql(column: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`REGEXP_REPLACE(${column}, ${JS_TRIM_PATTERN}, '', 'g')`;
}

/**
 * `TRUE` when the product bound to `contentAlias` still needs SEO copy written.
 *
 * Both fields are required, and either one alone leaves the product incomplete. That is the
 * catalog acceptance report's own `missingPublishedSeo` reading — `hasText(seoTitle) &&
 * hasText(seoDescription)` — and the two fields are exactly what the admin editor's SEO section
 * owns. It is deliberately *not* gated on `PUBLISHED`: acceptance measures what reaches the
 * storefront, whereas this asks whether an operator has written the copy at all, and publication
 * is already the directory's own composable `status` dimension.
 */
export function missingSeoCondition(contentAlias: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(
    ${blankTextCondition(Prisma.sql`${contentAlias}."seoTitle"`)}
    OR ${blankTextCondition(Prisma.sql`${contentAlias}."seoDescription"`)}
  )`;
}

/**
 * `TRUE` when the product bound to `contentAlias` still needs its editorial description written.
 *
 * The description alone decides it, matching the acceptance report's `missingPublishedEditorial`.
 * `careInstructions` and `sizeGuide` sit in the same editor section but no source treats them as
 * required: the PDP drops their notes section entirely when they are absent, and neither reaches
 * structured data. Folding them in would report products as incomplete that the repository's own
 * readiness contract calls complete.
 */
export function missingEditorialCondition(contentAlias: Prisma.Sql): Prisma.Sql {
  return blankTextCondition(Prisma.sql`${contentAlias}."editorialDescription"`);
}
