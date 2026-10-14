/**
 * Publish-time checks that look at other rows (GQ09a): things a single campaign's own fields cannot
 * decide. They run inside the publish / Scheduled-edit transaction, under the shared pricing
 * revision lock, which orders campaign writes. RepeatableRead keeps price/eligibility/membership
 * reads on the same catalog snapshot even if a catalog writer commits before the freeze.
 *
 * - **Stack priority is unique** among stacking campaigns that are or will be effective (spec
 *   R-01). The check itself is `hasStackPriorityConflict` in `gift-quantity-stack-priority.ts`,
 *   shared with the legacy consent writer; the lifecycle service calls it here.
 * - **EX-21**: a tier whose largest value would leave some in-scope unit at less than 1 VND is
 *   refused now, when that is knowable. What only becomes true later (after a sync or a reprice) is
 *   handled at runtime by dropping the whole tier campaign; nothing is ever clamped.
 */

import { cartVariantCommerceSelection, resolveCartVariantCommerceFlags } from "./composite-subset-authority.ts";
import { isCommerceEligibleVariant } from "./storefront-cart.ts";
import { expandScopeCategoryKeys, type ScopeConfig } from "./gift-quantity-scope.ts";
import { findPricesInvalidForTier } from "./gift-quantity-tier.ts";
import { toQuantityTierConfig, type TierRuleInput } from "./gift-quantity-tier-rule.ts";
import type { Tx } from "./promotion-activation-service.ts";


export type PublishGuardError = "STACK_PRIORITY_CONFLICT" | "TIER_PRICE_BELOW_MINIMUM" | "TIER_PRICE_ELIGIBILITY_UNRESOLVED";

export const MAX_SPECIAL_PRICE_VARIANTS = 1_000;
type ScopePriceRead = { ok: true; lowest: number | null } | { ok: false; error: PublishGuardError };

/**
 * The lowest sellable unit price among the variants a scope covers, or null when it covers none.
 *
 * "Price" is exactly what the cart starts from: `pancakeRetailPrice` as a whole positive VND
 * (`isUsableBasePriceVnd`); `pancakeRetailPriceAfterDiscount` is deliberately not read (the approved
 * v1 decision in `promotion-pricing.ts`: website pricing ignores it). Only variants a buyer can actually put in a cart count (present and active,
 * public owner or authorized component/subset), so a retired variant never blocks a publish. One
 * aggregate statement plus one bounded authority lookup handles cheaper non-public variants. The lowest price
 * is the worst case for both tier units, so checking it covers every other unit.
 *
 * For a Scheduled edit that retains a Fixed snapshot, `frozenCampaignId` selects that stored
 * product set instead of current category membership. Publish, re-enable and real scope edits
 * validate current membership because they capture a new snapshot.
 *
 * This is what is *known now* from catalog prices. Earlier stack steps can only lower the price a
 * tier sees, so a tier that is safe here may still be dropped at runtime (`TIER_PRICE_INVALID`,
 * whole tier, never clamped); a tier that fails here fails for certain.
 */
export async function readLowestScopeUnitPriceVnd(
  tx: Pick<Tx, "$queryRaw" | "variantMirror">,
  scope: ScopeConfig,
  frozenCampaignId?: string,
): Promise<ScopePriceRead> {
  if (scope.mode === "GLOBAL_ALL_PAID_LINES") return { ok: true, lowest: null };
  const covered = [...expandScopeCategoryKeys(scope.categoryKeys)];
  const rows = await tx.$queryRaw<Array<{ lowest: number | null }>>`
    SELECT MIN(v."pancakeRetailPrice") AS "lowest"
    FROM "VariantMirror" v
    JOIN "ProductMirror" pm ON pm."id" = v."productId"
    WHERE v."isPresent" AND v."isActive" AND pm."isPresent" AND pm."isActive"
      AND v."pancakeRetailPrice" >= 1
      AND v."pancakeRetailPrice" <= 9007199254740991
      AND v."pancakeRetailPrice" = floor(v."pancakeRetailPrice")
      AND (
        (${frozenCampaignId ?? null}::text IS NOT NULL AND EXISTS (
          SELECT 1 FROM "GiftQuantityFrozenProduct" f
          WHERE f."campaignId" = ${frozenCampaignId ?? null}::text AND f."productId" = v."productId"
        ))
        OR (${frozenCampaignId ?? null}::text IS NULL
          AND (
            v."productId" = ANY(${[...scope.includeProductIds]}::text[])
            OR EXISTS (
              SELECT 1 FROM "ProductCategoryMembership" m
              WHERE m."productId" = v."productId" AND m."categoryKey" = ANY(${covered}::text[])
            )
          )
          AND NOT (v."productId" = ANY(${[...scope.excludeProductIds]}::text[]))
        )
      )
  `;
  const publicLowest = rows[0]?.lowest;
  let lowest = typeof publicLowest === "number" && Number.isSafeInteger(publicLowest) ? publicLowest : null;
  // Public variants were handled by the aggregate. Only cheaper non-public owners need the
  // component/subset authority. Bound that richer read and refuse if it cannot be resolved.
  const candidates = await tx.variantMirror.findMany({
    where: {
      isPresent: true, isActive: true,
      pancakeRetailPrice: { gte: 1, lte: Number.MAX_SAFE_INTEGER, ...(lowest === null ? {} : { lt: lowest }) },
      product: { AND: [
        { NOT: { isPresent: true, isActive: true } },
        frozenCampaignId === undefined
          ? { OR: [{ id: { in: [...scope.includeProductIds] } }, { categoryMemberships: { some: { categoryKey: { in: covered } } } }],
              id: { notIn: [...scope.excludeProductIds] } }
          : { giftQuantityFrozenProducts: { some: { campaignId: frozenCampaignId } } },
      ] },
    },
    select: {
      id: true, isPresent: true, isActive: true, pancakeRetailPrice: true,
      product: { select: { isPresent: true, isActive: true } },
      ...cartVariantCommerceSelection,
    },
    take: MAX_SPECIAL_PRICE_VARIANTS + 1,
    orderBy: { id: "asc" },
  });
  if (candidates.length > MAX_SPECIAL_PRICE_VARIANTS) return { ok: false, error: "TIER_PRICE_ELIGIBILITY_UNRESOLVED" };
  for (const variant of candidates) {
    const price = variant.pancakeRetailPrice;
    if (price === null || !Number.isSafeInteger(price)) continue;
    const flags = resolveCartVariantCommerceFlags(variant.product.isPresent, variant);
    if (isCommerceEligibleVariant(variant.product, { ...variant, ...flags })) {
      lowest = lowest === null ? price : Math.min(lowest, price);
    }
  }
  return { ok: true, lowest };
}

/** Whether the tier rule's largest value is safe for the lowest-priced unit in scope. */
export async function checkTierPriceSafety(
  tx: Pick<Tx, "$queryRaw" | "variantMirror">,
  rule: TierRuleInput,
  scope: ScopeConfig,
  frozenCampaignId?: string,
): Promise<PublishGuardError | null> {
  const config = toQuantityTierConfig(rule);
  if (config === null) return null;
  const price = await readLowestScopeUnitPriceVnd(tx, scope, frozenCampaignId);
  if (!price.ok) return price.error;
  if (price.lowest === null) return null;
  return findPricesInvalidForTier(config, [price.lowest]).length > 0 ? "TIER_PRICE_BELOW_MINIMUM" : null;
}
