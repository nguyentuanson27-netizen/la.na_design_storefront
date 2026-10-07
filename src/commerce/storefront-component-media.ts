import { Prisma, type PrismaClient } from "../generated/prisma/client.ts";
import { MAX_MEDIA_CANDIDATES_SCANNED } from "./product-media.ts";

export type StorefrontComponentMediaRow = Readonly<{
  productId: string;
  componentVariantId: string;
  url: string;
}>;

/** Component photography per product, keyed by product id then component variant id. */
export type ComponentMediaByProduct = ReadonlyMap<
  string,
  ReadonlyMap<string, readonly string[]>
>;

/**
 * Component photography candidates for composite products, bounded before rows cross the
 * database boundary so oversized external JSON arrays never reach the application.
 *
 * Each active/present component variant is expanded once, at its first active parent in
 * variation-id order. Rows are ordered by that parent, then component variant id, then stored
 * image order -- the order `extractCompositeComponentImageUrls` walks the catalog graph -- and
 * capped at MAX_MEDIA_CANDIDATES_SCANNED per product, the same budget the resolver enforces.
 * Non-string and blank JSON entries never become candidates, matching the catalog projection.
 */
export function storefrontComponentMediaSql(productIds: readonly string[]): Prisma.Sql {
  return Prisma.sql`
    SELECT
      p."id" AS "productId",
      bounded."componentVariantId",
      bounded."url"
    FROM "ProductMirror" p
    CROSS JOIN LATERAL (
      SELECT
        component."variantRank",
        component."componentVariantId",
        image."imageRank",
        image."value" #>> '{}' AS "url"
      FROM (
        SELECT DISTINCT ON (cv."id")
          v."pancakeVariationId" AS "variantRank",
          cv."id" AS "componentVariantId",
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
      ORDER BY
        component."variantRank" ASC,
        component."componentVariantId" ASC,
        image."imageRank" ASC
      LIMIT ${MAX_MEDIA_CANDIDATES_SCANNED}
    ) bounded
    WHERE p."id" = ANY(${[...productIds]}::text[])
    ORDER BY
      p."id" ASC,
      bounded."variantRank" ASC,
      bounded."componentVariantId" ASC,
      bounded."imageRank" ASC
  `;
}

export function groupComponentMediaRows(
  rows: readonly StorefrontComponentMediaRow[],
): ComponentMediaByProduct {
  const byProduct = new Map<string, Map<string, string[]>>();
  for (const row of rows) {
    let byComponent = byProduct.get(row.productId);
    if (!byComponent) {
      byComponent = new Map();
      byProduct.set(row.productId, byComponent);
    }
    const urls = byComponent.get(row.componentVariantId);
    if (urls) urls.push(row.url);
    else byComponent.set(row.componentVariantId, [row.url]);
  }
  return byProduct;
}

export async function fetchComponentMediaByProduct(
  client: Pick<PrismaClient, "$queryRaw">,
  productIds: readonly string[],
): Promise<ComponentMediaByProduct> {
  if (productIds.length === 0) return new Map();
  const rows = await client.$queryRaw<StorefrontComponentMediaRow[]>(
    storefrontComponentMediaSql(productIds),
  );
  return groupComponentMediaRows(rows);
}

/**
 * Loads component photography only for the composite products in `products`; a catalog page with
 * no composite parents issues no extra query.
 */
export function fetchComponentMediaForProducts(
  client: Pick<PrismaClient, "$queryRaw">,
  products: readonly Readonly<{
    id: string;
    variants: readonly Readonly<{ compositeComponents: readonly unknown[] }>[];
  }>[],
): Promise<ComponentMediaByProduct> {
  return fetchComponentMediaByProduct(
    client,
    products
      .filter((product) => product.variants.some((variant) => variant.compositeComponents.length > 0))
      .map((product) => product.id),
  );
}
