import { Prisma } from "../generated/prisma/client.ts";
import { expandScopeCategoryKeys } from "./gift-quantity-scope.ts";

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
 * One page of every addable, publicly listed product in a campaign's scope, in the order `/shop` uses (name, then
 * id), and the total.
 * No quote is run here: eligibility to unlock the offer is re-verified when the shopper adds a product.
 */
export async function listUpsellScopeProductPage(
  tx: RawReader,
  { scope, shopId, paidProductIds, page, pageSize }: Readonly<{ scope: UpsellScopeFacts; shopId: number; paidProductIds: readonly string[]; page: number; pageSize: number }>,
): Promise<Readonly<{ totalCount: number; productIds: readonly string[] }>> {
  const scoped = Prisma.sql`
    FROM ${upsellScopeRecordset([scope])} CROSS JOIN "ProductMirror" p
    WHERE ${upsellAddableProduct(shopId, paidProductIds)} AND ${UPSELL_PUBLICLY_LISTED} AND ${UPSELL_IN_SCOPE}`;
  const [counted, rows] = await Promise.all([
    tx.$queryRaw<{ total: bigint }[]>(Prisma.sql`SELECT count(*) AS "total" ${scoped}`),
    tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT p."id" ${scoped} ORDER BY p."name", p."id" LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`),
  ]);
  return { totalCount: Number(counted[0]?.total ?? 0), productIds: rows.map((row) => row.id) };
}
