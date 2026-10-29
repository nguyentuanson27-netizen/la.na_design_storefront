import assert from "node:assert/strict";
import test from "node:test";
import {
  computeListPriceVnd,
  classifyListPriceCampaign,
  minimumEffectiveListPricePercent,
  summarizeThresholdWarnings,
  resolveListPricePresentation,
} from "../../src/commerce/list-price.ts";
import { resolvePromotionPricing } from "../../src/commerce/promotion-pricing.ts";
import { readListPriceConfig } from "../../src/commerce/list-price-config.ts";

test("list price is the smallest 49/99 integer above the exact 120% floor", () => {
  for (const [pos, expected] of [
    [565000, 699000],
    [582500, 699000],
    [429000, 549000],
    [590000, 749000],
    [1, 49000],
  ])
    assert.equal(computeListPriceVnd(pos!), expected);
  for (const pos of [null, 0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER])
    assert.equal(computeListPriceVnd(pos), null);
  let seed = 1729;
  for (let i = 0; i < 10000; i++) {
    seed = (seed * 48271) % 2147483647;
    const pos = seed * 3000,
      list = computeListPriceVnd(pos)!;
    assert.equal(list % 50000, 49000);
    assert.ok(BigInt(list) * BigInt(10) >= BigInt(pos) * BigInt(12));
    assert.ok(BigInt(list - 50000) * BigInt(10) < BigInt(pos) * BigInt(12));
  }
});
test("campaign rounding and activation classifications distinguish unsafe prices from thresholds", () => {
  assert.deepEqual(classifyListPriceCampaign(590000, 25), {
    classification: "EFFECTIVE",
    price: 562000,
  });
  assert.equal(classifyListPriceCampaign(429000, 25).price, 412000);
  assert.equal(classifyListPriceCampaign(10000, 50).price, 25000);
  assert.equal(
    classifyListPriceCampaign(10000, 99).classification,
    "NON_POSITIVE_AFTER_ROUNDING",
  );
  assert.equal(
    classifyListPriceCampaign(590000, 10).classification,
    "THRESHOLD_NOT_MET",
  );
  assert.equal(
    classifyListPriceCampaign(Number.MAX_SAFE_INTEGER, 25).classification,
    "LIST_PRICE_UNAVAILABLE",
  );
  assert.equal(minimumEffectiveListPricePercent(590000), 22);
  assert.equal(minimumEffectiveListPricePercent(429000), 22);
});
test("display is independent of campaign membership and preserves the chosen identity", () => {
  const input = {
    variantId: "A",
    basePriceVnd: 429000,
    effectivePriceVnd: 429000,
    listPriceVnd: 549000,
    isDiscounted: false,
    enabled: true,
  };
  assert.deepEqual(resolveListPricePresentation(input), {
    variantId: "A",
    referencePriceVnd: 549000,
    displayPriceVnd: 429000,
    badgePercent: 22,
  });
  assert.equal(
    resolveListPricePresentation({ ...input, enabled: false }),
    null,
  );
  assert.equal(
    resolveListPricePresentation({ ...input, listPriceVnd: null }),
    null,
  );
  assert.equal(
    resolveListPricePresentation({ ...input, effectivePriceVnd: 430000 }),
    null,
  );
  assert.throws(() =>
    readListPriceConfig({ LIST_PRICE_CAMPAIGN_BASIS: "true" }),
  );
});
test("basis OFF preserves legacy money; ON never raises a customer's price", () => {
  const campaign = {
    id: "sale",
    name: "sale",
    kind: "PROMOTION" as const,
    discountType: "PERCENTAGE" as const,
    percentageValue: 25,
    fixedPriceVnd: null,
    startsAt: null,
    endsAt: null,
  };
  assert.equal(
    resolvePromotionPricing({
      basePriceVnd: 590000,
      campaigns: [campaign],
      now: new Date(0),
    }).effectivePriceVnd,
    442500,
  );
  for (let p = 1; p <= 99; p++)
    for (const pos of [
      1,
      10000,
      429000,
      565000,
      590000,
      Number.MAX_SAFE_INTEGER,
    ]) {
      const result = resolvePromotionPricing({
        basePriceVnd: pos,
        campaigns: [{ ...campaign, percentageValue: p }],
        now: new Date(0),
        campaignBasis: true,
      });
      assert.ok(
        result.effectivePriceVnd! > 0 && result.effectivePriceVnd! <= pos,
      );
    }
});

test("threshold warnings keep their count when a tiny POS has no effective integer percentage", () => {
  assert.equal(minimumEffectiveListPricePercent(1), null);
  assert.deepEqual(
    summarizeThresholdWarnings([
      { minimumPercent: null },
      { minimumPercent: 22 },
    ]),
    { count: 2, minimumPercent: null },
  );
});
