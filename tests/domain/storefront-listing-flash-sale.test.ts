import assert from "node:assert/strict";
import test from "node:test";

import type { ApplicablePromotionCampaign } from "../../src/commerce/promotion-pricing.ts";
import { resolveStorefrontListingFlashSale } from "../../src/commerce/storefront-listing-flash-sale.ts";
import type { StorefrontVariantFacts } from "../../src/commerce/storefront-product.ts";
import { parseCategoryDiscoverySearchParams } from "../../src/commerce/category-discovery-url.ts";
import { buildCategoryViewModel } from "../../src/routes/category-model.ts";
import { CATEGORY_DESTINATIONS } from "../../src/routes/category-destinations.ts";
import type { TrackingEvent } from "../../src/tracking/commerce-events.ts";

/** Ordinary listings (collection, category, `/shop`) resolve the Flash card the Flash listing shows. */

const now = new Date("2026-10-20T03:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function variant(id: string, size: string, overrides: Partial<StorefrontVariantFacts> = {}) {
  return {
    id,
    pancakeVariationId: `pancake-${id}`,
    color: null,
    size,
    sellableStock: 3,
    retailPrice: 429_000,
    retailPriceAfterDiscount: 429_000,
    ...overrides,
  } satisfies StorefrontVariantFacts;
}

function campaign(overrides: Partial<ApplicablePromotionCampaign> = {}): ApplicablePromotionCampaign {
  return {
    id: "flash-1",
    name: "Flash",
    kind: "FLASH_SALE",
    discountType: "FIXED_PRICE",
    percentageValue: null,
    fixedPriceVnd: BigInt(49_000),
    startsAt: new Date(now.getTime() - HOUR),
    endsAt: new Date(now.getTime() + 20 * HOUR + 38 * 60_000),
    ...overrides,
  };
}

test("a Flash-priced variant gives the product the Flash listing's presentation", () => {
  const flashSale = resolveStorefrontListingFlashSale({
    variants: [variant("v-s", "S"), variant("v-m", "M")],
    campaignsByVariantId: new Map([
      ["v-s", [campaign()]],
      ["v-m", [campaign()]],
    ]),
    now,
  });

  assert.deepEqual(flashSale, {
    representativeVariantId: "v-m",
    basePriceVnd: 429_000,
    effectivePriceVnd: 49_000,
    hasCheaperCurrentVariant: false,
    remainingMs: 20 * HOUR + 38 * 60_000,
  });
});

test("a product priced by another campaign kind, or not at all, carries no Flash presentation", () => {
  const variants = [variant("v-s", "S")];
  assert.equal(
    resolveStorefrontListingFlashSale({ variants, campaignsByVariantId: new Map(), now }),
    undefined,
  );
  assert.equal(
    resolveStorefrontListingFlashSale({
      variants,
      campaignsByVariantId: new Map([["v-s", [campaign({ kind: "PROMOTION" })]]]),
      now,
    }),
    undefined,
  );
});

test("a Flash campaign without a complete window, or one not yet started, is not a Flash card", () => {
  const variants = [variant("v-s", "S")];
  for (const flash of [
    campaign({ endsAt: null }),
    campaign({ startsAt: null }),
    campaign({ startsAt: new Date(now.getTime() + HOUR), endsAt: new Date(now.getTime() + 2 * HOUR) }),
  ]) {
    assert.equal(
      resolveStorefrontListingFlashSale({
        variants,
        campaignsByVariantId: new Map([["v-s", [flash]]]),
        now,
      }),
      undefined,
    );
  }
});

test("only ready-stock variants count, and a cheaper non-Flash variant reads as 'Sale từ'", () => {
  const soldOut = resolveStorefrontListingFlashSale({
    variants: [variant("v-s", "S", { sellableStock: 0 })],
    campaignsByVariantId: new Map([["v-s", [campaign()]]]),
    now,
  });
  assert.equal(soldOut, undefined);

  const mixed = resolveStorefrontListingFlashSale({
    variants: [variant("v-s", "S"), variant("v-m", "M", { retailPrice: 39_000 })],
    campaignsByVariantId: new Map([["v-s", [campaign()]]]),
    now,
  });
  assert.equal(mixed?.representativeVariantId, "v-s");
  assert.equal(mixed?.hasCheaperCurrentVariant, true);
});

test("a category card built from a Flash product shows the tag, the countdown and the Flash price", () => {
  const variants = [variant("v-s", "S")];
  const flashSale = resolveStorefrontListingFlashSale({
    variants,
    campaignsByVariantId: new Map([["v-s", [campaign()]]]),
    now,
  });
  const destination = Object.values(CATEGORY_DESTINATIONS)[0]!;
  const model = buildCategoryViewModel({
    destination,
    categoryKey: "set-do",
    breadcrumbs: [],
    subcategories: [],
    discovery: parseCategoryDiscoverySearchParams("set-do", {}),
    products: [{ id: "p-1", slug: "quan-sq5255", name: "QUẦN SQ5255", variants, flashSale }],
    facets: { colors: [], sizes: [] },
    totalCount: 1,
    totalPages: 1,
    page: 1,
    hasPrevious: false,
    hasNext: false,
    pageSize: 24,
    selectEventBySlug: new Map<string, TrackingEvent>(),
  });

  const card = model.cards[0]!;
  assert.equal(card.flashSale?.countdownText, "Còn 20 giờ 38 phút");
  assert.equal(card.marketingBadge?.label, "-89%");
  assert.match(card.price.compareAtText ?? "", /429\.000/);
  assert.match(card.price.displayText, /49\.000/);
});
