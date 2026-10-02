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
 * then each variant JSON array in its stored order. Non-string JSON entries never become resolver
 * candidates, matching the catalog projection's string-array parsing.
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
