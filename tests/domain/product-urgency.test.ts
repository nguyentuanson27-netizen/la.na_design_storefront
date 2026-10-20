import assert from "node:assert/strict";
import test from "node:test";

import type { ApplicablePromotionCampaign } from "../../src/commerce/promotion-pricing.ts";
import {
  STANDARD_STANDALONE_CAPACITY,
  type StorefrontVariantFacts,
} from "../../src/commerce/storefront-product.ts";
import {
  describeLowStock,
  formatFlashClock,
  NO_PRODUCT_URGENCY,
  resolveFlashRemainingMs,
  type ProductUrgency,
} from "../../src/components/headless/product-urgency.ts";
import { buildProductUrgency } from "../../src/routes/product-model.ts";

/** The product page's Flash Sale countdown and "Còn x", decided from the card's own rules. */

const now = new Date("2026-10-20T03:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function variant(id: string, size: string, sellableStock: number): StorefrontVariantFacts {
  return {
    id,
    pancakeVariationId: `pancake-${id}`,
    color: null,
    size,
    sellableStock,
    retailPrice: 429_000,
    retailPriceAfterDiscount: 429_000,
  };
}

function flash(endsInMs: number, id = "flash-1"): ApplicablePromotionCampaign {
  return {
    id,
    name: "Flash",
    kind: "FLASH_SALE",
    discountType: "FIXED_PRICE",
    percentageValue: null,
    fixedPriceVnd: BigInt(49_000),
    startsAt: new Date(now.getTime() - HOUR),
    endsAt: new Date(now.getTime() + endsInMs),
  };
}

test("the page counts down the representative, then the chosen variant's own campaign", () => {
  const urgency = buildProductUrgency({
    variants: [variant("v-s", "S", 3), variant("v-m", "M", 2), variant("v-l", "L", 6)],
    productCapacity: STANDARD_STANDALONE_CAPACITY,
    campaignsByVariantId: new Map([
      ["v-s", [flash(20 * HOUR + 38 * MINUTE)]],
      ["v-m", [flash(2 * HOUR, "flash-2")]],
    ]),
    now,
  });

  assert.equal(resolveFlashRemainingMs(urgency, null), 2 * HOUR);
  assert.equal(resolveFlashRemainingMs(urgency, "v-s"), 20 * HOUR + 38 * MINUTE);
  // L is not on Flash Sale: choosing it hides the countdown rather than showing someone else's.
  assert.equal(resolveFlashRemainingMs(urgency, "v-l"), null);
});

test("no Flash Sale means no countdown and no photograph tag", () => {
  const urgency = buildProductUrgency({
    variants: [variant("v-s", "S", 3)],
    productCapacity: STANDARD_STANDALONE_CAPACITY,
    campaignsByVariantId: new Map(),
    now,
  });
  assert.equal(urgency.flash, null);
  assert.equal(resolveFlashRemainingMs(urgency, null), null);
});

test('"Còn x" gives the total before a choice, then the chosen size\'s own count', () => {
  const urgency = buildProductUrgency({
    variants: [variant("v-s", "S", 0), variant("v-m", "M", 2), variant("v-l", "L", 1)],
    productCapacity: STANDARD_STANDALONE_CAPACITY,
    campaignsByVariantId: new Map(),
    now,
  });

  assert.equal(describeLowStock(urgency, { variantId: null, size: null }), "Chỉ còn 3 sản phẩm");
  assert.equal(describeLowStock(urgency, { variantId: "v-m", size: "M" }), "Size M chỉ còn 2 sản phẩm");
  assert.equal(describeLowStock(urgency, { variantId: "v-m", size: null }), "Chỉ còn 2 sản phẩm");
});

test('a chosen size with enough stock says nothing, even when the total is low elsewhere', () => {
  const urgency: ProductUrgency = {
    flash: null,
    lowStock: { total: null, byVariantId: { "v-m": 2 } },
  };
  assert.equal(describeLowStock(urgency, { variantId: "v-l", size: "L" }), null);
  assert.equal(describeLowStock(urgency, { variantId: null, size: null }), null);
});

test('"Còn x" follows the card\'s policy rules on the page too', () => {
  const variants = [variant("v-s", "S", 2)];
  for (const sellingMode of ["PREORDER", "OVERSELL"] as const) {
    const urgency = buildProductUrgency({
      variants,
      productCapacity: { ...STANDARD_STANDALONE_CAPACITY, sellingMode },
      campaignsByVariantId: new Map(),
      now,
    });
    assert.deepEqual(urgency.lowStock, { total: null, byVariantId: {} });
  }

  // A FULL SET whose sizes share a component: each size's own count is exact, the sum is not.
  const shared = buildProductUrgency({
    variants: [variant("v-s", "S", 2), variant("v-m", "M", 2)],
    productCapacity: { ...STANDARD_STANDALONE_CAPACITY, isComposite: true, sharesComponents: true },
    campaignsByVariantId: new Map(),
    now,
  });
  assert.equal(shared.lowStock.total, null);
  assert.deepEqual(shared.lowStock.byVariantId, { "v-s": 2, "v-m": 2 });
});

test("the clock reads hours, minutes and seconds, and days once there are any", () => {
  const clock = formatFlashClock(20 * HOUR + 38 * MINUTE + 12_000);
  assert.equal(clock?.text, "20:38:12");
  assert.equal(clock?.spoken, "Flash Sale kết thúc sau 20 giờ 38 phút");

  assert.equal(formatFlashClock(2 * 24 * HOUR + 4 * HOUR + 1_000)?.text, "2 ngày 04:00:01");
  assert.equal(formatFlashClock(45_000)?.text, "00:00:45");
  assert.equal(formatFlashClock(0), null);
  assert.equal(formatFlashClock(-5), null);
});

test("an empty urgency says nothing", () => {
  assert.equal(resolveFlashRemainingMs(NO_PRODUCT_URGENCY, null), null);
  assert.equal(describeLowStock(NO_PRODUCT_URGENCY, { variantId: null, size: null }), null);
});
