import { Prisma } from "../generated/prisma/client.ts";
import { expandScopeCategoryKeys } from "./gift-quantity-scope.ts";
import { buildVariantStockCte } from "./storefront-catalog.ts";

/**
 * Which products a gift campaign's scope covers, as one SQL fragment shared by the checkout banner's candidate
 * discovery and the `/offers/eligible` listing, so the two can never disagree about what "in scope" means.
 *
 * The fragments read the aliases `s` (one `UpsellScopeFacts` row via `jsonb_to_recordset`) and `p` (ProductMirror).
 */
export type UpsellScopeFacts = Readonly<{
  campaignId: string;
  mode: string;
  frozen: boolean;
  includes: readonly string[];
  excludes: readonly string[];
  keys: readonly string[];
}>;

type ScopeEntry = Readonly<{
  campaign: Readonly<{ id: string; frozenAt: Date | null; frozenCampaignRevision: number | null }>;
  scope: Readonly<{ mode: string; includeProductIds?: readonly string[]; excludeProductIds?: readonly string[]; categoryKeys?: readonly string[] }>;
}>;

export function upsellScopeFacts({ campaign: c, scope }: ScopeEntry): UpsellScopeFacts {
  const global = scope.mode === "GLOBAL_ALL_PAID_LINES";
  return {
    campaignId: c.id, mode: scope.mode, frozen: c.frozenAt !== null && c.frozenCampaignRevision !== null,
    includes: global ? [] : scope.includeProductIds ?? [],
    excludes: global ? [] : scope.excludeProductIds ?? [],
    keys: global ? [] : [...expandScopeCategoryKeys(scope.categoryKeys ?? [])],
  };
}

/** `jsonb_to_recordset(...) AS s(...)` over the given scopes. */
export const upsellScopeRecordset = (scopes: readonly UpsellScopeFacts[]) => Prisma.sql`
  jsonb_to_recordset(${JSON.stringify(scopes)}::jsonb)
    AS s("campaignId" text, mode text, frozen boolean, includes jsonb, excludes jsonb, keys jsonb)`;

/** A product the shopper could still add: a live product with a live variant that is not already in the cart. */
export const upsellAddableProduct = (shopId: number, paidProductIds: readonly string[]) => Prisma.sql`
  p."pancakeShopId" = ${shopId} AND p."isActive" AND p."isPresent"
  AND NOT (p."id" = ANY(${paidProductIds}::text[]))
  AND EXISTS (SELECT 1 FROM "VariantMirror" v WHERE v."productId" = p."id" AND v."isActive" AND v."isPresent")`;

/**
 * The rule every public listing applies by default (`buildBaseProductFilters`): a product with a variant that is a
 * component of a combo is not listed. Applied by the `/offers/eligible` listing and, so that the banner never links to
 * an empty page, by the checkout banner's candidate discovery as well.
 */
export const UPSELL_PUBLICLY_LISTED = Prisma.sql`NOT EXISTS (
  SELECT 1 FROM "CompositeComponentMirror" ccm JOIN "VariantMirror" cv ON ccm."componentVariantId" = cv."id"
  WHERE cv."productId" = p."id")`;

/** `p` belongs to the scope `s`: whole catalog, a frozen fixed set, or include/exclude/category membership. */
export const UPSELL_IN_SCOPE = Prisma.sql`(
  s.mode = 'GLOBAL_ALL_PAID_LINES'
  OR (s.mode = 'FIXED_PRODUCT_SET' AND s.frozen AND EXISTS (
    SELECT 1 FROM "GiftQuantityFrozenProduct" f WHERE f."campaignId" = s."campaignId" AND f."productId" = p."id"))
  OR (s.mode = 'DYNAMIC_CATEGORY'
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(s.excludes) e WHERE e = p."id")
    AND (EXISTS (SELECT 1 FROM jsonb_array_elements_text(s.includes) i WHERE i = p."id")
      OR EXISTS (SELECT 1 FROM "ProductCategoryMembership" m WHERE m."productId" = p."id"
        AND m."categoryKey" IN (SELECT jsonb_array_elements_text(s.keys)))))
)`;

type RawReader = Readonly<{ $queryRaw: <T = unknown>(query: Prisma.Sql) => Prisma.PrismaPromise<T> }>;

/**
 * One page of every addable, publicly listed product in a campaign's scope, and the total. Products with a sellable
 * variant come first, then the cheapest sellable price, then name and id so that paging is stable.
 * No quote is run here: eligibility to unlock the offer is re-verified when the shopper adds a product.
 */
export async function listUpsellScopeProductPage(
  tx: RawReader,
  { scope, shopId, paidProductIds, page, pageSize, now = new Date(), cursor }: Readonly<{
    scope: UpsellScopeFacts; shopId: number; paidProductIds: readonly string[]; page: number; pageSize: number; now?: Date;
    /**
     * Continue a listing the shopper is already looking at: skip `excludeProductIds` (what is on screen) and the first
     * `skip` products of what remains, instead of paging by `page`. The sort moves with stock and price, so an OFFSET
     * computed on a later snapshot can repeat a product and skip another; excluding what was shown cannot.
     */
    cursor?: Readonly<{ excludeProductIds: readonly string[]; skip: number }>;
  }>,
): Promise<Readonly<{ totalCount: number; productIds: readonly string[] }>> {
  const from = Prisma.sql`FROM ${upsellScopeRecordset([scope])} CROSS JOIN "ProductMirror" p`;
  const notShown = cursor ? Prisma.sql` AND NOT (p."id" = ANY(${cursor.excludeProductIds}::text[]))` : Prisma.empty;
  const where = Prisma.sql`
    WHERE ${upsellAddableProduct(shopId, paidProductIds)} AND ${UPSELL_PUBLICLY_LISTED} AND ${UPSELL_IN_SCOPE}${notShown}`;
  const offset = cursor ? cursor.skip : (page - 1) * pageSize;
  // One pass over the variant projection, joined once, instead of a correlated subquery per product (the projection is
  // not materialized, so a per-product subquery would re-run it for every product in the scope). A product is in stock
  // when any variant is sellable, and it is priced by its cheapest *sellable* variant: a cheap sold-out size must not
  // pull a product up the list when the shopper can only buy its dearer sizes. A product with nothing sellable falls back
  // to its cheapest variant, and one with no priced variant sorts last.
  const productRank = Prisma.sql`, "upsell_product_rank" AS (
    SELECT
      vf."productId",
      BOOL_OR(vf."sellableStock" > 0) AS "inStock",
      COALESCE(
        MIN(vf."resolvedPrice") FILTER (WHERE vf."sellableStock" > 0),
        MIN(vf."resolvedPrice")
      ) AS "sortPrice"
    FROM "variant_stock" vf
    GROUP BY vf."productId"
  )`;
  const [counted, rows] = await Promise.all([
    tx.$queryRaw<{ total: bigint }[]>(Prisma.sql`SELECT count(*) AS "total" ${from} ${where}`),
    tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      ${buildVariantStockCte(now)}${productRank}
      SELECT p."id" ${from}
      LEFT JOIN "upsell_product_rank" r ON r."productId" = p."id"
      ${where}
      ORDER BY CASE WHEN COALESCE(r."inStock", FALSE) THEN 0 ELSE 1 END ASC,
        r."sortPrice" ASC NULLS LAST, p."name" ASC, p."id" ASC
      LIMIT ${pageSize} OFFSET ${offset}`),
  ]);
  return { totalCount: Number(counted[0]?.total ?? 0), productIds: rows.map((row) => row.id) };
}
