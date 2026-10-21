import assert from "node:assert/strict";
import test from "node:test";

import type { BenefitCheckoutRender } from "../../src/commerce/benefit-checkout-render.ts";
import type { CartGiftState } from "../../src/commerce/cart-gift-selection.ts";
import { buildBenefitCheckoutQuoteFacts } from "../../src/commerce/checkout-quote.ts";
import type { StorefrontCartLine } from "../../src/commerce/storefront-cart.ts";
import { buildCartViewModel } from "../../src/routes/cart-model.ts";
import { buildCartPromotionView, buildCheckoutPromotionView, tierSavingRows, tierSavingsVnd } from "../../src/routes/cart-promotion-model.ts";
import { describeLineDiscount } from "../../src/routes/line-discount-model.ts";
import { buildBenefitCheckoutViewModel, buildCheckoutViewModel } from "../../src/routes/checkout-model.ts";
import { DEFAULT_GUEST_SHIPPING_POLICY } from "../../src/commerce/guest-shipping-policy.ts";
import { readFileSync } from "node:fs";

/** The promotion banner's words and numbers: reached conditions first, then the bar to the next slot. */

const vnd = (amount: string): string => `${amount} ₫`;

const cartLine = {
  variantId: "paid", pancakeVariationId: "var-1", pancakeProductId: "product", productSlug: "ao",
  productName: "Set quần", color: "Xanh", size: "M", quantity: 5, price: 689_000, available: true,
  unavailableReason: null, isPreorderSale: false, media: { primary: null, gallery: [] },
} as StorefrontCartLine;

const tierStep = { campaignId: "tier", source: "QUANTITY_TIER" as const, kind: "QUANTITY_TIER", priority: 1, inputPriceVnd: 689_000, outputPriceVnd: 600_000, appliedQuantity: 3 };
const legacyStep = { campaignId: "flash", source: "LEGACY" as const, kind: "LEGACY", priority: null, inputPriceVnd: 800_000, outputPriceVnd: 689_000, appliedQuantity: 5 };

type Overrides = Readonly<{
  steps?: readonly unknown[];
  entitlements?: readonly unknown[];
  campaigns?: readonly unknown[];
  selections?: readonly unknown[];
  validationOk?: boolean;
  benefits?: unknown;
  names?: ReadonlyMap<string, string>;
}>;

function state(o: Overrides = {}): CartGiftState {
  return {
    quote: {
      lines: [cartLine],
      benefits: o.benefits ?? { enabled: true, ok: true, subtotalVnd: 3_445_000, dropped: [], campaignNames: o.names ?? new Map([["tier", "Mua 3 giảm 13%"]]), groups: [
        { groupKey: "paid|disc", lineKey: "paid", quantity: 3, unitPriceVnd: 600_000, steps: o.steps ?? [] },
        { groupKey: "paid|full", lineKey: "paid", quantity: 2, unitPriceVnd: 689_000, steps: [] },
      ] },
    },
    labels: [],
    campaigns: o.campaigns ?? [],
    entitlements: o.entitlements ?? [],
    selections: o.selections ?? [],
    validation: { ok: o.validationOk ?? true, issues: [], summaries: [] },
  } as unknown as CartGiftState;
}

const quantityCampaign = { id: "gift-a", trigger: "QUANTITY", minimumQuantity: 4, minimumSubtotalVnd: null, awardMode: "EVERY_MULTIPLE", options: [] };
const subtotalCampaign = { id: "gift-b", trigger: "ORDER_SUBTOTAL", minimumQuantity: null, minimumSubtotalVnd: 4_000_000, awardMode: "ONCE", options: [] };

test("an earned gift and the next quantity discount remain visible together", () => {
  const view = buildCartPromotionView(state({
    campaigns: [{ ...quantityCampaign, minimumQuantity: 3 }],
    entitlements: [{ campaignId: "gift-a", entitled: 1, shortfallToNext: { quantity: 2, subtotalVnd: null } }],
    benefits: { enabled: true, ok: true, groups: [], quantityProgress: [{
      campaignId: "five", currentQuantity: 4, reachedThresholdQuantity: null, discountedUnits: "ALL_ELIGIBLE_UNITS",
      next: { thresholdQuantity: 5, unit: "PERCENTAGE", value: 10, shortfallQuantity: 1 },
    }] },
  }))!;
  assert.deepEqual(view.items.map((item) => [item.state, item.kind]), [["achieved", "GIFT"], ["progress", "TIER"]]);
  assert.equal(view.items[1]!.title, "Mua thêm 1 sản phẩm áp dụng để được giảm 10%");
  assert.deepEqual(view.items[1]!.progress, { percent: 80, label: "Còn thiếu 1 sản phẩm áp dụng" });
  assert.equal(view.savingsVnd, 0, "a future benefit is never counted as a discount");
});

test("quantity progress uses backend thresholds, fixed per-unit values and the reached rung", () => {
  const view = buildCartPromotionView(state({ benefits: {
    enabled: true, ok: true, groups: [{ quantity: 3, steps: [tierStep] }],
    quantityProgress: [{ campaignId: "fixed", currentQuantity: 6, reachedThresholdQuantity: 3, discountedUnits: "FROM_REACHED_THRESHOLD",
      next: { thresholdQuantity: 8, unit: "FIXED_AMOUNT_PER_UNIT_VND", value: 20_000, shortfallQuantity: 2 } }],
  } }))!;
  assert.deepEqual(view.items.map((item) => item.state), ["achieved", "progress"]);
  assert.equal(view.items[1]!.title, `Mua thêm 2 sản phẩm áp dụng để được giảm ${vnd("20.000")}/sản phẩm được ưu đãi`);
  assert.equal(view.items[1]!.progress!.percent, 60);
});

test("only quantity-tier steps count as savings; the flash-sale price is already on the line", () => {
  assert.equal(tierSavingsVnd([{ quantity: 3, steps: [tierStep] }]), (689_000 - 600_000) * 3);
  assert.equal(tierSavingsVnd([{ quantity: 5, steps: [legacyStep] }]), 0, "a legacy step is not a tier saving");
  assert.equal(tierSavingsVnd([{ quantity: 3, steps: [{ ...tierStep, outputPriceVnd: 700_000 }] }]), 0, "a step that raises the price saves nothing");
  assert.equal(tierSavingsVnd([{ quantity: 3, discountSteps: [tierStep] }, { quantity: 3, steps: [tierStep] }]), 2 * (689_000 - 600_000) * 3, "checkout facts and cart groups read the same");
  assert.equal(tierSavingsVnd([]), 0);
});

test("a reached tier is announced, and its saving line is named by the campaign", () => {
  const view = buildCartPromotionView(state({ steps: [tierStep] }))!;
  assert.equal(view.savingsVnd, 267_000);
  assert.deepEqual(view.savings.map((row) => [row.id, row.label, row.amountText]), [["tier", "Mua 3 giảm 13%", vnd("267.000")]]);
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0]!.state, "achieved");
  assert.equal(view.items[0]!.kind, "TIER");
  assert.equal(view.items[0]!.title, "Đã áp dụng ưu đãi");
});

test("nothing reached and nothing near gives no banner at all", () => {
  assert.equal(buildCartPromotionView(state()), null);
  assert.equal(buildCartPromotionView(undefined), null);
  assert.equal(buildCartPromotionView(state({ benefits: { enabled: false } })), null);
  assert.equal(buildCartPromotionView(state({ benefits: { enabled: true, ok: false, reason: "LOOKUP_FAILED" } })), null, "an unreadable quote is not 'no promotion'");
});

test("gift slots are celebrated, unclaimed ones ask for a choice, and reached items come before progress", () => {
  const view = buildCartPromotionView(state({
    campaigns: [quantityCampaign],
    // 5 eligible units against N=4: one slot earned, 3 more units to the next.
    entitlements: [{ campaignId: "gift-a", revision: 1, eligibleQuantity: 5, earned: 1, entitled: 1, shortfallToNext: { quantity: 3, subtotalVnd: null } }],
  }))!;
  assert.deepEqual(view.items.map((item) => [item.state, item.kind]), [["achieved", "GIFT"], ["progress", "GIFT"]]);
  const [reached, next] = view.items;
  assert.equal(reached!.title, "Nàng nhận được 1 quà tặng");
  assert.equal(reached!.needsGiftChoice, true);
  assert.equal(next!.title, "Mua thêm 3 sản phẩm để nhận thêm quà");
  assert.equal(next!.progress!.percent, 25, "1 of 4 units toward the next slot");
  assert.deepEqual(view.savings, [], "gifts are not a money saving");
});

test("the next gift is named, once per product, preferring what is in stock", () => {
  const campaign = {
    ...quantityCampaign,
    options: [
      { variantId: "g1", productId: "p1", readyAvailable: 3 },
      { variantId: "g2", productId: "p1", readyAvailable: 2 },
      { variantId: "g3", productId: "p2", readyAvailable: 0 },
    ],
  };
  const labels = [
    { variantId: "g1", productName: "Khăn lụa" },
    { variantId: "g2", productName: "Khăn lụa" },
    { variantId: "g3", productName: "Quạt cầm tay" },
  ];
  const titleFor = (entitled: number, extra: Partial<typeof campaign> = {}, names = labels) => {
    const view = buildCartPromotionView({ ...state({
      campaigns: [{ ...campaign, ...extra }],
      entitlements: [{ campaignId: "gift-a", revision: 1, eligibleQuantity: 3, earned: entitled, entitled, shortfallToNext: { quantity: 1, subtotalVnd: null } }],
    }), labels: names } as unknown as CartGiftState)!;
    return view.items[view.items.length - 1]!.title;
  };
  assert.equal(titleFor(0), "Mua thêm 1 sản phẩm để nhận quà tặng Khăn lụa", "the sold-out gift is not advertised");
  assert.equal(titleFor(1), "Mua thêm 1 sản phẩm để nhận thêm quà tặng Khăn lụa");
  assert.equal(
    titleFor(0, { options: campaign.options.map((option) => ({ ...option, readyAvailable: 1 })) }),
    "Mua thêm 1 sản phẩm để nhận quà tặng Khăn lụa hoặc Quạt cầm tay",
  );
  assert.equal(
    titleFor(0, { options: [...campaign.options.map((option) => ({ ...option, readyAvailable: 1 })), { variantId: "g4", productId: "p3", readyAvailable: 1 }] }, [...labels, { variantId: "g4", productName: "Túi" }]),
    "Mua thêm 1 sản phẩm để nhận quà tặng Khăn lụa, Quạt cầm tay và 1 quà khác",
  );
  assert.equal(titleFor(0, {}, []), "Mua thêm 1 sản phẩm để nhận quà", "no readable name keeps the plain wording");
});

test("an earned gift is named: the chosen one, or the offer before a choice", () => {
  const campaign = {
    ...quantityCampaign,
    options: [
      { variantId: "g1", productId: "p1", readyAvailable: 3 },
      { variantId: "g2", productId: "p2", readyAvailable: 2 },
    ],
  };
  const labels = [{ variantId: "g1", productName: "Khăn lụa" }, { variantId: "g2", productName: "Quạt cầm tay" }];
  const titleWith = (selections: readonly unknown[], names = labels) => buildCartPromotionView({ ...state({
    campaigns: [campaign],
    entitlements: [{ campaignId: "gift-a", revision: 1, eligibleQuantity: 4, earned: 1, entitled: 1, shortfallToNext: null }],
    selections,
  }), labels: names } as unknown as CartGiftState)!.items[0]!.title;
  assert.equal(titleWith([]), "Nàng nhận được 1 quà tặng: Khăn lụa hoặc Quạt cầm tay");
  assert.equal(titleWith([{ campaignId: "gift-a", variantId: "g2", campaignRevision: 1, quantity: 1 }]), "Nàng nhận được 1 quà tặng: Quạt cầm tay");
  assert.equal(titleWith([], []), "Nàng nhận được 1 quà tặng", "no readable name keeps the plain wording");
});

test("a chosen gift reads as done, not as a task", () => {
  const view = buildCartPromotionView(state({
    campaigns: [quantityCampaign],
    entitlements: [{ campaignId: "gift-a", revision: 1, eligibleQuantity: 4, earned: 1, entitled: 1, shortfallToNext: { quantity: 4, subtotalVnd: null } }],
    selections: [{ campaignId: "gift-a", variantId: "g", campaignRevision: 1, quantity: 1 }],
  }))!;
  assert.equal(view.items[0]!.needsGiftChoice, false, "a chosen gift offers no 'Chọn quà' link");
});

test("progress toward a first gift by order value shows the missing amount and a bar that is never full early", () => {
  const view = buildCartPromotionView(state({
    campaigns: [subtotalCampaign],
    entitlements: [{ campaignId: "gift-b", revision: 1, eligibleSubtotalVnd: 3_445_000, earned: 0, entitled: 0, shortfallToNext: { quantity: null, subtotalVnd: 555_000 } }],
  }))!;
  assert.equal(view.items.length, 1);
  const only = view.items[0]!;
  assert.equal(only.state, "progress");
  assert.equal(only.title, `Mua thêm ${vnd("555.000")} để nhận quà`);
  assert.equal(only.progress!.percent, 86);
  assert.equal(only.progress!.label, `Còn thiếu ${vnd("555.000")}`);
});

test("several campaigns on the way show only the nearest bar", () => {
  const view = buildCartPromotionView(state({
    campaigns: [quantityCampaign, subtotalCampaign],
    entitlements: [
      { campaignId: "gift-a", revision: 1, eligibleQuantity: 1, earned: 0, entitled: 0, shortfallToNext: { quantity: 3, subtotalVnd: null } },
      { campaignId: "gift-b", revision: 1, eligibleSubtotalVnd: 3_445_000, earned: 0, entitled: 0, shortfallToNext: { quantity: null, subtotalVnd: 555_000 } },
    ],
  }))!;
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0]!.id, "gift-next-gift-b", "86% beats 25%");
});

test("a campaign with no next slot (cap reached, or a once-only gift already earned) shows no bar", () => {
  const view = buildCartPromotionView(state({
    campaigns: [subtotalCampaign],
    entitlements: [{ campaignId: "gift-b", revision: 1, earned: 1, entitled: 1, shortfallToNext: null }],
    selections: [{ campaignId: "gift-b", variantId: "g", campaignRevision: 1, quantity: 1 }],
  }))!;
  assert.deepEqual(view.items.map((item) => item.state), ["achieved"]);
});

test("a gift campaign dropped by stacking claims nothing", () => {
  // The cart zeroes a dropped campaign's entitlement and its shortfall.
  const view = buildCartPromotionView(state({
    campaigns: [quantityCampaign],
    entitlements: [{ campaignId: "gift-a", revision: 1, earned: 2, entitled: 0, shortfallToNext: null }],
  }));
  assert.equal(view, null);
});

test("cart view model carries the banner, and withholds it while benefits cannot be trusted", () => {
  const good = buildCartViewModel({ lines: [cartLine], commerceTrackingEnabled: false, benefitCheckoutOpen: true, giftState: state({ steps: [tierStep] }) });
  assert.equal(good.promotions?.savingsVnd, 267_000);

  const unreadable = buildCartViewModel({ lines: [cartLine], commerceTrackingEnabled: false, benefitsUnavailable: true, giftState: state({ steps: [tierStep] }) });
  assert.equal(unreadable.promotions, undefined, "no green banner next to 'cannot check benefits'");

  const staleGift = buildCartViewModel({ lines: [cartLine], commerceTrackingEnabled: false, benefitCheckoutOpen: true, giftState: state({ steps: [tierStep], validationOk: false }) });
  assert.equal(staleGift.promotions, undefined, "no green banner next to 'your gift is no longer valid'");

  const off = buildCartViewModel({ lines: [cartLine], commerceTrackingEnabled: false });
  assert.equal("promotions" in off, false, "gate OFF: the view model is exactly what it was");
});

/* -------------------------------------------------------------------------- checkout */

/** The signed quote names a step's campaign kind where the cart's stack calls it `kind`. */
const quoteTierStep = { campaignId: "tier", source: "QUANTITY_TIER" as const, campaignKind: "QUANTITY_TIER", priority: 1, inputPriceVnd: 689_000, outputPriceVnd: 600_000, appliedQuantity: 3 };

function checkoutRender(gifts: number, steps: readonly (typeof quoteTierStep)[]): Extract<BenefitCheckoutRender, { kind: "BENEFIT" }> {
  const facts = buildBenefitCheckoutQuoteFacts({
    paid: [
      { groupKey: "g|disc", pancakeVariationId: "var-1", quantity: 3, unitPriceVnd: 600_000, steps: steps as never, fulfillmentState: "READY" },
      { groupKey: "g|full", pancakeVariationId: "var-1", quantity: 2, unitPriceVnd: 689_000, steps: [], fulfillmentState: "READY" },
    ],
    gifts: gifts === 0 ? [] : [{ campaignId: "camp", campaignRevision: 1, pancakeVariationId: "var-g", quantity: gifts }],
    entitlements: [{ campaignId: "camp", campaignRevision: 1, entitled: gifts, selected: gifts, skippedWhileAvailable: 0, contendedForSharedStock: 0, shortForStock: 0 }],
  });
  assert.ok(facts, "the checkout fixture must be a valid quote");
  return { kind: "BENEFIT", facts, proof: "proof", digest: "digest", needsAcknowledgement: false, giftLabels: new Map([["var-g", "Khăn lụa"]]), tierDropped: false };
}

test("checkout announces the tier saving and the gifts the signed quote actually contains", () => {
  const model = buildBenefitCheckoutViewModel({ lines: [cartLine], render: { ...checkoutRender(2, [quoteTierStep]), campaignNames: new Map([["tier", "Mua 3 giảm 13%"]]) } });
  assert.deepEqual(model.promotions?.savings.map((row) => [row.label, row.amountText]), [["Mua 3 giảm 13%", vnd("267.000")]]);
  assert.deepEqual(model.promotions?.items.map((item) => item.kind), ["TIER", "GIFT"]);
  assert.equal(model.promotions?.items[1]!.title, "Đơn hàng được tặng 2 quà");
  assert.ok(model.promotions!.items.every((item) => item.state === "achieved"), "checkout never nudges toward more items");
});

test("a benefit checkout with neither a tier nor a gift has no banner", () => {
  const model = buildBenefitCheckoutViewModel({ lines: [cartLine], render: checkoutRender(0, []) });
  assert.equal(model.promotions, undefined);
  assert.equal(buildCheckoutPromotionView({ lines: [] }, 0), null);
});

test("a legacy flash-sale step on a paid line is not reported as an earned tier", () => {
  const view = buildCheckoutPromotionView({ lines: [{ role: "PAID", quantity: 5, discountSteps: [legacyStep as never] }] }, 0);
  assert.equal(view, null);
});

/* -------------------------------------------------------------------------- one row per campaign */

test("two campaigns give two named rows, the larger first, each its own amount", () => {
  const small = { ...tierStep, campaignId: "small", inputPriceVnd: 100_000, outputPriceVnd: 95_000 };
  const bigA = { ...tierStep, campaignId: "big", inputPriceVnd: 689_000, outputPriceVnd: 600_000 };
  const bigB = { ...tierStep, campaignId: "big", inputPriceVnd: 500_000, outputPriceVnd: 450_000 };
  const groups = [{ quantity: 2, steps: [small] }, { quantity: 3, steps: [bigA] }, { quantity: 1, steps: [bigB] }];
  const rows = tierSavingRows(groups, new Map([["small", "Mua 2 giảm 5k"], ["big", "Mua 5 giảm 10%"]]));
  assert.deepEqual(rows.map((row) => [row.label, row.amountVnd]), [["Mua 5 giảm 10%", 267_000 + 50_000], ["Mua 2 giảm 5k", 10_000]]);
  assert.equal(tierSavingsVnd(groups), 317_000 + 10_000, "the total is the sum of the rows");
});

test("a campaign whose name is unknown still gets an honest line, and a blank name does too", () => {
  assert.equal(tierSavingRows([{ quantity: 3, steps: [tierStep] }])[0]!.label, "Ưu đãi mua nhiều");
  assert.equal(tierSavingRows([{ quantity: 3, steps: [tierStep] }], new Map([["tier", "   "]]))[0]!.label, "Ưu đãi mua nhiều");
});

test("the view model carries every campaign's row, not one merged number", () => {
  const steps = [{ ...tierStep, campaignId: "a" }, { ...tierStep, campaignId: "b", outputPriceVnd: 650_000 }];
  const view = buildCartPromotionView(state({ steps, names: new Map([["a", "Mua 3 giảm 13%"], ["b", "Mua 3 giảm 5%"]]) }))!;
  assert.deepEqual(view.savings.map((row) => row.label), ["Mua 3 giảm 13%", "Mua 3 giảm 5%"]);
  assert.equal(view.items.filter((item) => item.kind === "TIER").length, 1, "the banner stays one quiet line");
});

/* -------------------------------------------------------------------------- per-product discount on the line */

test("a per-product promotion reads as a struck-through price and a percentage", () => {
  const discount = describeLineDiscount(800_000, 689_000)!;
  assert.equal(discount.originalPriceText, vnd("800.000"));
  assert.equal(discount.percent, 14);
});

test("no promotion is claimed unless the price really is lower", () => {
  assert.equal(describeLineDiscount(689_000, 689_000), null);
  assert.equal(describeLineDiscount(600_000, 689_000), null);
  assert.equal(describeLineDiscount(undefined, 689_000), null);
  assert.equal(describeLineDiscount(800_000, null), null);
  assert.equal(describeLineDiscount(Number.NaN, 1), null);
  assert.equal(describeLineDiscount(1_000_000, 999_999)!.percent, null, "under 1% shows the strike-through only");
});

test("the cart line carries the catalog price only when it is discounted and buyable", () => {
  const flash = { ...cartLine, price: 689_000, basePrice: 800_000 } as StorefrontCartLine;
  const model = buildCartViewModel({ lines: [flash, { ...cartLine, variantId: "plain" }], commerceTrackingEnabled: false });
  assert.equal(model.lines[0]!.originalPriceText, vnd("800.000"));
  assert.equal(model.lines[0]!.discountPercent, 14);
  assert.equal("originalPriceText" in model.lines[1]!, false, "an undiscounted line is exactly what it was");

  const gone = buildCartViewModel({ lines: [{ ...flash, available: false } as StorefrontCartLine], commerceTrackingEnabled: false });
  assert.equal("originalPriceText" in gone.lines[0]!, false, "a line that cannot be bought claims no promotion");
});

test("checkout names the per-product promotion on the line, from the quote's legacy step", () => {
  const legacy = { campaignId: "flash", source: "LEGACY" as const, campaignKind: "FLASH_SALE", priority: null, inputPriceVnd: 800_000, outputPriceVnd: 689_000, appliedQuantity: 5 };
  const facts = buildBenefitCheckoutQuoteFacts({
    paid: [{ groupKey: "g", pancakeVariationId: "var-1", quantity: 5, unitPriceVnd: 689_000, steps: [legacy], fulfillmentState: "READY" }],
    gifts: [{ campaignId: "camp", campaignRevision: 1, pancakeVariationId: "var-g", quantity: 1 }],
    entitlements: [{ campaignId: "camp", campaignRevision: 1, entitled: 1, selected: 1, skippedWhileAvailable: 0, contendedForSharedStock: 0, shortForStock: 0 }],
  });
  assert.ok(facts);
  const model = buildBenefitCheckoutViewModel({
    lines: [cartLine],
    render: { kind: "BENEFIT", facts, proof: "p", digest: "d", needsAcknowledgement: false, giftLabels: new Map(), tierDropped: false },
  });
  assert.equal(model.lines[0]!.originalPriceText, vnd("800.000"));
  assert.equal(model.lines[0]!.discountPercent, 14);
  assert.deepEqual(model.promotions?.savings, [], "a per-product promotion is on the line, not a cart-level saving row");
});

test("a group split by a later step is not counted twice: savings use the group's own quantity", () => {
  // 3 units: a quantity ladder took 89.000 off each (step recorded with appliedQuantity 3), then an order-value
  // total split them into 1 + 2 units. Both halves inherited the quantity step with appliedQuantity 3.
  const quantityStep = { ...tierStep, campaignId: "qty", appliedQuantity: 3 };
  const orderA = { ...tierStep, campaignId: "order", inputPriceVnd: 600_000, outputPriceVnd: 599_000, appliedQuantity: 1 };
  const orderB = { ...tierStep, campaignId: "order", inputPriceVnd: 600_000, outputPriceVnd: 598_000, appliedQuantity: 2 };
  const rows = tierSavingRows(
    [{ quantity: 1, steps: [quantityStep, orderA] }, { quantity: 2, steps: [quantityStep, orderB] }],
    new Map([["qty", "Mua 3 giảm 13%"], ["order", "Đơn từ 1 triệu giảm 5.000 ₫"]]),
  );
  const byLabel = new Map(rows.map((row) => [row.label, row.amountVnd]));
  assert.equal(byLabel.get("Mua 3 giảm 13%"), 89_000 * 3, "3 units, not 6");
  assert.equal(byLabel.get("Đơn từ 1 triệu giảm 5.000 ₫"), 1_000 * 1 + 2_000 * 2);
});

/* -------------------------------------------------------------------------- progress to the next order-value rung */

const orderProgress = (over: Record<string, unknown> = {}) => ({
  campaignId: "order", currentVnd: 940_000, reachedThresholdVnd: null,
  next: { thresholdVnd: 1_000_000, unit: "PERCENTAGE", value: 5, shortfallVnd: 60_000 }, ...over,
});
const withProgress = (...entries: unknown[]) => state({ benefits: { enabled: true, ok: true, subtotalVnd: 940_000, dropped: [], campaignNames: new Map(), orderValueProgress: entries, groups: [] } });

test("the next order-value rung is a bar: what is missing and what it would take off", () => {
  const view = buildCartPromotionView(withProgress(orderProgress()))!;
  assert.equal(view.items.length, 1);
  const item = view.items[0]!;
  assert.equal(item.state, "progress");
  assert.equal(item.title, `Mua thêm ${vnd("60.000")} để được giảm 5%`);
  assert.equal(item.progress!.percent, 94, "940.000 of 1.000.000 from nothing");
  assert.equal(item.progress!.label, `Còn thiếu ${vnd("60.000")}`);
});

test("a fixed total reads as money, and the bar runs from the rung already reached", () => {
  const view = buildCartPromotionView(withProgress(orderProgress({
    currentVnd: 2_500_000, reachedThresholdVnd: 2_000_000,
    next: { thresholdVnd: 3_000_000, unit: "FIXED_AMOUNT_TOTAL_VND", value: 200_000, shortfallVnd: 500_000 },
  })))!;
  assert.equal(view.items[0]!.title, `Mua thêm ${vnd("500.000")} để được giảm ${vnd("200.000")}`);
  assert.equal(view.items[0]!.progress!.percent, 50, "halfway between the 2.000.000 rung and the 3.000.000 one");
});

test("a ladder with nothing left to reach adds no bar, and no progress field means none", () => {
  assert.equal(buildCartPromotionView(withProgress()), null);
  assert.equal(buildCartPromotionView(state()), null);
});

test("only the nearest bar is shown across gifts and order-value ladders", () => {
  const view = buildCartPromotionView(state({
    benefits: { enabled: true, ok: true, subtotalVnd: 1, dropped: [], campaignNames: new Map(), groups: [], orderValueProgress: [orderProgress()] },
    campaigns: [quantityCampaign],
    entitlements: [{ campaignId: "gift-a", revision: 1, eligibleQuantity: 1, earned: 0, entitled: 0, shortfallToNext: { quantity: 3, subtotalVnd: null } }],
  }))!;
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0]!.id, "order-next-order", "94 % beats 25 %");
});

/* -------------------------------------------------------------------------- tier ordered BEFORE a Flash Sale */

// Listed at 1.000.000 ₫, the Flash Sale alone makes it 900.000 ₫ (what the line shows). Ordered tier-first,
// a 100.000 ₫ tier comes off the catalog price and the sale then takes 10 % of 900.000: 810.000 ₫ is paid.
// The ledger's tier step says 100.000 ₫, but the shopper gained 90.000 ₫ over the listed price.
const tierFirstSteps = [
  { campaignId: "tier", source: "QUANTITY_TIER" as const, kind: "QUANTITY_TIER", priority: 1, inputPriceVnd: 1_000_000, outputPriceVnd: 900_000, appliedQuantity: 1 },
  { campaignId: "flash", source: "LEGACY" as const, kind: "FLASH_SALE", priority: 2, inputPriceVnd: 900_000, outputPriceVnd: 810_000, appliedQuantity: 1 },
];

test("savings are measured against the listed price, not the tier step's own input", () => {
  const group = { quantity: 1, unitPriceVnd: 810_000, steps: tierFirstSteps };
  assert.equal(tierSavingsVnd([group]), 100_000, "unmeasured, the ledger amount");
  assert.deepEqual(tierSavingRows([group], undefined, () => 900_000).map((row) => row.amountVnd), [90_000]);
  assert.deepEqual(tierSavingRows([group], undefined, () => 810_000), [], "the tier added nothing over the listed price");
  assert.deepEqual(tierSavingRows([group], undefined, () => 800_000), [], "a price paid above the listed price saves nothing");
});

test("the gain over the listed price is split across tier campaigns exactly, in proportion to the ledger", () => {
  const steps = [
    { campaignId: "a", source: "QUANTITY_TIER" as const, kind: "QUANTITY_TIER", priority: 1, inputPriceVnd: 1_000_000, outputPriceVnd: 940_000, appliedQuantity: 3 },
    { campaignId: "b", source: "QUANTITY_TIER" as const, kind: "QUANTITY_TIER", priority: 2, inputPriceVnd: 940_000, outputPriceVnd: 900_000, appliedQuantity: 3 },
    { campaignId: "flash", source: "LEGACY" as const, kind: "FLASH_SALE", priority: 3, inputPriceVnd: 900_000, outputPriceVnd: 810_000, appliedQuantity: 3 },
  ];
  const rows = tierSavingRows([{ quantity: 3, unitPriceVnd: 810_000, steps }], undefined, () => 900_000);
  assert.equal(rows.reduce((sum, row) => sum + row.amountVnd, 0), 3 * 90_000, "rows add up to listed minus paid");
  assert.deepEqual(rows.map((row) => row.id), ["a", "b"].sort((x, y) => rows.find((r) => r.id === y)!.amountVnd - rows.find((r) => r.id === x)!.amountVnd));
});

test("cart: tier-before-legacy reconciles, so the money block closes on the lines' own total", () => {
  const line = { ...cartLine, quantity: 1, price: 900_000, basePrice: 1_000_000 } as StorefrontCartLine;
  const giftState = {
    ...state({ benefits: { enabled: true, ok: true, subtotalVnd: 810_000, dropped: [], campaignNames: new Map([["tier", "Giảm 100k"]]), groups: [
      { groupKey: "paid", lineKey: "paid", quantity: 1, unitPriceVnd: 810_000, steps: tierFirstSteps },
    ] } }),
  } as CartGiftState;
  const model = buildCartViewModel({ lines: [line], commerceTrackingEnabled: false, benefitCheckoutOpen: true, giftState, shippingPolicy: DEFAULT_GUEST_SHIPPING_POLICY });
  assert.ok(model.summary, "the summary is shown rather than withheld");
  assert.equal(model.summary.valueText, vnd("900.000"), "Tổng giá trị = the line, not 910.000");
  assert.deepEqual(model.summary.discounts.map((row) => [row.label, row.amountText]), [["Giảm 100k", `−${vnd("90.000")}`]]);
  assert.equal(model.promotions?.savingsVnd, 90_000);
});

function tierFirstCheckout(): Extract<BenefitCheckoutRender, { kind: "BENEFIT" }> {
  const facts = buildBenefitCheckoutQuoteFacts({
    paid: [{
      groupKey: "g", pancakeVariationId: "var-1", quantity: 1, unitPriceVnd: 810_000, fulfillmentState: "READY",
      steps: [
        { ...quoteTierStep, inputPriceVnd: 1_000_000, outputPriceVnd: 900_000, appliedQuantity: 1 },
        { campaignId: "flash", source: "LEGACY", campaignKind: "FLASH_SALE", priority: 2, inputPriceVnd: 900_000, outputPriceVnd: 810_000, appliedQuantity: 1 },
      ] as never,
    }],
    gifts: [],
    entitlements: [],
  });
  assert.ok(facts, "the checkout fixture must be a valid quote");
  return { kind: "BENEFIT", facts, proof: "proof", digest: "digest", needsAcknowledgement: false, giftLabels: new Map(), tierDropped: false, campaignNames: new Map([["tier", "Giảm 100k"]]) };
}

test("checkout: tier-before-legacy shows 900.000 as the value and 90.000 as the saving", () => {
  const line = { ...cartLine, quantity: 1, price: 900_000, basePrice: 1_000_000 } as StorefrontCartLine;
  const model = buildBenefitCheckoutViewModel({ lines: [line], render: tierFirstCheckout() });
  assert.equal(model.summary?.valueText, vnd("900.000"));
  assert.deepEqual(model.summary?.discounts.map((row) => row.amountText), [`−${vnd("90.000")}`]);
  assert.equal(model.promotions?.savingsVnd, 90_000);
});

test("checkout: with no listed price to prove the value against, no summary is claimed", () => {
  const model = buildBenefitCheckoutViewModel({ lines: [], render: tierFirstCheckout() });
  assert.equal(model.summary, undefined);
});

/* -------------------------------------------------------------------------- ordinary checkout, per-line price */

test("ordinary checkout: a sale line carries its charged unit price beside the struck price, for quantity > 1", () => {
  const line = { ...cartLine, quantity: 3, price: 600_000, basePrice: 800_000, pancakeVariationId: "var-1" } as StorefrontCartLine;
  const model = buildCheckoutViewModel({
    lines: [line],
    totals: { items: [{ variantExternalId: "var-1", quantity: 3, unitPriceVnd: 600_000, fulfillmentState: "READY" }], merchandiseSubtotalVnd: 1_800_000, shippingFeeVnd: 0, totalVnd: 1_800_000, totalQuantity: 3 } as never,
    quoteProof: "proof",
  });
  const paid = model.lines[0]!;
  assert.equal(paid.unitPriceText, vnd("600.000"), "the new price, not null");
  assert.equal(paid.originalPriceText, vnd("800.000"));
  assert.equal(paid.discountPercent, 25);
  assert.equal(paid.lineTotalText, vnd("1.800.000"));
});

/* -------------------------------------------------------------------------- checkout fallback block */

test("the checkout fallback never prints a saving beneath an already-net 'Tạm tính'", () => {
  const source = readFileSync(new URL("../../src/app/checkout/page.tsx", import.meta.url), "utf8");
  const fallback = source.slice(source.indexOf("const fallbackTotals"), source.indexOf("const totalsBlock"));
  assert.ok(fallback.includes("totals.subtotalText"), "the fallback shows the quote's own subtotal");
  assert.equal(fallback.includes("savings"), false, "so it must not subtract the savings again");
  assert.equal(fallback.includes("data-promotion-savings"), false);
});

/* -------------------------------------------------------------------------- Flash Sale AND tier on one line */

const flashLine = { ...cartLine, quantity: 1, price: 900_000, basePrice: 1_000_000 } as StorefrontCartLine;
const flashThenTier = [
  { campaignId: "flash", source: "LEGACY", campaignKind: "FLASH_SALE", priority: 1, inputPriceVnd: 1_000_000, outputPriceVnd: 900_000, appliedQuantity: 1 },
  { ...quoteTierStep, priority: 2, inputPriceVnd: 900_000, outputPriceVnd: 810_000, appliedQuantity: 1 },
];
const tierThenFlash = [
  { ...quoteTierStep, priority: 1, inputPriceVnd: 1_000_000, outputPriceVnd: 900_000, appliedQuantity: 1 },
  { campaignId: "flash", source: "LEGACY", campaignKind: "FLASH_SALE", priority: 2, inputPriceVnd: 900_000, outputPriceVnd: 810_000, appliedQuantity: 1 },
];

function stackedCheckout(steps: readonly unknown[]): Extract<BenefitCheckoutRender, { kind: "BENEFIT" }> {
  const facts = buildBenefitCheckoutQuoteFacts({
    paid: [{ groupKey: "g", pancakeVariationId: "var-1", quantity: 1, unitPriceVnd: 810_000, fulfillmentState: "READY", steps: steps as never }],
    gifts: [], entitlements: [],
  });
  assert.ok(facts, "the checkout fixture must be a valid quote");
  return { kind: "BENEFIT", facts, proof: "proof", digest: "digest", needsAcknowledgement: false, giftLabels: new Map(), tierDropped: false, campaignNames: new Map([["tier", "Giảm 100k"]]) };
}

for (const [order, steps] of [["Flash Sale then tier", flashThenTier], ["tier then Flash Sale", tierThenFlash]] as const) {
  test(`checkout (${order}): the −10% sits beside the price it was measured to, and the tier price is shown apart`, () => {
    const line = buildBenefitCheckoutViewModel({ lines: [flashLine], render: stackedCheckout(steps) }).lines[0]!;
    assert.equal(line.originalPriceText, vnd("1.000.000"));
    assert.equal(line.discountPercent, 10, "catalog → sale price, exactly the two numbers beside it");
    assert.equal(line.promotionPriceText, vnd("900.000"), "the price the −10% leads to");
    assert.equal(line.unitPriceText, vnd("810.000"), "the price finally charged, not mislabelled as the sale");
  });
}

test("checkout: a tier alone gives no sale badge, and a sale alone needs no second price", () => {
  const tierOnly = buildBenefitCheckoutViewModel({ lines: [{ ...cartLine, quantity: 1, price: 1_000_000, basePrice: undefined } as StorefrontCartLine], render: stackedCheckout([{ ...quoteTierStep, inputPriceVnd: 1_000_000, outputPriceVnd: 810_000, appliedQuantity: 1 }]) }).lines[0]!;
  assert.equal(tierOnly.originalPriceText, undefined);
  assert.equal(tierOnly.promotionPriceText, undefined);
  const saleOnlyFacts = buildBenefitCheckoutQuoteFacts({
    paid: [{ groupKey: "g", pancakeVariationId: "var-1", quantity: 1, unitPriceVnd: 900_000, fulfillmentState: "READY", steps: [flashThenTier[0]] as never }],
    gifts: [], entitlements: [],
  })!;
  const saleOnly = buildBenefitCheckoutViewModel({ lines: [flashLine], render: { kind: "BENEFIT", facts: saleOnlyFacts, proof: "p", digest: "d", needsAcknowledgement: false, giftLabels: new Map(), tierDropped: false } }).lines[0]!;
  assert.deepEqual([saleOnly.originalPriceText, saleOnly.discountPercent, saleOnly.promotionPriceText], [vnd("1.000.000"), 10, undefined]);
});

test("cart: a line with a Flash Sale AND a tier keeps the sale on the line and lists the tier price apart", () => {
  const giftState = state({ benefits: { enabled: true, ok: true, subtotalVnd: 810_000, dropped: [], campaignNames: new Map(), groups: [
    { groupKey: "paid", lineKey: "paid", quantity: 1, unitPriceVnd: 810_000, steps: tierFirstSteps },
  ] } });
  const model = buildCartViewModel({ lines: [flashLine], commerceTrackingEnabled: false, benefitCheckoutOpen: true, giftState });
  const line = model.lines[0]!;
  assert.equal(line.originalPriceText, vnd("1.000.000"));
  assert.equal(line.discountPercent, 10);
  assert.equal(line.priceText, vnd("900.000"));
  assert.deepEqual(line.paidSegments, [`1 × ${vnd("810.000")}`]);
});

test("the cart page and the drawer render the sale price whether or not a tier price is also listed", () => {
  for (const path of ["../../src/app/cart/page.tsx", "../../src/components/brand/cart-drawer.tsx"]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.equal(/paidSegments\s*\?\s*\(?\s*(?:"|line\.paidSegments\.join)/.test(source.replace(/\{line\.paidSegments \? <p/g, "")), false, `${path}: paidSegments must not replace the LinePrice`);
    assert.ok(source.includes("<LinePrice"), `${path} renders LinePrice`);
    assert.match(source, /Giá sau ưu đãi/);
  }
});
