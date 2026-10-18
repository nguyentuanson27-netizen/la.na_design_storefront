import assert from "node:assert/strict";
import test from "node:test";

import type { ActiveGiftQuantityCampaign } from "../../src/commerce/gift-quantity-candidate-repository.ts";
import type { ScopeConfig } from "../../src/commerce/gift-quantity-scope.ts";
import {
  areProductPromotionOffersOpen,
  selectProductPromotionOffers,
} from "../../src/commerce/product-promotion-offers.ts";

/**
 * The product page names the gift / quantity-tier campaigns covering it, and fails closed: a
 * promotion shown on the page and then refused at checkout is the false promise UX-03 forbids.
 */

const PRODUCT = "product-1";
const OPEN_ENV = {
  LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true",
  PANCAKE_SHOP_ID: "920942",
  LA_PANCAKE_LINE_LEVEL_PRICING_VERIFIED_SHOP_IDS: "920942",
};

type Campaign = Record<string, unknown>;

function tierCampaign(overrides: Campaign = {}): Campaign {
  return {
    id: "tier-1",
    kind: "QUANTITY_TIER",
    name: "Mua 2 giảm 10%",
    startsAt: null,
    endsAt: null,
    isEnabled: true,
    enabledAt: new Date("2026-10-01T00:00:00.000Z"),
    disabledAt: null,
    revision: 1,
    stackPriority: 1,
    stackingEnabled: false,
    scopeMode: "GLOBAL_ALL_PAID_LINES",
    categoryKeys: [],
    frozenAt: null,
    frozenCampaignRevision: null,
    giftTrigger: null,
    minimumQuantity: null,
    minimumSubtotalVnd: null,
    subtotalScope: null,
    awardMode: null,
    maxGiftsPerOrder: null,
    allowDuplicateGifts: null,
    tierBasis: "QUANTITY",
    tierUnit: "PERCENTAGE",
    tierDiscountedUnits: "ALL_ELIGIBLE_UNITS",
    tierSelectionPriority: null,
    targets: [],
    tiers: [{ minQuantity: 2, discountValue: 10 }],
    giftOptions: [],
    stackPeers: [],
    ...overrides,
  };
}

function giftCampaign(overrides: Campaign = {}): Campaign {
  return tierCampaign({
    id: "gift-1",
    kind: "GIFT_ITEM",
    name: "Tặng túi vải",
    tierBasis: null,
    tierUnit: null,
    tierDiscountedUnits: null,
    tiers: [],
    giftTrigger: "QUANTITY",
    minimumQuantity: 1,
    awardMode: "ONCE",
    maxGiftsPerOrder: 1,
    allowDuplicateGifts: false,
    giftOptions: [{ variantId: "gift-variant" }],
    ...overrides,
  });
}

const GLOBAL: ScopeConfig = { mode: "GLOBAL_ALL_PAID_LINES" };

function entry(campaign: Campaign, scope: ScopeConfig = GLOBAL): ActiveGiftQuantityCampaign {
  return { campaign: campaign as never, scope, frozen: null };
}

function dynamic(categoryKeys: string[], excludeProductIds: string[] = []): ScopeConfig {
  return { mode: "DYNAMIC_CATEGORY", categoryKeys, includeProductIds: [], excludeProductIds };
}

const facts = (categoryKeys: string[] = []) => ({ productId: PRODUCT, categoryKeys });

test("names the active campaigns that cover the product, by their own names", () => {
  assert.deepEqual(selectProductPromotionOffers([entry(tierCampaign()), entry(giftCampaign())], facts()), [
    { id: "tier-1", kind: "TIER", label: "Mua 2 giảm 10%" },
    { id: "gift-1", kind: "GIFT", label: "Tặng túi vải" },
  ]);
});

test("is closed while the feature is off or the shop cannot take a benefit order", () => {
  assert.equal(areProductPromotionOffersOpen(OPEN_ENV), true);
  for (const env of [
    { ...OPEN_ENV, LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "false" },
    { ...OPEN_ENV, LA_PANCAKE_LINE_LEVEL_PRICING_VERIFIED_SHOP_IDS: "" },
    { ...OPEN_ENV, LA_PANCAKE_LINE_LEVEL_PRICING_VERIFIED_SHOP_IDS: "123" },
    { ...OPEN_ENV, PANCAKE_SHOP_ID: "" },
  ]) {
    assert.equal(areProductPromotionOffersOpen(env), false, JSON.stringify(env));
  }
});

test("leaves out campaigns whose scope excludes the product or that cannot be honoured", () => {
  const offers = selectProductPromotionOffers(
    [
      entry(tierCampaign({ id: "elsewhere" }), dynamic(["aoDaiTet"])),
      // Exclude wins over a matching category.
      entry(tierCampaign({ id: "excluded" }), dynamic(["aoDai"], [PRODUCT])),
      // A ladder that does not validate.
      entry(tierCampaign({ id: "broken-ladder", tiers: [] })),
      // A gift campaign with nothing to give.
      entry(giftCampaign({ id: "no-gift", giftOptions: [] })),
      // A Fixed scope never frozen matches nothing.
      entry(tierCampaign({ id: "unfrozen" }), {
        mode: "FIXED_PRODUCT_SET",
        categoryKeys: [],
        includeProductIds: [PRODUCT],
        excludeProductIds: [],
      }),
      // A nameless campaign has nothing to say.
      entry(tierCampaign({ id: "nameless", name: "  " })),
      // Covered through its category.
      entry(tierCampaign({ id: "covered", name: "Mua 3 giảm 15%" }), dynamic(["aoDai"])),
    ],
    facts(["aoDai"]),
  );
  assert.deepEqual(offers.map((offer) => offer.id), ["covered"]);
});

test("names at most two", () => {
  const many = selectProductPromotionOffers(
    [entry(tierCampaign({ id: "a" })), entry(tierCampaign({ id: "b" })), entry(tierCampaign({ id: "c" }))],
    facts(),
  );
  assert.deepEqual(many.map((offer) => offer.id), ["a", "b"]);
});
