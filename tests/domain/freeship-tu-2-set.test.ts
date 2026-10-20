import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateGuestShippingFeeVnd,
  describeGuestShippingPromotion,
  describeGuestShippingPromotionHeadline,
  readGuestShippingPolicy,
} from "../../src/commerce/guest-shipping-policy.ts";
import {
  buildBenefitCheckoutQuoteFacts,
  buildRenderedCheckoutQuoteFacts,
} from "../../src/commerce/checkout-quote.ts";
import {
  isSetPromotionScope,
  SET_PROMOTION_CATEGORY_KEYS,
  DEFAULT_SET_PROMOTION_SCOPE,
} from "../../src/commerce/gift-quantity-scope.ts";
import type { StorefrontCartLine } from "../../src/commerce/storefront-cart.ts";

function createMockCartLine({
  variantId,
  variationId,
  price,
  quantity,
  available = true,
}: {
  variantId: string;
  variationId: string;
  price: number;
  quantity: number;
  available?: boolean;
}): StorefrontCartLine {
  return {
    variantId,
    pancakeVariationId: variationId,
    pancakeProductId: `prod-${variantId}`,
    productSlug: `slug-${variantId}`,
    productName: `Product ${variantId}`,
    color: "Red",
    size: "M",
    quantity,
    price,
    available,
    unavailableReason: null,
    isPreorderSale: false,
    media: { primary: null, gallery: [] },
  };
}

test("Scope: SET_PROMOTION_CATEGORY_KEYS includes canonical Set categories aoDai, setDo, vayDam", () => {
  assert.deepEqual(SET_PROMOTION_CATEGORY_KEYS, ["aoDai", "setDo", "vayDam"]);
  assert.equal(isSetPromotionScope(DEFAULT_SET_PROMOTION_SCOPE), true);
  assert.equal(
    isSetPromotionScope({
      mode: "DYNAMIC_CATEGORY",
      categoryKeys: ["aoDai"],
      includeProductIds: [],
      excludeProductIds: [],
    }),
    true,
  );
  assert.equal(
    isSetPromotionScope({
      mode: "DYNAMIC_CATEGORY",
      categoryKeys: ["phuKien"],
      includeProductIds: [],
      excludeProductIds: [],
    }),
    false,
  );
  assert.equal(
    isSetPromotionScope({
      mode: "GLOBAL_ALL_PAID_LINES",
    }),
    false,
  );
});

test("Policy: default guest shipping policy has freeship from 2 Sets and legacy rules disabled", () => {
  const policy = readGuestShippingPolicy({});
  assert.equal(policy.feeVnd, 30_000);
  assert.equal(policy.freeShippingMinSetQuantity, 2);
  assert.equal(policy.freeShippingMinQuantity, 0);
  assert.equal(policy.freeShippingSubtotalVnd, 0);

  assert.equal(describeGuestShippingPromotionHeadline(policy), "Free ship khi mua từ 2 Set");
  assert.deepEqual(describeGuestShippingPromotion(policy), {
    title: "Miễn phí vận chuyển",
    detail: "Miễn phí vận chuyển khi mua từ 2 Set.",
  });
});

test("Fee calculation: 1 Set charges 30,000 VND shipping fee", () => {
  const fee = calculateGuestShippingFeeVnd({
    subtotalVnd: 450_000,
    totalQuantity: 1,
    qualifyingSetQuantity: 1,
  });
  assert.equal(fee, 30_000);
});

test("Fee calculation: 2 Sets qualify for 0 VND freeship", () => {
  const fee = calculateGuestShippingFeeVnd({
    subtotalVnd: 900_000,
    totalQuantity: 2,
    qualifyingSetQuantity: 2,
  });
  assert.equal(fee, 0);
});

test("Fee calculation: 3 Sets qualify for 0 VND freeship (stacks with Mua 3)", () => {
  const fee = calculateGuestShippingFeeVnd({
    subtotalVnd: 1_350_000,
    totalQuantity: 3,
    qualifyingSetQuantity: 3,
  });
  assert.equal(fee, 0);
});

test("Fee calculation: 4 Sets qualify for 0 VND freeship (stacks with Mua 4)", () => {
  const fee = calculateGuestShippingFeeVnd({
    subtotalVnd: 1_800_000,
    totalQuantity: 4,
    qualifyingSetQuantity: 4,
  });
  assert.equal(fee, 0);
});

test("Fee calculation: 5 Sets qualify for 0 VND freeship (stacks with Mua 5 -10%)", () => {
  const fee = calculateGuestShippingFeeVnd({
    subtotalVnd: 2_025_000,
    totalQuantity: 5,
    qualifyingSetQuantity: 5,
  });
  assert.equal(fee, 0);
});

test("Legacy rules stopped: 3 non-set products or subtotal > 1,000,000 VND do NOT get freeship if < 2 Sets", () => {
  // 3 non-set products, total 600k, 0 Set -> charges 30,000 VND
  assert.equal(
    calculateGuestShippingFeeVnd({
      subtotalVnd: 600_000,
      totalQuantity: 3,
      qualifyingSetQuantity: 0,
    }),
    30_000,
  );

  // 1 non-set product, total 1,500,000 VND, 0 Set -> charges 30,000 VND
  assert.equal(
    calculateGuestShippingFeeVnd({
      subtotalVnd: 1_500_000,
      totalQuantity: 1,
      qualifyingSetQuantity: 0,
    }),
    30_000,
  );

  // 4 non-set products, total 2,000,000 VND, 1 Set + 3 non-sets -> charges 30,000 VND
  assert.equal(
    calculateGuestShippingFeeVnd({
      subtotalVnd: 2_000_000,
      totalQuantity: 4,
      qualifyingSetQuantity: 1,
    }),
    30_000,
  );

  // Mixed: 2 Sets + 1 accessory = 3 items -> qualifies because 2 Sets >= 2
  assert.equal(
    calculateGuestShippingFeeVnd({
      subtotalVnd: 1_100_000,
      totalQuantity: 3,
      qualifyingSetQuantity: 2,
    }),
    0,
  );
});

test("Rendered quote: calculates 0 VND shipping fee when qualifyingSetQuantity >= 2", () => {
  const lines = [
    createMockCartLine({ variantId: "var-1", variationId: "p-var-1", price: 450_000, quantity: 1 }),
    createMockCartLine({ variantId: "var-2", variationId: "p-var-2", price: 500_000, quantity: 1 }),
  ];

  // Without qualifying set quantity (or < 2)
  const quoteNormal = buildRenderedCheckoutQuoteFacts(lines, { qualifyingSetQuantity: 1 });
  assert.equal(quoteNormal?.shippingFeeVnd, 30_000);
  assert.equal(quoteNormal?.totalVnd, 950_000 + 30_000);

  // With 2 qualifying Sets
  const quoteFreeship = buildRenderedCheckoutQuoteFacts(lines, { qualifyingSetQuantity: 2 });
  assert.equal(quoteFreeship?.shippingFeeVnd, 0);
  assert.equal(quoteFreeship?.totalVnd, 950_000);
});

test("Benefit quote: calculates 0 VND shipping fee when qualifyingSetQuantity >= 2 and stacks with promotions", () => {
  const quote = buildBenefitCheckoutQuoteFacts({
    paid: [
      {
        groupKey: "group-1",
        pancakeVariationId: "pv-1",
        quantity: 3,
        unitPriceVnd: 400_000,
        steps: [],
        fulfillmentState: "READY",
      },
    ],
    gifts: [
      {
        campaignId: "campaign-mua-3-tang-1",
        campaignRevision: 1,
        pancakeVariationId: "pv-gift-1",
        quantity: 1,
      },
    ],
    entitlements: [
      {
        campaignId: "campaign-mua-3-tang-1",
        campaignRevision: 1,
        entitled: 1,
        selected: 1,
        skippedWhileAvailable: 0,
        contendedForSharedStock: 0,
        shortForStock: 0,
      },
    ],
    qualifyingSetQuantity: 3,
  });

  assert.ok(quote);
  assert.equal(quote.shippingFeeVnd, 0, "Shipping fee must be 0 for 3 Sets");
  assert.equal(quote.paidSubtotalVnd, 1_200_000);
  assert.equal(quote.totalVnd, 1_200_000);
  assert.equal(quote.lines.filter((l) => l.role === "GIFT").length, 1);
});
