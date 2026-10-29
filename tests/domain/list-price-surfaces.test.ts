import assert from "node:assert/strict";
import test from "node:test";
import { buildPromotionalStorefrontPricing } from "../../src/commerce/storefront-promotion-projection.ts";
import { buildStorefrontVariantOptions } from "../../src/commerce/storefront-product.ts";
import { buildProductCardModel } from "../../src/components/headless/build-product-card-model.ts";
import { resolveVariantSelectionView } from "../../src/components/headless/variant-selection-model.ts";
import { describeLineDiscount } from "../../src/routes/line-discount-model.ts";
import { buildCartViewModel } from "../../src/routes/cart-model.ts";
import type { StorefrontCartLine } from "../../src/commerce/storefront-cart.ts";
const variants = [429000, 590000].map((price, i) => ({
  id: "variant" + i,
  pancakeVariationId: "ext" + i,
  color: null,
  size: i ? "M" : "S",
  sellableStock: 5,
  retailPrice: price,
  retailPriceAfterDiscount: price,
}));
const vnd = (value: string) => `${value}\u00a0₫`;
const rule = () =>
  buildPromotionalStorefrontPricing({
    campaignsByVariantId: new Map(),
    now: new Date(0),
  });
test.after(() => {
  delete process.env.LIST_PRICE_DISPLAY;
  delete process.env.LIST_PRICE_CAMPAIGN_BASIS;
});
test("display toggle leaves payable facts alone; representative and selected triples never cross variants", () => {
  const before = buildStorefrontVariantOptions(variants, rule());
  process.env.LIST_PRICE_DISPLAY = "true";
  const after = buildStorefrontVariantOptions(variants, rule());
  assert.deepEqual(
    after.map((o) => [o.price, o.basePriceVnd, o.isDiscounted]),
    before.map((o) => [o.price, o.basePriceVnd, o.isDiscounted]),
  );
  const card = buildProductCardModel({
    slug: "set",
    name: "Set",
    variants,
    pricingRule: rule(),
  });
  assert.equal(card.price.displayText, vnd("429.000"));
  assert.equal(card.price.compareAtText, vnd("549.000"));
  assert.equal(card.price.discountPercent, 22);
  const options = after.map((option) => ({
    ...option,
    kindKey: null,
    kindLabel: null,
  }));
  const a = resolveVariantSelectionView({
    options,
    productLevelOptions: options,
    selection: { kindKey: null, color: null, size: null },
  });
  assert.equal(a.priceDisplay.compareAtText, vnd("549.000"));
  assert.equal(a.priceDisplay.discountPercent, 22);
  assert.equal(a.showsDiscount, false);
  const b = resolveVariantSelectionView({
    options,
    productLevelOptions: options,
    selection: { kindKey: null, color: null, size: "M" },
  });
  assert.equal(b.priceDisplay.displayText, vnd("590.000"));
  assert.equal(b.priceDisplay.compareAtText, vnd("749.000"));
  assert.equal(b.priceDisplay.discountPercent, 21);
  assert.deepEqual(describeLineDiscount(590000, 590000), {
    isListReference: true,
    originalPriceText: vnd("749.000"),
    percent: 21,
  });
  const availableB = buildProductCardModel({
    slug: "set",
    name: "Set",
    variants: [{ ...variants[0]!, sellableStock: 0 }, variants[1]!],
    pricingRule: rule(),
  });
  assert.equal(availableB.price.displayText, vnd("590.000"));
  assert.equal(availableB.price.compareAtText, vnd("749.000"));
  assert.equal(availableB.price.discountPercent, 21);
});

test("cart savings labels name the list reference only with display ON, without changing payable money", () => {
  const line = {
    variantId: "variant1", pancakeVariationId: "ext1", pancakeProductId: "product",
    productName: "Set", productSlug: "set", color: null, size: "M",
    quantity: 1, basePrice: 590000, price: 531000, available: true,
    unavailableReason: null, isPreorderSale: false, media: { primary: null, gallery: [] },
  } as StorefrontCartLine;
  for (const display of [false, true]) {
    process.env.LIST_PRICE_DISPLAY = String(display);
    const cart = buildCartViewModel({ lines: [line], commerceTrackingEnabled: false });
    assert.deepEqual(cart.savings, {
      originalTotalLabel: display ? "Tổng theo giá niêm yết" : "Tổng",
      savingLabel: display ? "Tiết kiệm so với giá niêm yết" : "Tiết kiệm",
      originalTotalText: vnd(display ? "749.000" : "590.000"),
      savingText: vnd(display ? "218.000" : "59.000"),
    });
    assert.equal(cart.subtotalText, vnd("531.000"));
    assert.equal(cart.lines[0]!.priceText, vnd("531.000"));
    assert.equal(cart.canCheckout, true);
  }
});
