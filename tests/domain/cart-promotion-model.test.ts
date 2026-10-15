import assert from "node:assert/strict";
import test from "node:test";

import type { BenefitCheckoutRender } from "../../src/commerce/benefit-checkout-render.ts";
import type { CartGiftState } from "../../src/commerce/cart-gift-selection.ts";
import { buildBenefitCheckoutQuoteFacts } from "../../src/commerce/checkout-quote.ts";
import type { StorefrontCartLine } from "../../src/commerce/storefront-cart.ts";
import { buildCartViewModel } from "../../src/routes/cart-model.ts";
import { buildCartPromotionView, buildCheckoutPromotionView, tierSavingRows, tierSavingsVnd } from "../../src/routes/cart-promotion-model.ts";
import { describeLineDiscount } from "../../src/routes/line-discount-model.ts";
import { buildBenefitCheckoutViewModel } from "../../src/routes/checkout-model.ts";

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

test("only quantity-tier steps count as savings; the flash-sale price is already on the line", () => {
  assert.equal(tierSavingsVnd([{ steps: [tierStep] }]), (689_000 - 600_000) * 3);
  assert.equal(tierSavingsVnd([{ steps: [legacyStep] }]), 0, "a legacy step is not a tier saving");
  assert.equal(tierSavingsVnd([{ steps: [{ ...tierStep, outputPriceVnd: 700_000 }] }]), 0, "a step that raises the price saves nothing");
  assert.equal(tierSavingsVnd([{ discountSteps: [tierStep] }, { steps: [tierStep] }]), 2 * (689_000 - 600_000) * 3, "checkout facts and cart groups read the same");
  assert.equal(tierSavingsVnd([]), 0);
});

test("a reached tier is announced, and its saving line is named by the campaign", () => {
  const view = buildCartPromotionView(state({ steps: [tierStep] }))!;
  assert.equal(view.savingsVnd, 267_000);
  assert.deepEqual(view.savings.map((row) => [row.id, row.label, row.amountText]), [["tier", "Mua 3 giảm 13%", vnd("267.000")]]);
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0]!.state, "achieved");
  assert.equal(view.items[0]!.kind, "TIER");
  assert.equal(view.items[0]!.title, "Đã áp dụng ưu đãi mua nhiều");
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
  assert.equal(reached!.title, "Bạn nhận được 1 quà tặng");
  assert.equal(reached!.needsGiftChoice, true);
  assert.equal(next!.title, "Mua thêm 3 sản phẩm để nhận thêm quà");
  assert.equal(next!.progress!.percent, 25, "1 of 4 units toward the next slot");
  assert.deepEqual(view.savings, [], "gifts are not a money saving");
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
  const view = buildCheckoutPromotionView({ lines: [{ role: "PAID", discountSteps: [legacyStep as never] }] }, 0);
  assert.equal(view, null);
});

/* -------------------------------------------------------------------------- one row per campaign */

test("two campaigns give two named rows, the larger first, each its own amount", () => {
  const steps = [
    { ...tierStep, campaignId: "small", inputPriceVnd: 100_000, outputPriceVnd: 95_000, appliedQuantity: 2 },
    { ...tierStep, campaignId: "big", inputPriceVnd: 689_000, outputPriceVnd: 600_000, appliedQuantity: 3 },
    { ...tierStep, campaignId: "big", inputPriceVnd: 500_000, outputPriceVnd: 450_000, appliedQuantity: 1 },
  ];
  const rows = tierSavingRows([{ steps }], new Map([["small", "Mua 2 giảm 5k"], ["big", "Mua 5 giảm 10%"]]));
  assert.deepEqual(rows.map((row) => [row.label, row.amountVnd]), [["Mua 5 giảm 10%", 267_000 + 50_000], ["Mua 2 giảm 5k", 10_000]]);
  assert.equal(tierSavingsVnd([{ steps }]), 317_000 + 10_000, "the total is the sum of the rows");
});

test("a campaign whose name is unknown still gets an honest line, and a blank name does too", () => {
  assert.equal(tierSavingRows([{ steps: [tierStep] }])[0]!.label, "Ưu đãi mua nhiều");
  assert.equal(tierSavingRows([{ steps: [tierStep] }], new Map([["tier", "   "]]))[0]!.label, "Ưu đãi mua nhiều");
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
