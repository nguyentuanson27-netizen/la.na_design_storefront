import assert from "node:assert/strict";
import test from "node:test";

import { summarizeBenefitQuote } from "../../src/commerce/benefit-quote-summary.ts";
import { buildBenefitCheckoutQuoteFacts } from "../../src/commerce/checkout-quote.ts";
import {
  createGuestCheckoutSubmitService,
  type GuestCheckoutSubmitDependencies,
} from "../../src/commerce/guest-checkout-submit.ts";
import {
  BENEFIT_CHECKOUT_OUTCOMES,
  MAX_SIGNAL_UTF8_BYTES,
  describeBenefitCheckoutOutcome,
  describeBenefitQuoteSummary,
  emitPromotionSignal,
  serializePromotionSignal,
} from "../../src/operations/promotion-observability.ts";

type Created = Awaited<ReturnType<GuestCheckoutSubmitDependencies["snapshot"]["create"]>>;

const CART_UUID = "7f9c24e0-3d3e-4a53-9a83-aaaaaaaaaaaa";
const refreshedBenefitQuote = buildBenefitCheckoutQuoteFacts({
  paid: [{ groupKey: "g", pancakeVariationId: "v1", quantity: 1, unitPriceVnd: 100_001, steps: [], fulfillmentState: "READY" }],
  gifts: [],
  entitlements: [],
})!;

async function submitWith(created: Created) {
  const seen: Array<[string, string | undefined]> = [];
  const service = createGuestCheckoutSubmitService({
    snapshot: { create: async () => created },
    orderSubmission: { submit: async () => { throw new Error("must not reach the POS"); } },
    generatePublicCode: () => "LA-TEST-1",
    onBenefitOutcome: (outcome, proofReason) => { seen.push([outcome, proofReason]); },
  });
  const result = await service.submit({ cartId: CART_UUID, shopId: 1, checkoutInput: {}, now: new Date() });
  return { result, seen };
}

test("GQ24: every benefit checkout stop is observed with its closed outcome and nothing else", async () => {
  const cases: ReadonlyArray<readonly [Created, string, string | undefined]> = [
    [{ ok: false, reason: "BENEFIT_QUOTE_UNPROVEN", quoteReason: "PROOF_MALFORMED", refreshedBenefitQuote } as Created, "QUOTE_STALE", "PROOF_MALFORMED"],
    [{ ok: false, reason: "NONCLAIM_UNACKNOWLEDGED", acknowledgementReason: "ACK_MISSING", refreshedBenefitQuote } as unknown as Created, "NONCLAIM_UNACKNOWLEDGED", undefined],
    [{ ok: false, reason: "GIFT_SELECTION_INVALID" }, "GIFT_SELECTION_INVALID", undefined],
    [{ ok: false, reason: "BENEFIT_CHECKOUT_UNAVAILABLE" }, "CHECKOUT_UNAVAILABLE", undefined],
    [{ ok: false, reason: "VENDOR_PROJECTION_INFEASIBLE" }, "VENDOR_PROJECTION_INFEASIBLE", undefined],
  ];
  for (const [created, outcome, proofReason] of cases) {
    const { result, seen } = await submitWith(created);
    assert.equal(result.ok, false, outcome);
    assert.deepEqual(seen, [[outcome, proofReason]], outcome);
    assert.ok((BENEFIT_CHECKOUT_OUTCOMES as readonly string[]).includes(outcome));
  }
});

test("GQ24: legacy snapshot failures are not counted as benefit outcomes", async () => {
  const { seen } = await submitWith({ ok: false, reason: "CART_EMPTY" });
  assert.deepEqual(seen, []);
});

test("GQ24: an observer that throws never changes what the buyer is told", async () => {
  const service = createGuestCheckoutSubmitService({
    snapshot: { create: async () => ({ ok: false, reason: "GIFT_SELECTION_INVALID" }) },
    orderSubmission: { submit: async () => { throw new Error("must not reach the POS"); } },
    generatePublicCode: () => "LA-TEST-1",
    onBenefitOutcome: () => { throw new Error("log sink down"); },
  });
  const result = await service.submit({ cartId: CART_UUID, shopId: 1, checkoutInput: {}, now: new Date() });
  assert.deepEqual(result, { ok: false, status: "RETRYABLE", reason: "CART_CHANGED" });
});

test("GQ24: signals are single short NDJSON lines with no cart id, token, money or campaign identifier", () => {
  const lines: string[] = [];
  const write = (line: string) => { lines.push(line); };
  emitPromotionSignal(describeBenefitCheckoutOutcome({ outcome: "QUOTE_STALE", proofReason: "PROOF_MALFORMED" }), write);
  emitPromotionSignal(describeBenefitQuoteSummary({
    paidLines: 2, giftLines: 1, stackConflicts: 1, tierPriceInvalid: 1, tierConfigInvalid: 0,
    entitledSlots: 2, selectedSlots: 1, unclaimedSlots: 1, stockShortSlots: 0,
  }), write);
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.ok(line.endsWith("\n") && line.indexOf("\n") === line.length - 1);
    assert.ok(Buffer.byteLength(line, "utf8") < MAX_SIGNAL_UTF8_BYTES);
    assert.doesNotMatch(line, new RegExp(CART_UUID));
    assert.doesNotMatch(line, /laq[123]|laa1|secret|token|phone|address/i);
  }
  assert.deepEqual(JSON.parse(lines[0]!), { name: "benefit.checkout_outcome", outcome: "QUOTE_STALE", proofReason: "PROOF_MALFORMED" });
});

test("GQ24: the summary signal clamps malformed counts instead of widening a log line", () => {
  const signal = describeBenefitQuoteSummary({
    paidLines: -1, giftLines: Number.NaN, stackConflicts: 1e12, tierPriceInvalid: 1.5, tierConfigInvalid: 0,
    entitledSlots: 0, selectedSlots: 0, unclaimedSlots: 0, stockShortSlots: 0,
  });
  assert.deepEqual([signal.paidLines, signal.giftLines, signal.stackConflicts, signal.tierPriceInvalid], [0, 0, 100_000, 0]);
  assert.ok(Buffer.byteLength(serializePromotionSignal(signal), "utf8") < MAX_SIGNAL_UTF8_BYTES);
});

test("GQ24: the quote summary separates conflicts, an invalid tier price, unclaimed slots and stock shortfall", () => {
  const facts = buildBenefitCheckoutQuoteFacts({
    paid: [{ groupKey: "g", pancakeVariationId: "v1", quantity: 3, unitPriceVnd: 100_001, steps: [], fulfillmentState: "READY" }],
    gifts: [{ campaignId: "gift", campaignRevision: 4, pancakeVariationId: "v2", quantity: 1 }],
    entitlements: [{ campaignId: "gift", campaignRevision: 4, entitled: 3, selected: 1, skippedWhileAvailable: 0, contendedForSharedStock: 1, shortForStock: 1 }],
  })!;
  const resolution = {
    kind: "BENEFIT", facts, paid: [], gifts: [],
    dropped: [
      { campaignId: "a", reason: "STACK_NOT_PERMITTED", otherCampaignId: "b" },
      { campaignId: "c", reason: "STACK_PRIORITY_CONFLICT", otherCampaignId: "d" },
      { campaignId: "e", reason: "TIER_PRICE_INVALID", otherCampaignId: null },
      { campaignId: "f", reason: "TIER_CONFIG_INVALID", otherCampaignId: null },
    ],
  } as unknown as Parameters<typeof summarizeBenefitQuote>[0];
  assert.deepEqual(summarizeBenefitQuote(resolution), {
    paidLines: 1, giftLines: 1, stackConflicts: 2, tierPriceInvalid: 1, tierConfigInvalid: 1,
    entitledSlots: 3, selectedSlots: 1, unclaimedSlots: 2, stockShortSlots: 2,
  });
});
