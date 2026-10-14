/**
 * Publish-time checks that look at other rows (GQ09a): things a single campaign's own fields cannot
 * decide. They run inside the publish / Scheduled-edit transaction, under the shared pricing
 * revision lock, so "nobody else uses this priority" and "these are the prices" cannot change
 * between the check and the commit.
 *
 * - **Stack priority is unique** among stacking campaigns that are or will be effective (spec
 *   R-01). The check itself is `hasStackPriorityConflict` in `gift-quantity-stack-priority.ts`,
 *   shared with the legacy consent writer; the lifecycle service calls it here.
 * - **EX-21**: a tier whose largest value would leave some in-scope unit at less than 1 VND is
 *   refused now, when that is knowable. What only becomes true later (after a sync or a reprice) is
 *   handled at runtime by dropping the whole tier campaign; nothing is ever clamped.
 */

import { expandScopeCategoryKeys, type ScopeConfig } from "./gift-quantity-scope.ts";
import { findPricesInvalidForTier } from "./gift-quantity-tier.ts";
import { toQuantityTierConfig, type TierRuleInput } from "./gift-quantity-tier-rule.ts";
import type { Tx } from "./promotion-activation-service.ts";


export type PublishGuardError = "STACK_PRIORITY_CONFLICT" | "TIER_PRICE_BELOW_MINIMUM";

/**
 * The lowest sellable unit price among the variants a scope covers, or null when it covers none.
 *
 * "Price" is exactly what the cart starts from: `pancakeRetailPrice` as a whole positive VND
 * (`isUsableBasePriceVnd`); `pancakeRetailPriceAfterDiscount` is deliberately not read (the approved
 * v1 decision in `promotion-pricing.ts`: website pricing ignores it). Only variants a buyer can actually put in a cart count (present and active,
 * product present and active), so a retired variant never blocks a publish. One aggregate
 * statement, so it costs the same whatever the scope's size and sees one snapshot. The lowest price
 * is the worst case for both tier units, so checking it covers every other unit.
 *
 * This is what is *known now* from catalog prices. Earlier stack steps can only lower the price a
 * tier sees, so a tier that is safe here may still be dropped at runtime (`TIER_PRICE_INVALID`,
 * whole tier, never clamped); a tier that fails here fails for certain.
 */
export async function readLowestScopeUnitPriceVnd(
  tx: Pick<Tx, "$queryRaw">,
  scope: ScopeConfig,
): Promise<number | null> {
  if (scope.mode === "GLOBAL_ALL_PAID_LINES") return null;
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
        v."productId" = ANY(${[...scope.includeProductIds]}::text[])
        OR EXISTS (
          SELECT 1 FROM "ProductCategoryMembership" m
          WHERE m."productId" = v."productId" AND m."categoryKey" = ANY(${covered}::text[])
        )
      )
      AND NOT (v."productId" = ANY(${[...scope.excludeProductIds]}::text[]))
  `;
  const lowest = rows[0]?.lowest;
  return typeof lowest === "number" && Number.isSafeInteger(lowest) ? lowest : null;
}

/** Whether the tier rule's largest value is safe for the lowest-priced unit in scope. */
export async function checkTierPriceSafety(
  tx: Pick<Tx, "$queryRaw">,
  rule: TierRuleInput,
  scope: ScopeConfig,
): Promise<PublishGuardError | null> {
  const config = toQuantityTierConfig(rule);
  if (config === null) return null;
  const lowest = await readLowestScopeUnitPriceVnd(tx, scope);
  if (lowest === null) return null;
  return findPricesInvalidForTier(config, [lowest]).length > 0 ? "TIER_PRICE_BELOW_MINIMUM" : null;
}
