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
    WITH "search_media_candidates" AS (
      SELECT
        p."id" AS "productId",
        0 AS "sourceRank",
        ''::text AS "variantRank",
        ''::text AS "variantIdRank",
        0::bigint AS "imageRank",
        p."primaryImageUrl" AS "url"
      FROM "ProductMirror" p
      WHERE p."id" = ANY(${[...productIds]}::text[])
        AND p."primaryImageUrl" IS NOT NULL
        AND p."primaryImageUrl" <> ''

      UNION ALL

      SELECT
        v."productId",
        1 AS "sourceRank",
        v."pancakeVariationId" AS "variantRank",
        v."id" AS "variantIdRank",
        image."imageRank",
        image."value" #>> '{}' AS "url"
      FROM "VariantMirror" v
      CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS(v."pancakeImageUrls")
        WITH ORDINALITY AS image("value", "imageRank")
      WHERE v."productId" = ANY(${[...productIds]}::text[])
        AND v."isPresent" = TRUE
        AND v."isActive" = TRUE
        AND JSONB_TYPEOF(v."pancakeImageUrls") = 'array'
        AND JSONB_TYPEOF(image."value") = 'string'
    ),
    "ranked_search_media_candidates" AS (
      SELECT
        candidate."productId",
        candidate."url",
        ROW_NUMBER() OVER (
          PARTITION BY candidate."productId"
          ORDER BY
            candidate."sourceRank" ASC,
            candidate."variantRank" ASC,
            candidate."variantIdRank" ASC,
            candidate."imageRank" ASC
        ) AS "candidateRank"
      FROM "search_media_candidates" candidate
    )
    SELECT
      ranked."productId",
      ranked."url"
    FROM "ranked_search_media_candidates" ranked
    WHERE ranked."candidateRank" <= ${MAX_MEDIA_CANDIDATES_SCANNED}
    ORDER BY ranked."productId" ASC, ranked."candidateRank" ASC
  `;
}
