import assert from "node:assert/strict";
import test from "node:test";

import type { BenefitCheckoutRender } from "../../src/commerce/benefit-checkout-render.ts";
import {
  benefitQuoteDigest,
  issueBenefitQuoteProof,
  verifyBenefitQuoteProof,
  verifyNonclaimAcknowledgement,
} from "../../src/commerce/checkout-quote-proof.ts";
import { buildBenefitCheckoutQuoteFacts } from "../../src/commerce/checkout-quote.ts";
import type { CartGiftState } from "../../src/commerce/cart-gift-selection.ts";
import { checkoutSubmitFeedback } from "../../src/commerce/checkout-submit-feedback.ts";
import { createGuestCheckoutSubmitRuntime } from "../../src/commerce/guest-checkout-submit-runtime.ts";
import type { StorefrontCartLine } from "../../src/commerce/storefront-cart.ts";
import { buildCartViewModel } from "../../src/routes/cart-model.ts";
import {
  buildBenefitCheckoutViewModel,
  buildBenefitUnavailableCheckoutViewModel,
} from "../../src/routes/checkout-model.ts";

/** GQ19 -- what a buyer sees and signs at checkout when the cart has gifts or quantity-tier segments. */

const secret = "test-server-secret-at-least-32-characters-long";
const cartId = "0f8d3c2a-4b1e-4d7a-9c6b-2e5f1a8d4c30";
const NOW = new Date("2026-10-14T10:00:00.000Z");
const vnd = (amount: string): string => `${amount}\u00a0₫`;

const cartLine = {
  variantId: "paid", pancakeVariationId: "var-1", pancakeProductId: "product", productSlug: "ao",
  productName: "Áo sơ mi", color: "Trắng", size: "M", quantity: 3, price: 100_001, available: true,
  unavailableReason: null, isPreorderSale: false, media: { primary: null, gallery: [] },
} as StorefrontCartLine;

const tierStep = { campaignId: "tier-1", source: "QUANTITY_TIER" as const, campaignKind: "QUANTITY_TIER", priority: 1, inputPriceVnd: 100_001, outputPriceVnd: 90_001, appliedQuantity: 1 };

/** 2 × 100.001 + 1 × 90.001 paid, 1 gift taken of 3 earned, so 2 slots are left unclaimed. */
function facts(selected = 1, entitled = 3) {
  return buildBenefitCheckoutQuoteFacts({
    paid: [
      { groupKey: "g|full", pancakeVariationId: "var-1", quantity: 2, unitPriceVnd: 100_001, steps: [], fulfillmentState: "READY" },
      { groupKey: "g|disc", pancakeVariationId: "var-1", quantity: 1, unitPriceVnd: 90_001, steps: [tierStep], fulfillmentState: "READY" },
    ],
    gifts: selected === 0 ? [] : [{ campaignId: "camp", campaignRevision: 3, pancakeVariationId: "var-g", quantity: selected }],
    entitlements: [{ campaignId: "camp", campaignRevision: 3, entitled, selected, skippedWhileAvailable: entitled - selected, contendedForSharedStock: 0, shortForStock: 0 }],
  })!;
}

function render(overrides: Partial<Extract<BenefitCheckoutRender, { kind: "BENEFIT" }>> = {}): Extract<BenefitCheckoutRender, { kind: "BENEFIT" }> {
  const quote = facts();
  return {
    kind: "BENEFIT",
    facts: quote,
    proof: issueBenefitQuoteProof({ quote, cartId, secret })!,
    digest: benefitQuoteDigest(quote),
    needsAcknowledgement: true,
    giftLabels: new Map([["var-g", "Khăn lụa — Trắng / M"]]),
    tierDropped: false,
    ...overrides,
  };
}

test("split paid prices are separate lines, gifts are 0đ and outside the subtotal", () => {
  const model = buildBenefitCheckoutViewModel({ lines: [cartLine], render: render() });

  assert.equal(model.state, "ready");
  assert.deepEqual(model.lines.map((l) => [l.quantity, l.unitPriceText, l.lineTotalText]), [
    [2, vnd("100.001"), vnd("200.002")],
    [1, vnd("90.001"), vnd("90.001")],
  ]);
  assert.equal(new Set(model.lines.map((l) => l.lineKey)).size, 2, "one variation twice must not collide on a React key");
  assert.deepEqual(model.benefit!.giftLines.map((g) => [g.label, g.quantity, g.priceText]), [["Khăn lụa — Trắng / M", 1, vnd("0")]]);
  assert.equal(model.totals!.subtotalText, vnd("290.003"), "the gift adds nothing to what is paid");
  assert.equal(model.totals!.shippingText, "Miễn phí", "3 paid items ship free under the server policy; the gift is not counted");
  assert.equal(model.totals!.totalText, vnd("290.003"));
  assert.equal(model.quoteProof, render().proof);
});

test("FR-06: earned, chosen and left-over slots are stated, and the acknowledgement label names the count", () => {
  const model = buildBenefitCheckoutViewModel({ lines: [cartLine], render: render() });
  const benefit = model.benefit!;

  assert.deepEqual(benefit.slots, { entitled: 3, selected: 1, unclaimed: 2, skippedWhileAvailable: 2, shortForStock: 0 });
  assert.equal(benefit.needsAcknowledgement, true);
  assert.match(benefit.unclaimedText!, /hưởng 3 suất quà, đã chọn 1, chưa nhận 2/);
  assert.match(benefit.unclaimedText!, /2 suất còn có thể chọn/);
  assert.match(benefit.acknowledgementLabel!, /không nhận 2 suất quà/);
});

test("EX-12: a cart that takes no gift at all still asks, and shows no gift lines", () => {
  const quote = facts(0, 2);
  const model = buildBenefitCheckoutViewModel({ lines: [cartLine], render: render({ facts: quote, digest: benefitQuoteDigest(quote), proof: issueBenefitQuoteProof({ quote, cartId, secret })! }) });

  assert.deepEqual(model.benefit!.giftLines, []);
  assert.equal(model.benefit!.giftQuantity, 0);
  assert.equal(model.benefit!.needsAcknowledgement, true);
  assert.match(model.benefit!.acknowledgementLabel!, /không nhận 2 suất quà/);
});

test("all slots taken: nothing to acknowledge, so no label and no explanation", () => {
  const quote = facts(3, 3);
  const model = buildBenefitCheckoutViewModel({
    lines: [cartLine],
    render: render({ facts: quote, digest: benefitQuoteDigest(quote), proof: issueBenefitQuoteProof({ quote, cartId, secret })!, needsAcknowledgement: false }),
  });

  assert.equal(model.benefit!.needsAcknowledgement, false);
  assert.equal(model.benefit!.acknowledgementLabel, null);
  assert.equal(model.benefit!.unclaimedText, null);
});

test("the digest changes whenever the quote does, even at an identical total (a paid unit swapped for a gift)", () => {
  const a = buildBenefitCheckoutViewModel({ lines: [cartLine], render: render() }).benefit!.digest;
  const swapped = facts(2, 3);
  const b = buildBenefitCheckoutViewModel({ lines: [cartLine], render: render({ facts: swapped, digest: benefitQuoteDigest(swapped) }) }).benefit!.digest;
  assert.notEqual(a, b, "the form keys the tick on this value, so a different quote always starts unticked");
});

test("EX-21: a dropped tier is stated on the page", () => {
  assert.equal(buildBenefitCheckoutViewModel({ lines: [cartLine], render: render() }).benefit!.tierNotice, null);
  assert.match(buildBenefitCheckoutViewModel({ lines: [cartLine], render: render({ tierDropped: true }) }).benefit!.tierNotice!, /không còn áp dụng/);
});

test("an unavailable benefit cart goes back to the cart with a specific reason", () => {
  for (const reason of ["BENEFITS_UNAVAILABLE", "GIFT_SELECTION_INVALID", "POS_NOT_ACCEPTED", "PROOF_UNAVAILABLE"] as const) {
    const model = buildBenefitUnavailableCheckoutViewModel({ kind: "UNAVAILABLE", reason });
    assert.equal(model.state, "unquotable");
    assert.equal(model.quoteProof, null);
    assert.ok(model.unavailableNotice && model.unavailableNotice.length > 20, reason);
  }
  assert.match(buildBenefitUnavailableCheckoutViewModel({ kind: "UNAVAILABLE", reason: "GIFT_SELECTION_INVALID" }).unavailableNotice!, /không tự đổi quà/);
});

test("feedback: a missing acknowledgement is its own message, not a price change", () => {
  const needs = checkoutSubmitFeedback({
    ok: false, status: "PRICE_CHANGED",
    priceChange: { merchandiseSubtotalVnd: 290_003, shippingFeeVnd: 30_000, totalVnd: 320_003, requires: "NONCLAIM_ACKNOWLEDGEMENT" },
  });
  assert.equal(needs.title, "Cần xác nhận quà tặng");
  assert.equal(needs.mayRetry, true);
  assert.match(needs.message, /320\.003/);

  const plain = checkoutSubmitFeedback({
    ok: false, status: "PRICE_CHANGED",
    priceChange: { merchandiseSubtotalVnd: 290_003, shippingFeeVnd: 30_000, totalVnd: 320_003 },
  });
  assert.equal(plain.title, "Giá đã thay đổi");
});

// ------------------------------------------------------------------------------------------ cart

function benefitState(overrides: Record<string, unknown> = {}): CartGiftState {
  return {
    quote: { lines: [cartLine], benefits: { enabled: true, ok: true, subtotalVnd: 290_003, groups: [
      { lineKey: "paid", quantity: 1, unitPriceVnd: 90_001, steps: [] }, { lineKey: "paid", quantity: 2, unitPriceVnd: 100_001, steps: [] },
    ], dropped: [] } },
    labels: [{ variantId: "gift", productId: "gift-product", productName: "Khăn", optionLabel: "Trắng / M" }],
    campaigns: [{ id: "campaign", allowDuplicateGifts: false, options: [{ variantId: "gift", productId: "gift-product", composite: false, readyAvailable: 1 }] }],
    entitlements: [{ campaignId: "campaign", revision: 2, earned: 2, entitled: 2, unfulfillableForStock: 0, shortfallToNext: null }],
    selections: [{ campaignId: "campaign", campaignRevision: 2, variantId: "gift", quantity: 1 }],
    validation: { ok: true, issues: [], summaries: [] },
    ...overrides,
  } as unknown as CartGiftState;
}

test("cart: a consistent benefit cart reaches checkout only where the POS shop is verified", () => {
  const closed = buildCartViewModel({ lines: [cartLine], commerceTrackingEnabled: false, giftState: benefitState() });
  assert.equal(closed.canCheckout, false);
  assert.match(closed.benefitsNotice!, /chưa thể đặt trực tuyến/);

  const open = buildCartViewModel({ lines: [cartLine], commerceTrackingEnabled: false, giftState: benefitState(), benefitCheckoutOpen: true });
  assert.equal(open.canCheckout, true);
  assert.equal(open.benefitsNotice, undefined);
});

test("cart: an invalid stored gift choice or unreadable benefits still stop at the cart, verified shop or not", () => {
  const invalid = buildCartViewModel({
    lines: [cartLine], commerceTrackingEnabled: false, benefitCheckoutOpen: true,
    giftState: benefitState({ validation: { ok: false, issues: [] } }),
  });
  assert.equal(invalid.canCheckout, false);
  assert.match(invalid.benefitsNotice!, /không còn hợp lệ/);

  const unavailable = buildCartViewModel({ lines: [cartLine], commerceTrackingEnabled: false, benefitsUnavailable: true, benefitCheckoutOpen: true });
  assert.equal(unavailable.canCheckout, false);
});

test("cart: EX-21 (tier dropped) reaches checkout, which re-quotes it, only where the shop is verified", () => {
  const paid = { ...cartLine, quantity: 1, price: 40_000 };
  const dropped = benefitState({
    quote: { lines: [paid], benefits: { enabled: true, ok: true, subtotalVnd: 40_000, groups: [{ lineKey: "paid", quantity: 1, unitPriceVnd: 40_000, steps: [] }], dropped: [{ campaignId: "tier", reason: "TIER_PRICE_INVALID", otherCampaignId: null }] } },
    campaigns: [], entitlements: [], selections: [], validation: { ok: true, issues: [], summaries: [] },
  });
  assert.equal(buildCartViewModel({ lines: [paid], commerceTrackingEnabled: false, giftState: dropped }).canCheckout, false);
  assert.equal(buildCartViewModel({ lines: [paid], commerceTrackingEnabled: false, giftState: dropped, benefitCheckoutOpen: true }).canCheckout, true);
});

test("cart: with no benefit at all the link never depends on the shop list (flag OFF parity)", () => {
  assert.equal(buildCartViewModel({ lines: [cartLine], commerceTrackingEnabled: false }).canCheckout, true);
});

// -------------------------------------------------------------------- runtime: the tick is a claim

test("the tick mints the signed acknowledgement only for the quote the server just recomputed", async () => {
  const quote = facts();
  const stale = facts(2, 3);
  const staleProof = issueBenefitQuoteProof({ quote: stale, cartId, secret })!;
  const outcomes: Record<string, unknown> = {};

  for (const [label, ticked, proof] of [
    ["ticked", true, issueBenefitQuoteProof({ quote, cartId, secret })!],
    ["not ticked", false, issueBenefitQuoteProof({ quote, cartId, secret })!],
    ["ticked on a stale quote", true, staleProof],
  ] as const) {
    const runtime = createGuestCheckoutSubmitRuntime({
      recoverStranded: async () => undefined,
      createOrderReconciliation: () => ({ reconcileCart: async () => null }),
      readConfig: () => ({ apiKey: "k", shopId: 920_007 }),
      requiresFreshSnapshot: async () => false,
      readQuoteProofSecret: () => secret,
      clock: () => NOW,
      createOrderSubmission: () => ({ submit: async () => { throw new Error("must not reach the POS"); } }),
      createCapacity: () => ({ reserveOrderCapacity: async () => { throw new Error("no hold"); }, transitionReservation: async () => true }),
      createSnapshot: (authority) => ({
        async create() {
          outcomes[label] = {
            proof: authority.benefits.verifyBenefitQuote(quote),
            ack: authority.benefits.verifyNonclaimAcknowledgement(quote),
          };
          return { ok: false as const, reason: "CART_UNAVAILABLE" as const };
        },
      }),
    });
    await runtime.submit({ cartId, checkoutInput: {}, quoteProof: proof, nonclaimAcknowledged: ticked });
  }

  const ticked = outcomes["ticked"] as { proof: { ok: boolean }; ack: { ok: boolean; acknowledgedAt?: Date } };
  assert.equal(ticked.proof.ok, true);
  assert.equal(ticked.ack.ok, true);
  assert.deepEqual(ticked.ack.acknowledgedAt, NOW, "the instant comes from the signed payload, not the browser");

  const unticked = outcomes["not ticked"] as { ack: { ok: boolean; reason?: string } };
  assert.deepEqual(unticked.ack, { ok: false, reason: "ACK_MISSING" });

  // A tick never substitutes for the proof: the stale proof is refused first (the snapshot checks the
  // proof before it asks for the acknowledgement), so the buyer is shown the refreshed quote, unticked.
  const staleTick = outcomes["ticked on a stale quote"] as { proof: { ok: boolean; reason?: string } };
  assert.deepEqual(staleTick.proof, { ok: false, reason: "PRICE_CHANGED" });
});

test("an acknowledgement minted for one quote does not verify for another", () => {
  const quote = facts();
  const other = facts(2, 3);
  // Same primitives the runtime uses: the token binds the digest of the quote it was minted for.
  const proof = issueBenefitQuoteProof({ quote, cartId, secret })!;
  assert.equal(verifyBenefitQuoteProof({ proof, cartId, currentQuote: other, secret }).ok, false);
  assert.equal(verifyNonclaimAcknowledgement({ token: undefined, cartId, currentQuote: quote, secret, now: NOW }).ok, false);
});

// --------------------------------------------------- cart and checkout agree on what a tier benefit is

/** 1 unit at 1.000.000đ; a 10% tier runs first (-> 900.000đ), then a legacy ceiling of 900.000đ changes nothing. */
function tierThenCeilingState(): CartGiftState {
  const step = (source: "QUANTITY_TIER" | "LEGACY", input: number, output: number) => ({ campaignId: source, source, kind: source, priority: 1, inputPriceVnd: input, outputPriceVnd: output, appliedQuantity: 1 });
  const paid = { ...cartLine, quantity: 1, price: 900_000 };
  return {
    quote: { lines: [paid], benefits: { enabled: true, ok: true, subtotalVnd: 900_000, dropped: [], groups: [
      { lineKey: "paid", quantity: 1, unitPriceVnd: 900_000, steps: [step("QUANTITY_TIER", 1_000_000, 900_000), step("LEGACY", 900_000, 900_000)] },
    ] } },
    labels: [], campaigns: [], entitlements: [], selections: [], validation: { ok: true, issues: [], summaries: [] },
  } as unknown as CartGiftState;
}

test("cart: a tier that lands on the legacy total is still a benefit cart, so an unverified shop gets no link", () => {
  const state = tierThenCeilingState();
  const paid = state.quote.lines[0]!;
  assert.equal(
    (state.quote.benefits as { subtotalVnd: number }).subtotalVnd,
    paid.price! * paid.quantity,
    "the money alone cannot tell: this is the reviewer's same-total stack",
  );

  const closed = buildCartViewModel({ lines: [paid], commerceTrackingEnabled: false, giftState: state });
  assert.equal(closed.canCheckout, false);
  assert.match(closed.benefitsNotice!, /chưa thể đặt trực tuyến/);

  const open = buildCartViewModel({ lines: [paid], commerceTrackingEnabled: false, giftState: state, benefitCheckoutOpen: true });
  assert.equal(open.canCheckout, true);
});

test("cart: a legacy-only step at the same total is not a benefit, so the link stays (flag ON parity)", () => {
  const state = tierThenCeilingState();
  const groups = (state.quote.benefits as unknown as { groups: { steps: { source: string }[] }[] }).groups;
  groups[0]!.steps = groups[0]!.steps.filter((step) => step.source === "LEGACY");
  const paid = state.quote.lines[0]!;
  assert.equal(buildCartViewModel({ lines: [paid], commerceTrackingEnabled: false, giftState: state }).canCheckout, true);
});


test("gift repair retains removals without issuing proof or a submit-capable quote", () => {
  const giftPicker = { campaigns: [], selections: [{ campaignId: "gone", variantId: "gift", campaignRevision: 1, quantity: 1, label: "Quà cũ", imageUrl: null }], invalid: true, stackConflict: false };
  const model = buildBenefitUnavailableCheckoutViewModel({ kind: "UNAVAILABLE", reason: "GIFT_SELECTION_INVALID", giftPicker }, [cartLine]);
  assert.equal(model.lines[0]!.quantity, 3);
  assert.equal(model.lines[0]!.lineTotalText, "Chờ tính lại");
  assert.equal(model.lines[0]!.unitPriceText, null);
  assert.equal(model.giftPicker, giftPicker);
  assert.equal(model.quoteProof, null);
  assert.equal(model.totals, null);
  assert.match(model.unavailableNotice!, /bỏ.*tại đây/i);
});

test("a gift line in the order carries the gift product's own photo, or none when it has no trusted one", () => {
  const withPhoto = buildBenefitCheckoutViewModel({ lines: [cartLine], render: render({ giftImages: new Map([["var-g", "https://cdn.example/khan.jpg"]]) }) });
  assert.equal(withPhoto.benefit!.giftLines[0]!.imageUrl, "https://cdn.example/khan.jpg");
  const without = buildBenefitCheckoutViewModel({ lines: [cartLine], render: render() });
  assert.equal(without.benefit!.giftLines[0]!.imageUrl, null);
});
