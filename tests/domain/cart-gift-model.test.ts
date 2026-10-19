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

test("product receives image from subsequent option if first option has null image", () => {
  const fixture = state();
  const stateWithMultipleOptions = {
    ...fixture,
    labels: [
      { variantId: "gift-1", productId: "gift-product", productName: "Khăn", optionLabel: "Đỏ / S", imageUrl: null },
      { variantId: "gift-2", productId: "gift-product", productName: "Khăn", optionLabel: "Đỏ / M", imageUrl: "https://content.pancake.vn/images/1/2/3/khan.jpg" },
    ],
    campaigns: [{
      id: "campaign",
      allowDuplicateGifts: false,
      options: [
        { variantId: "gift-1", productId: "gift-product", composite: false, readyAvailable: 1 },
        { variantId: "gift-2", productId: "gift-product", composite: false, readyAvailable: 1 },
      ],
    }],
  } as unknown as CartGiftState;
  const model = buildCartGiftPickerModel(stateWithMultipleOptions);
  assert.equal(model.campaigns[0]!.products[0]!.imageUrl, "https://content.pancake.vn/images/1/2/3/khan.jpg");
});

function repairState(): CartGiftState {
  const campaigns: GiftCampaignFacts[] = [{ id: "campaign", revision: 2, trigger: "ORDER_SUBTOTAL", minimumQuantity: null,
    minimumSubtotalVnd: 100_000, subtotalScope: "ALL_PAID_LINES", awardMode: "REPEAT_PER_THRESHOLD", maxGiftsPerOrder: null,
    allowDuplicateGifts: true, scope: { mode: "GLOBAL_ALL_PAID_LINES" }, frozen: null,
    options: [
      { variantId: "good", productId: "good-product", composite: false, readyAvailable: 10 },
      { variantId: "bad", productId: "bad-product", composite: false, readyAvailable: 0 },
    ] }];
  const evaluation = evaluateGiftEntitlements({ campaigns, paidGroups: [{ groupKey: "paid", product: { productId: "paid", categoryKeys: [] }, quantity: 2, unitPriceVnd: 100_000 }] });
  if (!evaluation.ok) throw new Error("invalid repair fixture");
  const selections: CartGiftState["selections"] = ["good", "bad"].map(variantId => ({ campaignId: "campaign", variantId, campaignRevision: 2, quantity: 1,
    currentCampaignRevision: 2, freshness: "CURRENT", campaignEnabled: true, variantActive: true, mirroredStock: variantId === "good" ? 10 : 0, issues: [] }));
  return { ...state(), campaigns, entitlements: [...evaluation.entitlements], selections,
    validation: validateGiftSelections({ campaigns, entitlements: evaluation.entitlements, selection: selections }) };
}

test("F2: repair projects OUT_OF_STOCK onto the validated line while keeping the valid choice", () => {
  const s = repairState();
  const model = buildCartGiftPickerModel(s);
  assert.equal(model.invalid, true);
  assert.deepEqual(model.selections[0].problems, []);
  assert.match(model.selections[1].problems!.join(" "), /không còn số lượng.*bỏ.*chọn lại/i);
  assert.deepEqual(model.selections.map(({ campaignId, variantId, quantity }) => ({ campaignId, variantId, quantity })), s.selections.map(({ campaignId, variantId, quantity }) => ({ campaignId, variantId, quantity })));
});

test("F2: lineIndex maps the original validated order, including null issue identities and missing labels", () => {
  const s = repairState();
  for (const error of ["CAMPAIGN_NOT_ENTITLED", "STALE_CAMPAIGN_REVISION", "SELECTION_REVISION_INVALID"] as const) {
    const model = buildCartGiftPickerModel({ ...s, labels: [], validation: { ok: false, issues: [{ error, lineIndex: 1, campaignId: null, variantId: null }] } });
    assert.deepEqual(model.selections[0].problems, []);
    assert.equal(model.selections[1].problems!.length, 1);
    assert.equal(model.selections[1].variantId, "bad");
    assert.equal(model.selections[1].campaignRevision, 2);
    assert.match(model.selections[1].label, /không còn khả dụng/);
  }
});

test("F2: aggregate entitlement, duplicate and shared-stock issues identify a group, not a singled-out row", () => {
  const s = repairState();
  for (const issue of [
    { error: "OVER_ENTITLEMENT", campaignId: "campaign", variantId: null },
    { error: "DUPLICATE_PRODUCT_NOT_ALLOWED", campaignId: "campaign", variantId: null },
    { error: "OUT_OF_STOCK", campaignId: null, variantId: "good" },
    { error: "STALE_CAMPAIGN_REVISION", campaignId: "campaign", variantId: null },
    { error: "SELECTION_INVALID", campaignId: null, variantId: null },
  ] as const) {
    const model = buildCartGiftPickerModel({ ...s, validation: { ok: false, issues: [{ ...issue, lineIndex: null }] } });
    assert.ok(model.selections.every(row => row.problems?.length === 0));
    assert.equal(model.repairGroups!.length, 1);
    assert.deepEqual(model.repairGroups![0].selectionKeys, issue.variantId ? ["campaign/good"] : ["campaign/good", "campaign/bad"]);
    assert.match(model.repairGroups![0].message, /giảm|bỏ/i);
  }
});

test("F2: real validator aggregate failures preserve every member of the repair group", () => {
  const s = repairState();
  for (const kind of ["OVER_ENTITLEMENT", "DUPLICATE_PRODUCT_NOT_ALLOWED", "OUT_OF_STOCK"] as const) {
    const base = s.campaigns[0];
    const campaigns = kind === "OUT_OF_STOCK"
      ? ["campaign", "other-campaign"].map(id => ({ ...base, id, options: [{ ...base.options[0], readyAvailable: 1 }] }))
      : [{ ...base, allowDuplicateGifts: kind !== "DUPLICATE_PRODUCT_NOT_ALLOWED", options: base.options.map(option => ({ ...option, productId: "one-product", readyAvailable: 10 })) }];
    const evaluation = evaluateGiftEntitlements({ campaigns, paidGroups: [{ groupKey: "paid", product: { productId: "paid", categoryKeys: [] }, quantity: 2, unitPriceVnd: 100_000 }] });
    if (!evaluation.ok) throw new Error("invalid aggregate fixture");
    const selections = kind === "OUT_OF_STOCK"
      ? campaigns.map(c => ({ ...s.selections[0], campaignId: c.id, mirroredStock: 1 }))
      : kind === "OVER_ENTITLEMENT" ? [{ ...s.selections[0], quantity: 3 }] : s.selections;
    const validation = validateGiftSelections({ campaigns, entitlements: evaluation.entitlements, selection: selections });
    assert.equal(validation.ok, false);
    if (validation.ok) throw new Error("expected aggregate refusal");
    assert.equal(validation.issues[0].error, kind);
    const model = buildCartGiftPickerModel({ ...s, campaigns, entitlements: [...evaluation.entitlements], selections, validation });
    assert.ok(model.selections.every(row => row.problems?.length === 0));
    assert.deepEqual(model.repairGroups![0].selectionKeys, selections.map(row => `${row.campaignId}/${row.variantId}`));
  }
});

test("gift options read S → M → L → XL within a colour, whatever order the campaign stores them in", () => {
  // The storage order the picker used to show verbatim: L, M, S, XL, with a second colour mixed in.
  const stored = [
    ["v-l", "Trắng", "L"], ["v-m", "Trắng", "M"], ["v-s", "Trắng", "S"], ["v-xl", "Trắng", "XL"],
    ["v-black-xl", "Đen", "XL"], ["v-black-s", "Đen", "S"],
  ] as const;
  const s = {
    ...state(),
    labels: stored.map(([variantId, color, size]) => ({
      variantId, productId: "sv124", productName: "Áo SV124", optionLabel: `${color} / ${size}`, color, size,
    })),
    campaigns: [{ id: "campaign", allowDuplicateGifts: false, options: stored.map(([variantId]) => ({
      variantId, productId: "sv124", composite: false, readyAvailable: 3,
    })) }],
    selections: [],
    validation: { ok: true, issues: [], summaries: [] },
  } as unknown as CartGiftState;

  const [product] = buildCartGiftPickerModel(s).campaigns[0]!.products;
  // Colours by name (Vietnamese collation: Đ after D, before T), sizes in shopping order within each.
  assert.deepEqual(
    product!.options.map((option) => option.label),
    ["Đen / S", "Đen / XL", "Trắng / S", "Trắng / M", "Trắng / L", "Trắng / XL"],
  );
});

test("gift option order depends only on the options, not on the order the campaign returns them", () => {
  // Gift options are read without an ORDER BY, so the same campaign can arrive in any order.
  const variants = [
    ["v1", "Trắng", "L"], ["v2", "Be", "M"], ["v3", "Trắng", "S"], ["v4", "Đen", "XL"],
    ["v5", "Be", "S"], ["v6", "Đen", "M"], ["v7", "Trắng", "M"],
  ] as const;
  const modelFor = (order: readonly (typeof variants)[number][]) =>
    buildCartGiftPickerModel({
      ...state(),
      labels: order.map(([variantId, color, size]) => ({
        variantId, productId: "p", productName: "Áo", optionLabel: `${color} / ${size}`, color, size,
      })),
      campaigns: [{ id: "campaign", allowDuplicateGifts: false, options: order.map(([variantId]) => ({
        variantId, productId: "p", composite: false, readyAvailable: 1,
      })) }],
      selections: [],
      validation: { ok: true, issues: [], summaries: [] },
    } as unknown as CartGiftState).campaigns[0]!.products[0]!.options.map((option) => option.label);

  const expected = ["Be / S", "Be / M", "Đen / M", "Đen / XL", "Trắng / S", "Trắng / M", "Trắng / L"];
  assert.deepEqual(modelFor(variants), expected);
  assert.deepEqual(modelFor([...variants].reverse()), expected);
  assert.deepEqual(modelFor([variants[3], variants[6], variants[1], variants[0], variants[5], variants[2], variants[4]]), expected);
});
