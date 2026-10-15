import assert from "node:assert/strict";
import test from "node:test";

import type { BenefitCheckoutRender } from "../../src/commerce/benefit-checkout-render.ts";
import type { CartGiftState } from "../../src/commerce/cart-gift-selection.ts";
import { buildBenefitCheckoutQuoteFacts } from "../../src/commerce/checkout-quote.ts";
import type { StorefrontCartLine } from "../../src/commerce/storefront-cart.ts";
import { buildCartViewModel } from "../../src/routes/cart-model.ts";
import { buildCartPromotionView, buildCheckoutPromotionView, tierSavingsVnd } from "../../src/routes/cart-promotion-model.ts";
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
}>;

function state(o: Overrides = {}): CartGiftState {
  return {
    quote: {
      lines: [cartLine],
      benefits: o.benefits ?? { enabled: true, ok: true, subtotalVnd: 3_445_000, dropped: [], groups: [
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

test("a reached tier is announced with what it saved, and the footer gets the same number", () => {
  const view = buildCartPromotionView(state({ steps: [tierStep] }))!;
  assert.equal(view.savingsVnd, 267_000);
  assert.equal(view.savingsText, vnd("267.000"));
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
  assert.equal(view.savingsText, null);
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
  const model = buildBenefitCheckoutViewModel({ lines: [cartLine], render: checkoutRender(2, [quoteTierStep]) });
  assert.equal(model.promotions?.savingsText, vnd("267.000"));
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
