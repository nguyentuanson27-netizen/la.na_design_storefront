import assert from "node:assert/strict";
import test from "node:test";

import {
  benefitQuoteDigest,
  benefitQuoteNeedsNonclaimAcknowledgement,
  issueBenefitQuoteProof,
  issueNonclaimAcknowledgement,
  issueRenderedQuoteProof,
  MAX_BENEFIT_QUOTE_PROOF_BYTES,
  MAX_NONCLAIM_ACK_AGE_SECONDS,
  verifyBenefitQuoteProof,
  verifyNonclaimAcknowledgement,
  verifyRenderedQuoteProof,
  type BenefitQuoteProofFacts,
} from "../../src/commerce/checkout-quote-proof.ts";
import {
  buildBenefitCheckoutQuoteFacts,
  type BenefitQuoteGift,
  type BenefitQuotePaidGroup,
} from "../../src/commerce/checkout-quote.ts";
import { GUEST_SHIPPING_FEE_VND } from "../../src/commerce/guest-shipping-policy.ts";

const secret = "test-server-secret-at-least-32-characters-long";
const otherSecret = "another-server-secret-at-least-32-characters-long";
const cartId = "0f8d3c2a-4b1e-4d7a-9c6b-2e5f1a8d4c30";
const otherCartId = "9a1b7c6d-3e2f-4a5b-8c9d-1e2f3a4b5c6d";
const NOW = new Date("2026-10-14T10:00:00.000Z");

const tierStep = { campaignId: "tier-1", source: "QUANTITY_TIER" as const, campaignKind: "QUANTITY_TIER", priority: 1, inputPriceVnd: 100_001, outputPriceVnd: 90_001, appliedQuantity: 1 };
const paidGroup = (overrides: Partial<BenefitQuotePaidGroup> = {}): BenefitQuotePaidGroup => ({
  groupKey: "internal-cuid-1", pancakeVariationId: "var-1", quantity: 2, unitPriceVnd: 100_001, steps: [], fulfillmentState: "READY", ...overrides,
});
const full = paidGroup({ groupKey: "cuid-a|full", quantity: 2, unitPriceVnd: 100_001 });
const disc = paidGroup({ groupKey: "cuid-a|disc", quantity: 1, unitPriceVnd: 90_001, steps: [tierStep] });
const gift = (overrides: Partial<BenefitQuoteGift> = {}): BenefitQuoteGift => ({ campaignId: "camp-1", campaignRevision: 3, pancakeVariationId: "var-g", quantity: 1, ...overrides });
const slots = (entitled: number, selected: number, skipped = entitled - selected) => ({
  campaignId: "camp-1", campaignRevision: 3, entitled, selected, skippedWhileAvailable: skipped, contendedForSharedStock: 0, shortForStock: 0,
});

function build(input: { paid?: BenefitQuotePaidGroup[]; gifts?: BenefitQuoteGift[]; entitlements?: ReturnType<typeof slots>[] } = {}): BenefitQuoteProofFacts {
  const facts = buildBenefitCheckoutQuoteFacts({ paid: input.paid ?? [full, disc], gifts: input.gifts ?? [], entitlements: input.entitlements ?? [] });
  assert.ok(facts, "expected these inputs to produce a quote");
  return facts;
}

/** EX-17 plus a gift: 2 x 100.001d + 1 x 90.001d of one variation, one of two earned gift slots taken. */
const withGift = () => build({ gifts: [gift()], entitlements: [slots(2, 1)] });

function proof(quote: BenefitQuoteProofFacts = build(), overrides: { cartId?: string; secret?: string } = {}) {
  const token = issueBenefitQuoteProof({ quote, cartId: overrides.cartId ?? cartId, secret: overrides.secret ?? secret });
  assert.ok(token);
  return token;
}

const verify = (token: unknown, currentQuote: BenefitQuoteProofFacts, overrides: { cartId?: string; secret?: string } = {}) =>
  verifyBenefitQuoteProof({ proof: token, cartId: overrides.cartId ?? cartId, currentQuote, secret: overrides.secret ?? secret });

test("quotes cannot sign quantities or priorities outside the snapshot INTEGER range", () => {
  const max = 2_147_483_647;
  const boundary = build({ paid: [paidGroup({ quantity: max, unitPriceVnd: 1 })] });
  assert.ok(proof(boundary));
  const overflow: BenefitQuoteProofFacts = {
    ...boundary, paidSubtotalVnd: max + 1, totalVnd: max + 1,
    lines: [...boundary.lines, { ...boundary.lines[0]!, lineId: "P:extra", quantity: 1, lineTotalVnd: 1 }],
  };
  assert.throws(() => proof(overflow), TypeError);
  assert.deepEqual(verify(proof(boundary), overflow), { ok: false, reason: "PRICE_CHANGED" });
  for (const priority of [-2_147_483_648, max]) {
    assert.ok(proof(build({ paid: [paidGroup({ quantity: 1, unitPriceVnd: 90_001, steps: [{ ...tierStep, priority }] })] })));
  }
  for (const priority of [-2_147_483_649, max + 1]) {
    const quote = build();
    const invalid = { ...quote, lines: quote.lines.map(line => ({ ...line, discountSteps: line.discountSteps.map(step => ({ ...step, priority })) })) };
    assert.throws(() => proof(invalid), TypeError);
    assert.deepEqual(verify(proof(quote), invalid), { ok: false, reason: "PRICE_CHANGED" });
  }
});

test("malformed or omitted gift campaigns fail closed in both verifiers", () => {
  const quote = withGift();
  const rendered = proof(quote);
  const token = issueNonclaimAcknowledgement({ quote, cartId, secret, now: NOW })!;
  const campaignCases: unknown[] = [undefined, null, 1, "camp-1", [], {}, { id: "camp-1" }, { id: 1, revision: 3 }, { id: "camp-1", revision: "3" }];
  const giftLine = quote.lines.find(line => line.role === "GIFT")!;
  const omitted: Record<string, unknown> = { ...giftLine };
  delete omitted.campaign;
  const invalidLines = [omitted, ...campaignCases.map(campaign => ({ ...giftLine, campaign }))];
  for (const invalidLine of invalidLines) {
    const invalid = { ...quote, lines: quote.lines.map(line => line.role === "GIFT" ? invalidLine : line) } as BenefitQuoteProofFacts;
    assert.deepEqual(verify(rendered, invalid), { ok: false, reason: "PRICE_CHANGED" });
    assert.deepEqual(verifyNonclaimAcknowledgement({ token, cartId, currentQuote: invalid, secret, now: NOW }), { ok: false, reason: "ACK_STALE" });
    assert.throws(() => proof(invalid), TypeError);
  }
});

// -- The quote builder ----------------------------------------------------------------------------------

test("EX-17: two PAID segments of one variation get distinct lineIds, highest price first, and keep their money", () => {
  const quote = build();
  assert.deepEqual(quote.lines.map((line) => [line.lineId, line.role, line.quantity, line.unitPriceVnd, line.lineTotalVnd]), [
    ["P:var-1:0", "PAID", 2, 100_001, 200_002],
    ["P:var-1:1", "PAID", 1, 90_001, 90_001],
  ]);
  assert.equal(quote.paidSubtotalVnd, 290_003);
  assert.equal(quote.totalVnd, 290_003 + quote.shippingFeeVnd);
  assert.deepEqual(quote.lines[1]!.discountSteps, [tierStep]);
});

test("lineIds are stable for equal facts whatever order they arrive in, and carry no internal id", () => {
  const forward = build({ paid: [full, disc, paidGroup({ groupKey: "cuid-z", pancakeVariationId: "var-2", quantity: 1, unitPriceVnd: 50_000 })] });
  const reversed = build({ paid: [paidGroup({ groupKey: "cuid-z", pancakeVariationId: "var-2", quantity: 1, unitPriceVnd: 50_000 }), disc, full] });
  assert.deepEqual(forward.lines.map((line) => line.lineId), reversed.lines.map((line) => line.lineId));
  assert.deepEqual(forward, reversed);
  const text = JSON.stringify(forward);
  for (const internal of ["cuid-a", "cuid-z", "internal-cuid"]) assert.equal(text.includes(internal), false, internal);
});

test("a gift is its own 0d READY line even when its variation is also bought, and never moves shipping", () => {
  const paidOnly = build({ paid: [paidGroup({ quantity: 2, unitPriceVnd: 100_000 })] });
  assert.equal(paidOnly.shippingFeeVnd, GUEST_SHIPPING_FEE_VND);
  const withGifts = build({
    paid: [paidGroup({ quantity: 2, unitPriceVnd: 100_000 })],
    gifts: [gift({ pancakeVariationId: "var-1", quantity: 5 })],
    entitlements: [slots(5, 5)],
  });
  const giftLine = withGifts.lines.find((line) => line.role === "GIFT")!;
  assert.deepEqual([giftLine.lineId, giftLine.pancakeVariationId, giftLine.unitPriceVnd, giftLine.lineTotalVnd, giftLine.fulfillmentState, giftLine.campaign], ["G:camp-1:var-1", "var-1", 0, 0, "READY", { id: "camp-1", revision: 3 }]);
  // Free units never manufacture a shipping campaign.
  assert.equal(withGifts.shippingFeeVnd, GUEST_SHIPPING_FEE_VND);
  assert.equal(withGifts.paidSubtotalVnd, paidOnly.paidSubtotalVnd);
  assert.equal(withGifts.totalVnd, paidOnly.totalVnd);
  // The paid and the gift line of one variation have different lineIds.
  assert.deepEqual(withGifts.lines.map((line) => line.lineId).sort(), ["G:camp-1:var-1", "P:var-1:0"]);
});

test("entitlements that earned and gave nothing are left out; unclaimed slots are carried", () => {
  const quote = build({ gifts: [gift()], entitlements: [slots(3, 1), { ...slots(0, 0), campaignId: "camp-idle" }] });
  assert.deepEqual(quote.entitlements.map((entry) => entry.campaignId), ["camp-1"]);
  assert.equal(benefitQuoteNeedsNonclaimAcknowledgement(quote), true);
  assert.equal(benefitQuoteNeedsNonclaimAcknowledgement(build({ gifts: [gift()], entitlements: [slots(1, 1)] })), false);
});

test("a quote that cannot be consistent is refused rather than repaired", () => {
  const refused = (input: Parameters<typeof buildBenefitCheckoutQuoteFacts>[0]) => assert.equal(buildBenefitCheckoutQuoteFacts(input), null);
  refused({ paid: [], gifts: [], entitlements: [] });
  refused({ paid: [paidGroup({ unitPriceVnd: 0 })], gifts: [], entitlements: [] }); // a paid unit is never free
  refused({ paid: [paidGroup({ quantity: 0 })], gifts: [], entitlements: [] });
  refused({ paid: [paidGroup({ unitPriceVnd: 1.5 })], gifts: [], entitlements: [] });
  refused({ paid: [paidGroup({ unitPriceVnd: Number.MAX_SAFE_INTEGER, quantity: 2 })], gifts: [], entitlements: [] });
  refused({ paid: [paidGroup({ pancakeVariationId: "has:colon" })], gifts: [], entitlements: [] });
  refused({ paid: [paidGroup({ pancakeVariationId: "x".repeat(101) })], gifts: [], entitlements: [] });
  refused({ paid: [full], gifts: [gift({ campaignId: "a b" })], entitlements: [slots(1, 1)] });
  refused({ paid: [full], gifts: [gift()], entitlements: [] }); // a gift with no entitlement of its campaign
  refused({ paid: [full], gifts: [gift(), gift()], entitlements: [slots(2, 2)] }); // the same gift line twice
  refused({ paid: [full], gifts: [gift({ quantity: 2 })], entitlements: [slots(1, 1)] }); // taken more than the entitlement says
  refused({ paid: [full], gifts: [], entitlements: [slots(2, 0, 1)] }); // reasons do not account for the unclaimed slots
  refused({ paid: [paidGroup({ steps: [{ ...tierStep, outputPriceVnd: 80_000 }] })], gifts: [], entitlements: [] }); // ledger ends at another price
  refused({ paid: Array.from({ length: 201 }, (_, index) => paidGroup({ groupKey: `g${index}`, pancakeVariationId: `v${index}` })), gifts: [], entitlements: [] });
});

// -- The proof -------------------------------------------------------------------------------------------

test("a proof of the current benefit quote verifies; canonicalization is deterministic and order-independent", () => {
  const quote = withGift();
  assert.deepEqual(verify(proof(quote), quote), { ok: true });
  assert.equal(proof(quote), proof(quote));
  const reordered: BenefitQuoteProofFacts = { ...quote, lines: [...quote.lines].reverse(), entitlements: [...quote.entitlements].reverse() };
  assert.equal(proof(reordered), proof(quote));
  assert.equal(benefitQuoteDigest(reordered), benefitQuoteDigest(quote));
});

test("EX-17: moving the same total between segments makes the proof stale", () => {
  const issued = proof(build());
  // 2 x 100.001 + 1 x 90.001 = 290.003 = 1 x 100.001 + 2 x 95.001.
  const other = build({
    paid: [
      paidGroup({ groupKey: "a", quantity: 1, unitPriceVnd: 100_001 }),
      paidGroup({ groupKey: "b", quantity: 2, unitPriceVnd: 95_001, steps: [{ ...tierStep, outputPriceVnd: 95_001 }] }),
    ],
  });
  assert.equal(other.paidSubtotalVnd, build().paidSubtotalVnd);
  assert.equal(other.totalVnd, build().totalVnd);
  assert.deepEqual(verify(issued, other), { ok: false, reason: "PRICE_CHANGED" });
});

test("EX-13/14: a change in gifts, entitlement, campaign revision or provenance is stale even when the total is identical", () => {
  const quote = withGift();
  const issued = proof(quote);
  const same = (candidate: BenefitQuoteProofFacts) => {
    assert.equal(candidate.totalVnd, quote.totalVnd, "the scenario must keep the total");
    return verify(issued, candidate);
  };
  const stale = { ok: false, reason: "PRICE_CHANGED" } as const;

  // A different gift variation (same 0d, same total).
  assert.deepEqual(same(build({ gifts: [gift({ pancakeVariationId: "var-other" })], entitlements: [slots(2, 1)] })), stale);
  // The gift line moved to another campaign.
  assert.deepEqual(same(build({ gifts: [gift({ campaignId: "camp-2" })], entitlements: [{ ...slots(2, 1), campaignId: "camp-2" }] })), stale);
  // The campaign was edited (revision) between render and submit.
  assert.deepEqual(same(build({ gifts: [gift({ campaignRevision: 4 })], entitlements: [{ ...slots(2, 1), campaignRevision: 4 }] })), stale);
  // One more gift slot earned, same one taken: the unclaimed count changed.
  assert.deepEqual(same(build({ gifts: [gift()], entitlements: [slots(3, 1)] })), stale);
  // The slot not taken is now short for stock rather than skipped.
  assert.deepEqual(same(build({ gifts: [gift()], entitlements: [{ ...slots(2, 1), skippedWhileAvailable: 0, shortForStock: 1 }] })), stale);
  // The buyer takes both slots.
  assert.deepEqual(same(build({ gifts: [gift({ quantity: 2 })], entitlements: [slots(2, 2)] })), stale);
  // The gift disappeared altogether (taken 0 of 2).
  assert.deepEqual(same(build({ gifts: [], entitlements: [slots(2, 0)] })), stale);
  // Same prices, but a different campaign produced the discount.
  assert.deepEqual(same(build({ paid: [full, paidGroup({ groupKey: "cuid-a|disc", quantity: 1, unitPriceVnd: 90_001, steps: [{ ...tierStep, campaignId: "tier-2" }] })], gifts: [gift()], entitlements: [slots(2, 1)] })), stale);
  // A paid line that became PREORDER.
  assert.deepEqual(same(build({ paid: [{ ...full, fulfillmentState: "PREORDER" }, disc], gifts: [gift()], entitlements: [slots(2, 1)] })), stale);
});

test("the lineId itself is signed: the same segments under other ids are a different quote", () => {
  const quote = build();
  const issued = proof(quote);
  const relabelled: BenefitQuoteProofFacts = { ...quote, lines: quote.lines.map((line, index) => ({ ...line, lineId: `P:var-1:${index + 5}` })) };
  assert.equal(relabelled.totalVnd, quote.totalVnd);
  assert.deepEqual(verify(issued, relabelled), { ok: false, reason: "PRICE_CHANGED" });
  assert.notEqual(benefitQuoteDigest(relabelled), benefitQuoteDigest(quote));
});

test("the proof is bound to its cart and secret, and a cart id never appears in the token", () => {
  const quote = withGift();
  const issued = proof(quote);
  assert.deepEqual(verify(issued, quote, { cartId: otherCartId }), { ok: false, reason: "PROOF_UNVERIFIED" });
  assert.deepEqual(verify(issued, quote, { secret: otherSecret }), { ok: false, reason: "PROOF_UNVERIFIED" });
  const decoded = Buffer.from(issued.split(".")[0]!, "base64url").toString("utf8");
  assert.equal(decoded.includes(cartId), false);
  assert.equal(issued.includes(cartId), false);
  assert.equal(decoded.startsWith("laq3|"), true);
  // Customer data and internal ids are not in the facts at all.
  assert.equal(/cuid|variantId|VariantMirror/.test(decoded), false);
});

test("forged, truncated, malformed, missing and oversized tokens are rejected before any price is read", () => {
  const quote = withGift();
  const issued = proof(quote);
  const [payload, mac] = issued.split(".") as [string, string];

  const flipped = `${payload.slice(0, 20)}${payload[20] === "A" ? "B" : "A"}${payload.slice(21)}.${mac}`;
  assert.deepEqual(verify(flipped, quote), { ok: false, reason: "PROOF_UNVERIFIED" });
  assert.deepEqual(verify(`${payload}.${mac.slice(0, -2)}`, quote), { ok: false, reason: "PROOF_MALFORMED" });
  assert.deepEqual(verify(issued.slice(0, issued.length >> 1), quote), { ok: false, reason: "PROOF_MALFORMED" });
  assert.deepEqual(verify(`${payload.slice(0, -4)}.${mac}`, quote), { ok: false, reason: "PROOF_UNVERIFIED" });
  assert.deepEqual(verify(`${mac}.${payload}`, quote), { ok: false, reason: "PROOF_MALFORMED" });
  for (const bad of ["", "not a token", ".", "a.b.c", "!!!.???", 42, null, undefined, {}, ["x"]]) {
    const result = verify(bad, quote);
    assert.equal(result.ok, false, String(bad));
  }
  assert.deepEqual(verify(undefined, quote), { ok: false, reason: "PROOF_MISSING" });
  assert.deepEqual(verify("A".repeat(MAX_BENEFIT_QUOTE_PROOF_BYTES + 1), quote), { ok: false, reason: "PROOF_OVERSIZED" });
});

test("verification answers one question only and fails closed on a malformed current quote", () => {
  const quote = withGift();
  const issued = proof(quote);
  const result = verify(issued, quote);
  assert.deepEqual(Object.keys(result), ["ok"]); // no money, no lines, nothing to read back
  assert.deepEqual(verify(issued, { ...quote, totalVnd: quote.totalVnd + 1 }), { ok: false, reason: "PRICE_CHANGED" });
  assert.deepEqual(verify(issued, {} as BenefitQuoteProofFacts), { ok: false, reason: "PRICE_CHANGED" });
  assert.deepEqual(verify(issued, null as unknown as BenefitQuoteProofFacts), { ok: false, reason: "PRICE_CHANGED" });
  assert.deepEqual(verify(issued, quote, { cartId: "" }), { ok: false, reason: "PROOF_UNVERIFIED" });
  // The server secret is the one loud failure: a misconfigured key must not look like a price change.
  assert.throws(() => verify(issued, quote, { secret: "short" }), TypeError);
  // Facts that are not a quote cannot be signed.
  assert.throws(() => issueBenefitQuoteProof({ quote: { ...quote, paidSubtotalVnd: 1 }, cartId, secret }), TypeError);
  assert.throws(() => issueBenefitQuoteProof({ quote, cartId: "", secret }), TypeError);
});

test("issuing refuses a quote whose proof the verifier would reject for size", () => {
  const huge = build({
    paid: Array.from({ length: 200 }, (_, index) =>
      paidGroup({ groupKey: `g${index}`, pancakeVariationId: `variation-${index}`, quantity: 1, unitPriceVnd: 1_000 + index, steps: Array.from({ length: 8 }, () => ({ campaignId: "c".repeat(60), source: "LEGACY" as const, campaignKind: "FLASH_SALE", priority: null, inputPriceVnd: 1_000 + index, outputPriceVnd: 1_000 + index, appliedQuantity: 1 })) })),
  });
  assert.equal(issueBenefitQuoteProof({ quote: huge, cartId, secret }), null);
});

test("a legacy proof and a benefit proof never stand in for each other", () => {
  const legacyFacts = { items: [{ variantExternalId: "var-1", quantity: 1, unitPriceVnd: 100_000, fulfillmentState: "READY" as const }], merchandiseSubtotalVnd: 100_000, shippingFeeVnd: 30_000, totalVnd: 130_000, totalQuantity: 1 };
  const legacy = issueRenderedQuoteProof({ quote: legacyFacts, cartId, secret })!;
  const quote = build({ paid: [paidGroup({ quantity: 1, unitPriceVnd: 100_000 })] });
  assert.equal(quote.totalVnd, 130_000);
  assert.deepEqual(verify(legacy, quote), { ok: false, reason: "PRICE_CHANGED" });
  assert.deepEqual(verifyRenderedQuoteProof({ proof: proof(quote), cartId, currentQuote: legacyFacts, secret }), { ok: false, reason: "PRICE_CHANGED" });
  // The legacy format is exactly what it was.
  assert.equal(Buffer.from(legacy.split(".")[0]!, "base64url").toString("utf8").startsWith("laq2|"), true);
});

// -- The non-claim acknowledgement -----------------------------------------------------------------------

const unclaimed = () => withGift(); // 2 earned, 1 taken

test("FR-06: nothing is acknowledged unless slots are left; then selected < entitled needs a signed acknowledgement", () => {
  const complete = build({ gifts: [gift({ quantity: 2 })], entitlements: [slots(2, 2)] });
  assert.equal(issueNonclaimAcknowledgement({ quote: complete, cartId, secret, now: NOW }), null);
  assert.equal(benefitQuoteNeedsNonclaimAcknowledgement(unclaimed()), true);
  const token = issueNonclaimAcknowledgement({ quote: unclaimed(), cartId, secret, now: NOW });
  assert.ok(token);
  assert.deepEqual(verifyNonclaimAcknowledgement({ token, cartId, currentQuote: unclaimed(), secret, now: NOW }), { ok: true, acknowledgedAt: NOW });
  // Taking zero gifts is a full non-claim and needs the same acknowledgement.
  const none = build({ entitlements: [slots(2, 0)] });
  assert.ok(issueNonclaimAcknowledgement({ quote: none, cartId, secret, now: NOW }));
});

test("the acknowledgement is bound to the exact quote: any change to prices, gifts, slots or revisions is stale", () => {
  const token = issueNonclaimAcknowledgement({ quote: unclaimed(), cartId, secret, now: NOW })!;
  const check = (currentQuote: BenefitQuoteProofFacts) => verifyNonclaimAcknowledgement({ token, cartId, currentQuote, secret, now: NOW });
  const stale = { ok: false, reason: "ACK_STALE" } as const;
  assert.deepEqual(check(build({ gifts: [gift()], entitlements: [slots(3, 1)] })), stale);
  assert.deepEqual(check(build({ gifts: [gift({ pancakeVariationId: "var-other" })], entitlements: [slots(2, 1)] })), stale);
  assert.deepEqual(check(build({ gifts: [gift({ campaignRevision: 4 })], entitlements: [{ ...slots(2, 1), campaignRevision: 4 }] })), stale);
  assert.deepEqual(check(build({ paid: [full, { ...disc, unitPriceVnd: 90_000, steps: [{ ...tierStep, outputPriceVnd: 90_000 }] }], gifts: [gift()], entitlements: [slots(2, 1)] })), stale);
  // The buyer ended up taking everything: nothing left to acknowledge, so the token is ignored.
  assert.deepEqual(check(build({ gifts: [gift({ quantity: 2 })], entitlements: [slots(2, 2)] })), { ok: false, reason: "ACK_NOT_REQUIRED" });
});

test("the acknowledgement is bound to its cart and secret and expires", () => {
  const quote = unclaimed();
  const token = issueNonclaimAcknowledgement({ quote, cartId, secret, now: NOW })!;
  const at = (seconds: number, overrides: { cartId?: string; secret?: string; token?: unknown } = {}) =>
    verifyNonclaimAcknowledgement({ token: overrides.token ?? token, cartId: overrides.cartId ?? cartId, currentQuote: quote, secret: overrides.secret ?? secret, now: new Date(NOW.getTime() + seconds * 1000) });
  assert.deepEqual(at(0, { cartId: otherCartId }), { ok: false, reason: "ACK_UNVERIFIED" });
  assert.deepEqual(at(0, { secret: otherSecret }), { ok: false, reason: "ACK_UNVERIFIED" });
  assert.equal(at(MAX_NONCLAIM_ACK_AGE_SECONDS).ok, true);
  assert.deepEqual(at(MAX_NONCLAIM_ACK_AGE_SECONDS + 1), { ok: false, reason: "ACK_EXPIRED" });
  // A token dated well in the future cannot be a real one; a little skew is tolerated.
  assert.equal(at(-30).ok, true);
  assert.deepEqual(at(-5 * 60), { ok: false, reason: "ACK_MALFORMED" });
  // The acknowledged instant is read from the signed payload, never supplied by the caller.
  const verdict = at(600);
  assert.ok(verdict.ok);
  assert.deepEqual(verdict.acknowledgedAt, NOW);
  assert.equal(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8").includes(cartId), false);
});

test("forged, truncated, malformed and cross-used acknowledgements are rejected", () => {
  const quote = unclaimed();
  const token = issueNonclaimAcknowledgement({ quote, cartId, secret, now: NOW })!;
  const [payload, mac] = token.split(".") as [string, string];
  const check = (value: unknown) => verifyNonclaimAcknowledgement({ token: value, cartId, currentQuote: quote, secret, now: NOW });
  assert.deepEqual(check(undefined), { ok: false, reason: "ACK_MISSING" });
  assert.deepEqual(check(""), { ok: false, reason: "ACK_MISSING" });
  assert.deepEqual(check("A".repeat(600)), { ok: false, reason: "ACK_MALFORMED" });
  assert.deepEqual(check(`${payload}.${mac.slice(0, -2)}`), { ok: false, reason: "ACK_MALFORMED" });
  assert.deepEqual(check(token.slice(0, token.length >> 1)), { ok: false, reason: "ACK_MALFORMED" });
  assert.deepEqual(check(`${payload.slice(0, 10)}${payload[10] === "A" ? "B" : "A"}${payload.slice(11)}.${mac}`), { ok: false, reason: "ACK_UNVERIFIED" });
  assert.equal(check({}).ok, false);
  assert.equal(check(7).ok, false);
  // A render proof is not an acknowledgement and an acknowledgement is not a render proof.
  assert.deepEqual(check(proof(quote)), { ok: false, reason: "ACK_UNVERIFIED" });
  assert.deepEqual(verify(token, quote), { ok: false, reason: "PROOF_UNVERIFIED" });
  assert.throws(() => verifyNonclaimAcknowledgement({ token, cartId, currentQuote: quote, secret: "short", now: NOW }), TypeError);
  assert.throws(() => issueNonclaimAcknowledgement({ quote, cartId: "", secret, now: NOW }), TypeError);
  assert.throws(() => issueNonclaimAcknowledgement({ quote, cartId, secret, now: new Date(Number.NaN) }), TypeError);
});

test("the digest identifies the quote: equal facts agree, any difference disagrees, and it is not the token", () => {
  const quote = withGift();
  assert.match(benefitQuoteDigest(quote), /^[0-9a-f]{64}$/);
  assert.equal(benefitQuoteDigest(quote), benefitQuoteDigest(withGift()));
  assert.notEqual(benefitQuoteDigest(quote), benefitQuoteDigest(build({ gifts: [gift()], entitlements: [slots(3, 1)] })));
  assert.equal(proof(quote).includes(benefitQuoteDigest(quote)), false);
});

// PR198 replaces the retired quantity/subtotal waiver; gifts still never alter paid merchandise.
test("shipping without an active campaign stays at the base fee across the retired thresholds", () => {
  for (const paid of [[paidGroup({ quantity: 2, unitPriceVnd: 500000 })], [paidGroup({ quantity: 1, unitPriceVnd: 1000001 })], [paidGroup({ quantity: 3, unitPriceVnd: 1000 })], [paidGroup({ groupKey: "a", quantity: 2, unitPriceVnd: 1000 }), paidGroup({ groupKey: "b", quantity: 1, unitPriceVnd: 900 })]]) {
    assert.equal(build({ paid }).shippingFeeVnd, GUEST_SHIPPING_FEE_VND);
  }
});

test("gift units cannot produce automatic free shipping or change the paid subtotal", () => {
  const paid = [paidGroup({ quantity: 2, unitPriceVnd: 1000 })];
  const withGifts = build({ paid, gifts: [gift({ quantity: 50 })], entitlements: [slots(50, 50)] });
  assert.equal(withGifts.shippingFeeVnd, GUEST_SHIPPING_FEE_VND);
  assert.equal(withGifts.paidSubtotalVnd, build({ paid }).paidSubtotalVnd);
  const discounted = build({ paid: [paidGroup({ quantity: 1, unitPriceVnd: 1000000, steps: [{ ...tierStep, inputPriceVnd: 1000001, outputPriceVnd: 1000000 }] })] });
  assert.equal(discounted.shippingFeeVnd, GUEST_SHIPPING_FEE_VND);
});
