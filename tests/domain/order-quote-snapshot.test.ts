import assert from "node:assert/strict";
import test from "node:test";
import { benefitQuoteDigest } from "../../src/commerce/checkout-quote-proof.ts";
import { validateQuoteStructure } from "../../src/commerce/order-quote-rules.ts";

import {
  validateOrderQuoteSnapshot,
  type OrderQuoteLineInput,
  type OrderQuoteSnapshotInput,
} from "../../src/commerce/order-quote-snapshot.ts";

const DIGEST = "a".repeat(64);
const ACK = new Date("2026-10-14T10:00:00.000Z");

function paid(lineId: string, quantity: number, unitPriceVnd: number, extra: Partial<OrderQuoteLineInput> = {}): OrderQuoteLineInput {
  return {
    lineId, role: "PAID", variantId: "variant-1", pancakeVariationId: "var-1", quantity, unitPriceVnd,
    lineTotalVnd: quantity * unitPriceVnd, baseUnitPriceVnd: null, fulfillmentState: "READY", campaign: null, discountSteps: [], ...extra,
  };
}

function gift(lineId: string, quantity: number, campaignId = "camp-1", extra: Partial<OrderQuoteLineInput> = {}): OrderQuoteLineInput {
  return {
    lineId, role: "GIFT", variantId: "variant-g", pancakeVariationId: "var-g", quantity, unitPriceVnd: 0, lineTotalVnd: 0,
    baseUnitPriceVnd: null, fulfillmentState: "READY", campaign: { id: campaignId, revision: 3 }, discountSteps: [], ...extra,
  };
}

/** EX-17: 2 x 100.001d + 1 x 90.001d of one variation, 290.003d, free shipping or not is the caller's business. */
function ex17(overrides: Partial<OrderQuoteSnapshotInput> = {}): OrderQuoteSnapshotInput {
  const input: OrderQuoteSnapshotInput = {
    quoteFormat: "laq3", quoteDigest: DIGEST, paidSubtotalVnd: 290_003, shippingFeeVnd: 30_000, totalVnd: 320_003,
    lines: [paid("P:var-1:0", 2, 100_001), paid("P:var-1:1", 1, 90_001, { baseUnitPriceVnd: 100_001, discountSteps: [{ campaignId: "tier-1", source: "QUANTITY_TIER", campaignKind: "QUANTITY_TIER", priority: 1, inputPriceVnd: 100_001, outputPriceVnd: 90_001, appliedQuantity: 1 }] })],
    entitlements: [], acknowledgedAt: null, ...overrides,
  };
  return { ...input, quoteDigest: overrides.quoteDigest ?? (validateQuoteStructure(input).ok ? benefitQuoteDigest(input) : DIGEST) };
}

function issueOf(input: OrderQuoteSnapshotInput) {
  const verdict = validateOrderQuoteSnapshot(input);
  return verdict.ok ? null : verdict.issue;
}

test("EX-17: two PAID segments of one variation at different prices are valid and keep their totals", () => {
  const verdict = validateOrderQuoteSnapshot(ex17());
  assert.deepEqual(verdict, { ok: true, totals: { paidQuantity: 3, giftQuantity: 0, unclaimedSlots: 0 } });
});

test("a PAID + GIFT pair of one variation is valid; the gift needs an entitlement of its campaign that matches", () => {
  const input = ex17({
    paidSubtotalVnd: 100_000, shippingFeeVnd: 0, totalVnd: 100_000,
    lines: [paid("P:var-1:0", 1, 100_000), gift("G:camp-1:var-1", 1, "camp-1", { pancakeVariationId: "var-1", variantId: "variant-1" })],
    entitlements: [{ campaignId: "camp-1", campaignRevision: 3, entitled: 1, selected: 1, skippedWhileAvailable: 0, contendedForSharedStock: 0, shortForStock: 0 }],
  });
  assert.deepEqual(validateOrderQuoteSnapshot(input), { ok: true, totals: { paidQuantity: 1, giftQuantity: 1, unclaimedSlots: 0 } });
  // No entitlement row for a campaign that has a gift line.
  assert.equal(issueOf({ ...input, entitlements: [] }), "ENTITLEMENT_MISMATCH");
  // Selected must equal the gift lines of the campaign.
  assert.equal(issueOf({ ...input, entitlements: [{ campaignId: "camp-1", campaignRevision: 3, entitled: 2, selected: 2, skippedWhileAvailable: 0, contendedForSharedStock: 0, shortForStock: 0 }] }), "ENTITLEMENT_MISMATCH");
  // The revision on the line and on the entitlement must agree.
  assert.equal(issueOf({ ...input, entitlements: [{ campaignId: "camp-1", campaignRevision: 4, entitled: 1, selected: 1, skippedWhileAvailable: 0, contendedForSharedStock: 0, shortForStock: 0 }] }), "ENTITLEMENT_MISMATCH");
});

test("EX-18: slots not taken are kept per campaign and need an acknowledgement", () => {
  const base = ex17({
    paidSubtotalVnd: 100_000, shippingFeeVnd: 0, totalVnd: 100_000,
    lines: [paid("P:var-1:0", 1, 100_000), gift("G:camp-1:var-g", 1)],
    entitlements: [{ campaignId: "camp-1", campaignRevision: 3, entitled: 3, selected: 1, skippedWhileAvailable: 1, contendedForSharedStock: 0, shortForStock: 1 }],
  });
  assert.equal(issueOf(base), "ACKNOWLEDGEMENT_REQUIRED");
  assert.deepEqual(validateOrderQuoteSnapshot({ ...base, acknowledgedAt: ACK }), { ok: true, totals: { paidQuantity: 1, giftQuantity: 1, unclaimedSlots: 2 } });
  // An acknowledgement of nothing is refused rather than stored as consent to something that did not exist.
  const full = { ...base, entitlements: [{ campaignId: "camp-1", campaignRevision: 3, entitled: 1, selected: 1, skippedWhileAvailable: 0, contendedForSharedStock: 0, shortForStock: 0 }], acknowledgedAt: ACK };
  assert.equal(issueOf(full), "ACKNOWLEDGEMENT_UNNEEDED");
  // The reasons must account for every unclaimed slot, or the row would hide one.
  assert.equal(issueOf({ ...base, acknowledgedAt: ACK, entitlements: [{ ...base.entitlements[0]!, shortForStock: 0 }] }), "ENTITLEMENT_INVALID");
  // Selecting nothing at all is a valid quote with every slot unclaimed.
  assert.deepEqual(
    validateOrderQuoteSnapshot(ex17({ ...base, quoteDigest: undefined, lines: [paid("P:var-1:0", 1, 100_000)], acknowledgedAt: ACK, entitlements: [{ campaignId: "camp-1", campaignRevision: 3, entitled: 2, selected: 0, skippedWhileAvailable: 2, contendedForSharedStock: 0, shortForStock: 0 }] })),
    { ok: true, totals: { paidQuantity: 1, giftQuantity: 0, unclaimedSlots: 2 } },
  );
});

test("money must be whole, bounded and consistent: line totals, the paid subtotal and the order total", () => {
  assert.equal(issueOf(ex17({ paidSubtotalVnd: 290_002, totalVnd: 320_002 })), "PAID_SUBTOTAL_MISMATCH");
  assert.equal(issueOf(ex17({ paidSubtotalVnd: 290_002 })), "TOTAL_MISMATCH");
  assert.equal(issueOf(ex17({ totalVnd: 320_004 })), "TOTAL_MISMATCH");
  assert.equal(issueOf(ex17({ shippingFeeVnd: -1 })), "MONEY_INVALID");
  assert.equal(issueOf(ex17({ paidSubtotalVnd: 290_003.5 })), "MONEY_INVALID");
  assert.equal(issueOf(ex17({ lines: [paid("P:a", 2, 100_001, { lineTotalVnd: 200_003 })] })), "LINE_TOTAL_MISMATCH");
  assert.equal(issueOf(ex17({ lines: [paid("P:a", 1, Number.MAX_SAFE_INTEGER)], paidSubtotalVnd: Number.MAX_SAFE_INTEGER, totalVnd: Number.MAX_SAFE_INTEGER + 30_000 })), "MONEY_INVALID");
  // A paid line cannot be free, a gift cannot cost anything, and a free gift is never PREORDER.
  assert.equal(issueOf(ex17({ lines: [paid("P:a", 1, 0)], paidSubtotalVnd: 0, totalVnd: 30_000 })), "MONEY_INVALID");
  assert.equal(issueOf(ex17({ lines: [paid("P:a", 1, 290_003), paid("P:b", 1, 0)] })), "PAID_LINE_INVALID");
  const withGift = (extra: Partial<OrderQuoteLineInput>) => ex17({ lines: [paid("P:a", 1, 290_003), gift("G:a", 1, "camp-1", extra)], entitlements: [{ campaignId: "camp-1", campaignRevision: 3, entitled: 1, selected: 1, skippedWhileAvailable: 0, contendedForSharedStock: 0, shortForStock: 0 }] });
  assert.equal(issueOf(withGift({ unitPriceVnd: 1, lineTotalVnd: 1 })), "GIFT_LINE_INVALID");
  assert.equal(issueOf(withGift({ fulfillmentState: "PREORDER" })), "GIFT_LINE_INVALID");
  assert.equal(issueOf(withGift({ campaign: null })), "GIFT_LINE_INVALID");
  assert.equal(issueOf(withGift({ quantity: 101, lineTotalVnd: 0 })), "GIFT_LINE_INVALID");
  assert.equal(issueOf(withGift({ baseUnitPriceVnd: 5 })), "GIFT_LINE_INVALID");
});

test("line identity: lineId is required, well-formed and unique; variation is not a key", () => {
  assert.equal(issueOf(ex17({ lines: [paid("P:var-1:0", 1, 290_003), paid("P:var-1:0", 1, 1)] })), "LINE_ID_DUPLICATE");
  for (const lineId of ["", "has space", "x".repeat(201), "semi;colon", "ünï"]) {
    assert.equal(issueOf(ex17({ lines: [paid(lineId, 1, 290_003)] })), "LINE_ID_INVALID", lineId);
  }
  // Same variation twice with different lineIds is exactly EX-17.
  assert.equal(issueOf(ex17()), null);
  assert.equal(issueOf(ex17({ lines: [] })), "LINES_OUT_OF_BOUNDS");
  assert.equal(issueOf(ex17({ lines: Array.from({ length: 201 }, (_, index) => paid(`P:${index}`, 1, 1)) })), "LINES_OUT_OF_BOUNDS");
  assert.equal(issueOf(ex17({ lines: [gift("G:a", 1)], paidSubtotalVnd: 1, totalVnd: 30_001 })), "NO_PAID_LINES");
});

test("the discount ledger must walk from the base price to the price paid, in order", () => {
  const step = (input: number, output: number, extra = {}) => ({ campaignId: "c", source: "LEGACY" as const, campaignKind: "FLASH_SALE", priority: null, inputPriceVnd: input, outputPriceVnd: output, appliedQuantity: 1, ...extra });
  const line = (steps: ReturnType<typeof step>[], unit: number, base: number | null) => ex17({ lines: [paid("P:a", 1, unit, { baseUnitPriceVnd: base, discountSteps: steps })], paidSubtotalVnd: unit, shippingFeeVnd: 0, totalVnd: unit });
  assert.equal(issueOf(line([step(100_000, 90_000), step(90_000, 85_500, { source: "QUANTITY_TIER", campaignKind: "QUANTITY_TIER", priority: 2 })], 85_500, 100_000)), null);
  assert.equal(issueOf(line([step(100_000, 90_000)], 89_999, 100_000)), "DISCOUNT_CHAIN_INVALID"); // last output is not the price paid
  assert.equal(issueOf(line([step(99_999, 90_000)], 90_000, 100_000)), "DISCOUNT_CHAIN_INVALID"); // first input is not the base
  assert.equal(issueOf(line([step(100_000, 90_000), step(95_000, 85_000)], 85_000, 100_000)), "DISCOUNT_CHAIN_INVALID"); // broken link
  assert.equal(issueOf(line([step(100_000, 110_000)], 110_000, 100_000)), "PAID_LINE_INVALID"); // a base below the price paid is not a discount
  assert.equal(issueOf(line([step(100_000, 90_000), step(90_000, 95_000)], 95_000, 100_000)), "DISCOUNT_CHAIN_INVALID"); // a step cannot raise the price
  assert.equal(issueOf(line([step(100_000, 0)], 1, 100_000)), "DISCOUNT_CHAIN_INVALID"); // no step may reach 0d
  assert.equal(issueOf(line([step(100_000, 90_000, { source: "OTHER" })], 90_000, 100_000)), "DISCOUNT_CHAIN_INVALID");
  assert.equal(issueOf(line([], 90_000, 100_000)), "DISCOUNT_CHAIN_INVALID"); // a base above the price with no step to explain it
  assert.equal(issueOf(line(Array.from({ length: 9 }, () => step(100_000, 100_000)), 100_000, 100_000)), "LINE_FIELDS_INVALID"); // bounded ledger
});

test("format and digest are validated and the input is never trusted structurally", () => {
  assert.equal(issueOf(ex17({ quoteFormat: "laq" })), "FORMAT_INVALID");
  assert.equal(issueOf(ex17({ quoteFormat: "LAQ3" })), "FORMAT_INVALID");
  assert.equal(issueOf(ex17({ quoteDigest: "A".repeat(64) })), "DIGEST_INVALID");
  assert.equal(issueOf(ex17({ quoteDigest: "a".repeat(63) })), "DIGEST_INVALID");
  assert.equal(issueOf(null as unknown as OrderQuoteSnapshotInput), "MONEY_INVALID");
  assert.equal(issueOf(ex17({ entitlements: Array.from({ length: 21 }, (_, index) => ({ campaignId: `c${index}`, campaignRevision: 1, entitled: 0, selected: 0, skippedWhileAvailable: 0, contendedForSharedStock: 0, shortForStock: 0 })) })), "ENTITLEMENT_INVALID");
  assert.equal(issueOf(ex17({ lines: [paid("P:a", 1, 290_003, { fulfillmentState: "LATER" as never })] })), "LINE_FIELDS_INVALID");
});

test("a valid laq3 digest cannot be persisted under another well-formed format version", () => {
  const quote = ex17();
  assert.equal(quote.quoteDigest, benefitQuoteDigest(quote));
  for (const quoteFormat of ["laq2", "laq4", "laq999"]) {
    assert.equal(issueOf({ ...quote, quoteFormat }), "FORMAT_INVALID");
  }
  assert.equal(issueOf(quote), null);
});

test("the digest must describe the stored facts even when changed segments keep the same total", () => {
  const original = ex17();
  const changed = ex17({ lines: [paid("P:var-1:0", 1, 100_001), paid("P:var-1:1", 1, 190_002)] });
  assert.equal(original.totalVnd, changed.totalVnd);
  assert.notEqual(original.quoteDigest, changed.quoteDigest);
  assert.equal(issueOf({ ...changed, quoteDigest: original.quoteDigest }), "DIGEST_MISMATCH");
  assert.equal(issueOf(changed), null);
  assert.equal(issueOf(ex17({ quoteDigest: DIGEST })), "DIGEST_MISMATCH");
});

test("snapshot validation shares the proof's aggregate quantity and priority INTEGER bounds", () => {
  const max = 2_147_483_647;
  const boundary = ex17({ lines: [paid("P:a", max, 1)], paidSubtotalVnd: max, shippingFeeVnd: 0, totalVnd: max });
  assert.equal(issueOf(boundary), null);
  assert.equal(issueOf(ex17({ ...boundary, lines: [...boundary.lines, paid("P:b", 1, 1)], paidSubtotalVnd: max + 1, totalVnd: max + 1 })), "MONEY_INVALID");
  for (const priority of [-2_147_483_649, max + 1]) {
    const quote = ex17();
    assert.equal(issueOf({ ...quote, lines: quote.lines.map(line => ({ ...line, discountSteps: line.discountSteps.map(step => ({ ...step, priority })) })) }), "DISCOUNT_CHAIN_INVALID");
  }
});
