import assert from "node:assert/strict";
import test from "node:test";

import { checkTierPriceSafety, MAX_SPECIAL_PRICE_VARIANTS } from "../../src/commerce/gift-quantity-publish-guards.ts";

const rule = {
  unit: "FIXED_AMOUNT_PER_UNIT_VND", discountedUnits: "ALL_ELIGIBLE_UNITS", selectionPriority: null,
  tiers: [{ minQuantity: 2, discountValue: 50_000 }], stackingEnabled: false, stackPriority: null, peers: [],
} as const;
const scope = { mode: "DYNAMIC_CATEGORY", categoryKeys: ["setVay"], includeProductIds: [], excludeProductIds: [] } as const;

test("price guard refuses unresolved special-variant eligibility instead of accepting a truncated price set", async () => {
  let limit = 0;
  const client = {
    $queryRaw: async () => [{ lowest: 100_000 }],
    variantMirror: { findMany: async ({ take }: { take: number }) => {
      limit = take;
      return Array.from({ length: MAX_SPECIAL_PRICE_VARIANTS + 1 }, () => null);
    } },
  };
  assert.equal(await checkTierPriceSafety(client as never, rule, scope), "TIER_PRICE_ELIGIBILITY_UNRESOLVED");
  assert.equal(limit, MAX_SPECIAL_PRICE_VARIANTS + 1);
});
