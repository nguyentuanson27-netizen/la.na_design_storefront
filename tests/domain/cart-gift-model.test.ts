import assert from "node:assert/strict";
import test from "node:test";
import type { CartGiftState } from "../../src/commerce/cart-gift-selection.ts";
import type { StorefrontCartLine } from "../../src/commerce/storefront-cart.ts";
import { buildCartViewModel, canTrackLegacyCartPrices, summarizeCartViewModel } from "../../src/routes/cart-model.ts";
import { buildCartGiftPickerModel } from "../../src/routes/cart-gift-model.ts";
import { evaluateGiftEntitlements, validateGiftSelections, type GiftCampaignFacts } from "../../src/commerce/gift-quantity-entitlement.ts";

const line = { variantId: "paid", pancakeVariationId: "paid-ext", pancakeProductId: "product", productSlug: "ao", productName: "Áo", color: "Trắng", size: "M", quantity: 3, price: 100_001, available: true, unavailableReason: null, isPreorderSale: false, media: { primary: null, gallery: [] } } as StorefrontCartLine;
// Projection fixture deliberately contains only the fields read by the cart presenters.
function state(): CartGiftState {
  return {
    quote: { lines: [line], benefits: { enabled: true, ok: true, subtotalVnd: 290_003, groups: [
      { lineKey: "paid", quantity: 1, unitPriceVnd: 90_001, steps: [] }, { lineKey: "paid", quantity: 2, unitPriceVnd: 100_001, steps: [] },
    ], dropped: [] } },
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
test("GQ14-F3: EX-21 blocks checkout and explains a dropped tier even when repriced total matches legacy", () => {
  const paid = { ...line, quantity: 1, price: 40_000 };
  const s = { ...state(), quote: { lines: [paid], benefits: { enabled: true, ok: true, subtotalVnd: 40_000,
    groups: [{ lineKey: "paid", quantity: 1, unitPriceVnd: 40_000, steps: [] }],
    dropped: [{ campaignId: "tier", reason: "TIER_PRICE_INVALID", otherCampaignId: null }],
  } }, campaigns: [], entitlements: [], selections: [], validation: { ok: true, issues: [], summaries: [] } } as unknown as CartGiftState;
  const model = buildCartViewModel({ lines: [paid], commerceTrackingEnabled: false, giftState: s });
  assert.match(model.subtotalText, /40.000/);
  assert.equal(model.canCheckout, false);
  assert.match(model.benefitsNotice!, /giảm giá theo số lượng không còn áp dụng.*giá.*không hợp lệ/i);
  assert.match(model.benefitsNotice!, /chưa thể đặt trực tuyến/i, "GQ19: held back only where the POS shop is not verified; see checkout-benefit-ui.test.ts for the open case");
  const unchanged = { ...s, quote: { ...s.quote, benefits: { ...s.quote.benefits, dropped: [] } } } as CartGiftState;
  const noDrop = buildCartViewModel({ lines: [paid], commerceTrackingEnabled: false, giftState: unchanged });
  assert.equal(noDrop.canCheckout, true, "ON without dropped tiers retains checkout");
  assert.equal(noDrop.benefitsNotice, undefined);
  assert.equal(buildCartViewModel({ lines: [paid], commerceTrackingEnabled: false }).canCheckout, true, "OFF parity");
  const differentTotal = { ...unchanged, quote: { ...unchanged.quote, benefits: { ...unchanged.quote.benefits, subtotalVnd: 30_000 } } } as CartGiftState;
  assert.equal(buildCartViewModel({ lines: [paid], commerceTrackingEnabled: false, giftState: differentTotal }).canCheckout, false, "different tier total remains blocked");
});
test("stale gifts preserve chosen revision/quantity and show stock, shortfall and duplicate policy", () => {
  const model = buildCartGiftPickerModel(state());
  assert.equal(model.invalid, true);
  assert.equal(model.selections[0].campaignRevision, 1);
  assert.equal(model.selections[0].quantity, 1);
  assert.equal(model.campaigns[0].revision, 2);
  assert.equal(model.campaigns[0].unavailableSlots, 1);
  assert.match(model.campaigns[0].shortfallText!, /Mua thêm 1/);
  assert.equal(model.campaigns[0].allowDuplicateGifts, false);
});

test("GQ14-F1: tier split and failed benefits suppress legacy tracking; OFF and unchanged paid prices retain it", () => {
  assert.equal(canTrackLegacyCartPrices({ lines: [line], giftState: state() }), false, "EX-17 must never emit the legacy 300.003đ");
  assert.equal(canTrackLegacyCartPrices({ lines: [line], benefitsUnavailable: true }), false, "LOOKUP_FAILED");
  assert.equal(canTrackLegacyCartPrices({ lines: [line] }), true, "OFF parity");
  const s = state();
  const noTier = { ...s, quote: { lines: [line], benefits: { enabled: true, ok: true, subtotalVnd: 300_003,
    groups: [{ lineKey: "paid", quantity: 3, unitPriceVnd: 100_001, steps: [] }] } } } as unknown as CartGiftState;
  assert.equal(canTrackLegacyCartPrices({ lines: [line], giftState: noTier }), true, "gift selections never enter paid analytics");
  const changedSegments = { ...noTier, quote: { ...noTier.quote, benefits: { enabled: true, ok: true, subtotalVnd: 300_003,
    groups: [{ lineKey: "paid", quantity: 1, unitPriceVnd: 90_001, steps: [] }, { lineKey: "paid", quantity: 2, unitPriceVnd: 105_001, steps: [] }] } } } as unknown as CartGiftState;
  assert.equal(canTrackLegacyCartPrices({ lines: [line], giftState: changedSegments }), false, "matching subtotal cannot hide changed item prices");
  const failed = { ...s, quote: { lines: [line], benefits: { enabled: true, ok: false, error: "LOOKUP_FAILED" } } } as unknown as CartGiftState;
  assert.equal(canTrackLegacyCartPrices({ lines: [line], giftState: failed }), false);
});

test("GQ14-F2: distinct-product capacity is not physical stock shortage; real empty stock stays explicit", () => {
  for (const [stock, duplicate, products, expected] of [
    [10, false, 1, "Không đủ lựa chọn quà hợp lệ cho 1 suất."],
    [0, false, 1, "Thiếu tồn kho cho 2 suất quà."],
    [10, false, 2, null], [10, true, 1, null],
  ] as const) {
    const campaigns: GiftCampaignFacts[] = [{ id: "campaign", revision: 2, trigger: "ORDER_SUBTOTAL", minimumQuantity: null,
      minimumSubtotalVnd: 100_000, subtotalScope: "ALL_PAID_LINES", awardMode: "REPEAT_PER_THRESHOLD", maxGiftsPerOrder: null,
      allowDuplicateGifts: duplicate, scope: { mode: "GLOBAL_ALL_PAID_LINES" }, frozen: null,
      options: Array.from({ length: products }, (_, i) => ({ variantId: `gift-${i}`, productId: `product-${i}`, composite: false, readyAvailable: stock })) }];
    const evaluation = evaluateGiftEntitlements({ campaigns, paidGroups: [{ groupKey: "paid", product: { productId: "paid", categoryKeys: [] }, quantity: 2, unitPriceVnd: 100_000 }] });
    assert.equal(evaluation.ok, true);
    if (!evaluation.ok) throw new Error("fixture invalid");
    const validation = validateGiftSelections({ campaigns, entitlements: evaluation.entitlements, selection: [] });
    const s = { ...state(), campaigns, entitlements: [...evaluation.entitlements], selections: [], validation };
    assert.equal(buildCartGiftPickerModel(s).campaigns[0].shortageText, expected);
    const chosen = [{ campaignId: "campaign", campaignRevision: 2, variantId: "gift-0", quantity: 2 }];
    assert.equal(validateGiftSelections({ campaigns, entitlements: evaluation.entitlements, selection: chosen }).ok, duplicate);
  }
  const stale = state();
  const model = buildCartGiftPickerModel(stale);
  assert.deepEqual(model.selections.map(({ campaignId, variantId, campaignRevision, quantity }) => ({ campaignId, variantId, campaignRevision, quantity })), stale.selections);
  assert.doesNotMatch(model.campaigns[0].shortageText!, /Thiếu tồn kho/);
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


test("gift images share the trusted media boundary; missing or foreign URLs fall back", () => {
  const fixture = state();
  for (const [raw, expected] of [["https://content.pancake.vn/images/1/2/3/gift.jpg", "https://content.pancake.vn/images/1/2/3/gift.jpg"], ["https://evil.example/gift.jpg",null],[null,null]] as const) {
    const model = buildCartGiftPickerModel({...fixture, labels:fixture.labels.map(l=>({...l,imageUrl:raw}))});
    assert.equal(model.campaigns[0]!.products[0]!.imageUrl,expected);
    assert.equal(model.selections[0]!.imageUrl,expected);
  }
});
