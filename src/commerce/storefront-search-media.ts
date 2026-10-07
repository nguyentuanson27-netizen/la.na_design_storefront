import { Prisma } from "../generated/prisma/client.ts";
import { MAX_MEDIA_CANDIDATES_SCANNED } from "./product-media.ts";

export type StorefrontSearchMediaCandidateRow = Readonly<{
  productId: string;
  url: string;
}>;

/**
 * Returns the same raw media candidate order as resolveStorefrontProductMedia, but applies the
 * candidate budget before rows cross the database boundary.
 *
 * Product primary comes first when non-empty, then active/present variants by Pancake variation id,
 * then each variant JSON array in its stored order, then component variant photography. Each active
 * component variant is expanded once, at its first parent in variation-id order (matching the
 * catalog's dedupe by component variant id), so shared components cannot consume the candidate
 * budget with duplicates. Non-string JSON entries never become resolver candidates, matching the
 * catalog projection's string-array parsing.
 */
export function storefrontSearchMediaCandidatesSql(
  productIds: readonly string[],
): Prisma.Sql {
  return Prisma.sql`
    SELECT
      p."id" AS "productId",
      bounded."url"
    FROM "ProductMirror" p
    CROSS JOIN LATERAL (
      SELECT
        candidate."url",
        candidate."sourceRank",
        candidate."variantRank",
        candidate."variantIdRank",
        candidate."imageRank"
      FROM (
        SELECT
          0 AS "sourceRank",
          ''::text AS "variantRank",
          ''::text AS "variantIdRank",
          0::bigint AS "imageRank",
          p."primaryImageUrl" AS "url"
        WHERE p."primaryImageUrl" IS NOT NULL
          AND p."primaryImageUrl" <> ''

        UNION ALL

        SELECT
          1 AS "sourceRank",
          v."pancakeVariationId" AS "variantRank",
          v."id" AS "variantIdRank",
          image."imageRank",
          image."value" #>> '{}' AS "url"
        FROM "VariantMirror" v
        CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS(
          CASE
            WHEN JSONB_TYPEOF(v."pancakeImageUrls") = 'array' THEN v."pancakeImageUrls"
            ELSE '[]'::jsonb
          END
        ) WITH ORDINALITY AS image("value", "imageRank")
        WHERE v."productId" = p."id"
          AND v."isPresent" = TRUE
          AND v."isActive" = TRUE
          AND JSONB_TYPEOF(image."value") = 'string'

        UNION ALL

        SELECT
          2 AS "sourceRank",
          component."variantRank",
          component."variantIdRank",
          image."imageRank",
          image."value" #>> '{}' AS "url"
        FROM (
          SELECT DISTINCT ON (cv."id")
            v."pancakeVariationId" AS "variantRank",
            cv."id" AS "variantIdRank",
            cv."pancakeImageUrls" AS "pancakeImageUrls"
          FROM "VariantMirror" v
          JOIN "CompositeComponentMirror" ccm ON ccm."parentVariantId" = v."id"
          JOIN "VariantMirror" cv ON ccm."componentVariantId" = cv."id"
          WHERE v."productId" = p."id"
            AND v."isPresent" = TRUE
            AND v."isActive" = TRUE
            AND cv."isPresent" = TRUE
            AND cv."isActive" = TRUE
          ORDER BY cv."id" ASC, v."pancakeVariationId" ASC, v."id" ASC
        ) component
        CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS(
          CASE
            WHEN JSONB_TYPEOF(component."pancakeImageUrls") = 'array' THEN component."pancakeImageUrls"
            ELSE '[]'::jsonb
          END
        ) WITH ORDINALITY AS image("value", "imageRank")
        WHERE JSONB_TYPEOF(image."value") = 'string'
          AND BTRIM(image."value" #>> '{}') <> ''
      ) candidate
      ORDER BY
        candidate."sourceRank" ASC,
        candidate."variantRank" ASC,
        candidate."variantIdRank" ASC,
        candidate."imageRank" ASC
      LIMIT ${MAX_MEDIA_CANDIDATES_SCANNED}
    ) bounded
    WHERE p."id" = ANY(${[...productIds]}::text[])
    ORDER BY
      p."id" ASC,
      bounded."sourceRank" ASC,
      bounded."variantRank" ASC,
      bounded."variantIdRank" ASC,
      bounded."imageRank" ASC
  `;
}
