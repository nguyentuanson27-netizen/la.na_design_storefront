import assert from "node:assert/strict";
import test from "node:test";
import type { CartGiftState } from "../../src/commerce/cart-gift-selection.ts";
import type { StorefrontCartLine } from "../../src/commerce/storefront-cart.ts";
import { buildCartViewModel, summarizeCartViewModel } from "../../src/routes/cart-model.ts";
import { buildCartGiftPickerModel } from "../../src/routes/cart-gift-model.ts";

const line = { variantId: "paid", pancakeVariationId: "paid-ext", pancakeProductId: "product", productSlug: "ao", productName: "Áo", color: "Trắng", size: "M", quantity: 3, price: 100_001, available: true, unavailableReason: null, isPreorderSale: false, media: { primary: null, gallery: [] } } as StorefrontCartLine;
// Projection fixture deliberately contains only the fields read by the cart presenters.
function state(): CartGiftState {
  return {
    quote: { lines: [line], benefits: { enabled: true, ok: true, subtotalVnd: 290_003, groups: [
      { lineKey: "paid", quantity: 1, unitPriceVnd: 90_001 }, { lineKey: "paid", quantity: 2, unitPriceVnd: 100_001 },
    ] } },
    labels: [{ variantId: "gift", productId: "gift-product", productName: "Khăn", optionLabel: "Trắng / M" }],
    campaigns: [{ id: "campaign", allowDuplicateGifts: false, options: [{ variantId: "gift", productId: "gift-product", composite: false, readyAvailable: 1 }] }],
    entitlements: [{ campaignId: "campaign", revision: 2, earned: 2, entitled: 2, unfulfillableForStock: 1, shortfallToNext: { quantity: 1, subtotalVnd: null } }],
    selections: [{ campaignId: "campaign", campaignRevision: 1, variantId: "gift", quantity: 1 }],
    validation: { ok: false, issues: [] },
  } as unknown as CartGiftState;
}
test("cart displays split paid prices and total while gifts never increase paid count", () => {
  const model = buildCartViewModel({ lines: [line], commerceTrackingEnabled: false, giftState: state() });
  assert.match(model.subtotalText, /290.003/);
  assert.deepEqual(model.lines[0].paidSegments, ["1 × 90.001\u00a0₫", "2 × 100.001\u00a0₫"]);
  assert.equal(model.lineCount, 1);
  assert.equal(summarizeCartViewModel(model).count, 3);
  assert.equal(model.canCheckout, false, "checkout cannot silently lose gifts or charge the legacy tier price");
});
test("stale gifts preserve chosen revision/quantity and show stock, shortfall and duplicate policy", () => {
  const model = buildCartGiftPickerModel(state());
  assert.equal(model.invalid, true);
  assert.equal(model.selections[0].campaignRevision, 1);
  assert.equal(model.selections[0].quantity, 1);
  assert.equal(model.campaigns[0].revision, 2);
  assert.equal(model.campaigns[0].shortForStock, 1);
  assert.match(model.campaigns[0].shortfallText!, /Mua thêm 1/);
  assert.equal(model.campaigns[0].allowDuplicateGifts, false);
});
test("missing gift label stays visible; lookup failure blocks checkout; OFF keeps the legacy model shape", () => {
  const s = state();
  const gifts = buildCartGiftPickerModel({ ...s, labels: [] });
  assert.equal(gifts.selections.length, 1);
  assert.match(gifts.selections[0].label, /không còn khả dụng/);
  const failed = buildCartViewModel({ lines: [line], commerceTrackingEnabled: false, benefitsUnavailable: true });
  assert.equal(failed.canCheckout, false);
  assert.equal(failed.subtotalText, "Chưa thể tính");
  const off = buildCartViewModel({ lines: [line], commerceTrackingEnabled: false });
  assert.equal(off.canCheckout, true);
  assert.equal(Object.hasOwn(off, "gifts"), false);
  assert.equal(Object.hasOwn(off.lines[0], "paidSegments"), false);
});
