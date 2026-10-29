import assert from "node:assert/strict";
import test from "node:test";

import { checkoutAttemptKey } from "../../src/commerce/checkout-attempt-key.ts";
import { benefitQuoteDigest, issueRenderedQuoteProof, verifyRenderedQuoteProof } from "../../src/commerce/checkout-quote-proof.ts";
import {
  MAX_VOUCHER_QUOTE_PROOF_BYTES,
  areUsableVoucherProofFacts,
  issueVoucherQuoteProof,
  verifyVoucherQuoteProof,
  voucherProofFactsFromQuote,
  voucherQuoteDigest,
  type VoucherProofFacts,
} from "../../src/commerce/voucher-quote-proof.ts";
import { buildVoucherOrderSnapshot, parseVoucherOrderSnapshot } from "../../src/commerce/voucher-order-snapshot.ts";
import type { VoucherCampaign } from "../../src/commerce/voucher-campaign.ts";
import { buildVoucherQuote } from "../../src/commerce/voucher-quote.ts";
import { validateVoucherCampaign } from "../../src/commerce/voucher-rule-validation.ts";

const SECRET = "s".repeat(40);
const CART = "11111111-2222-3333-4444-555555555555";
const NOW = new Date("2026-10-25T12:00:00Z");
const IN_5 = NOW.getTime() + 5 * 60_000;
const IN_10 = NOW.getTime() + 10 * 60_000;

const base = (overrides: Partial<VoucherProofFacts> = {}): VoucherProofFacts => ({
  state: "PREVIEW",
  paidRevision: BigInt(7),
  lines: [{ pancakeVariationId: "V1", quantity: 2, unitPriceVnd: 290_000, role: "PAID" }],
  paidSubtotalVnd: 580_000,
  shippingFeeVnd: 0,
  totalVnd: 580_000,
  merchandise: [{ campaignId: "m1", campaignRevision: 3, amountVnd: 40_000, hold: null }],
  shipping: { campaignId: "s1", campaignRevision: 2, amountVnd: 30_000, hold: null },
  ...overrides,
});
const held = (overrides: Partial<VoucherProofFacts> = {}) =>
  base({
    state: "HELD",
    merchandise: [{ campaignId: "m1", campaignRevision: 3, amountVnd: 40_000, hold: { holdId: "hold_m1", expiresAtMs: IN_10 } }],
    shipping: { campaignId: "s1", campaignRevision: 2, amountVnd: 30_000, hold: { holdId: "hold_s1", expiresAtMs: IN_5 } },
    ...overrides,
  });
const issue = (facts: VoucherProofFacts, cartId = CART) => issueVoucherQuoteProof({ facts, cartId, secret: SECRET })!;
const verify = (proof: unknown, current: VoucherProofFacts, mode: "PREVIEW" | "SUBMIT" = "PREVIEW", cartId = CART, now = NOW) =>
  verifyVoucherQuoteProof({ proof, cartId, current, secret: SECRET, mode, now });

test("a proof verifies against the identical recomputed quote and returns no money", () => {
  const proof = issue(base());
  assert.deepEqual(verify(proof, base()), { ok: true, held: false });
  assert.deepEqual(Object.keys(verify(proof, base())), ["ok", "held"]);
});

test("tampering with any field of the recomputed quote is STALE_QUOTE (price, voucher, revision, hold, lines)", () => {
  const proof = issue(held());
  const reason = (current: VoucherProofFacts) => (verify(proof, current, "SUBMIT") as { reason?: string }).reason;
  assert.equal(reason(held()), undefined);
  assert.equal(reason(held({ lines: [{ pancakeVariationId: "V1", quantity: 2, unitPriceVnd: 289_999, role: "PAID" }], paidSubtotalVnd: 579_998, totalVnd: 579_998 })), "STALE_QUOTE");
  assert.equal(reason(held({ merchandise: [{ campaignId: "m1", campaignRevision: 4, amountVnd: 40_000, hold: { holdId: "hold_m1", expiresAtMs: IN_10 } }] })), "STALE_QUOTE");
  assert.equal(reason(held({ merchandise: [{ campaignId: "m2", campaignRevision: 3, amountVnd: 40_000, hold: { holdId: "hold_m1", expiresAtMs: IN_10 } }] })), "STALE_QUOTE");
  assert.equal(reason(held({ merchandise: [{ campaignId: "m1", campaignRevision: 3, amountVnd: 40_000, hold: { holdId: "other", expiresAtMs: IN_10 } }] })), "STALE_QUOTE");
  assert.equal(reason(held({ shipping: null, shippingFeeVnd: 30_000, totalVnd: 610_000 })), "STALE_QUOTE");
});

test("AC-34: a changed cart is a different quote even when the money is identical (paidRevision, ABA)", () => {
  const proof = issue(base({ paidRevision: BigInt(7) }));
  assert.equal((verify(proof, base({ paidRevision: BigInt(8) })) as { reason?: string }).reason, "STALE_QUOTE");
  assert.equal((verify(proof, base({ paidRevision: BigInt(7) })) as { ok: boolean }).ok, true);
});

test("a proof cannot be replayed on another cart, and the cart id is not in the token", () => {
  const proof = issue(base());
  assert.equal((verify(proof, base(), "PREVIEW", "99999999-2222-3333-4444-555555555555") as { reason?: string }).reason, "PROOF_UNVERIFIED");
  assert.doesNotMatch(Buffer.from(proof.split(".")[0]!, "base64url").toString(), new RegExp(CART));
  assert.doesNotMatch(proof, new RegExp(CART));
});

test("the wrong secret, a flipped byte and malformed tokens are rejected before any comparison", () => {
  const proof = issue(base());
  assert.equal((verifyVoucherQuoteProof({ proof, cartId: CART, current: base(), secret: "x".repeat(40), mode: "PREVIEW", now: NOW }) as { reason?: string }).reason, "PROOF_UNVERIFIED");
  const [payload, mac] = proof.split(".");
  // Flip a character in the middle: the last base64url character of 32 bytes carries padding bits only.
  const flipped = `${payload}.${mac!.slice(0, 10)}${mac![10] === "A" ? "B" : "A"}${mac!.slice(11)}`;
  assert.equal((verify(flipped, base()) as { reason?: string }).reason, "PROOF_UNVERIFIED");
  assert.equal((verify("", base()) as { reason?: string }).reason, "PROOF_MISSING");
  assert.equal((verify(undefined, base()) as { reason?: string }).reason, "PROOF_MISSING");
  assert.equal((verify("not a token", base()) as { reason?: string }).reason, "PROOF_MALFORMED");
  assert.equal((verify("a".repeat(MAX_VOUCHER_QUOTE_PROOF_BYTES + 1), base()) as { reason?: string }).reason, "PROOF_OVERSIZED");
  assert.equal((verify(`${payload}.AAAA`, base()) as { reason?: string }).reason, "PROOF_MALFORMED");
});

test("AC-42/43: a preview proof can never authorize a submit; only a held one can, and only until the earliest expiry", () => {
  assert.equal((verify(issue(base()), base(), "SUBMIT") as { reason?: string }).reason, "HOLD_REQUIRED");
  const proof = issue(held());
  assert.deepEqual(verify(proof, held(), "SUBMIT", CART, NOW), { ok: true, held: true });
  assert.deepEqual(verify(proof, held(), "SUBMIT", CART, new Date(IN_5 - 1)), { ok: true, held: true });
  // The shipping hold expires first (T+5): absolute, at the boundary and after.
  assert.equal((verify(proof, held(), "SUBMIT", CART, new Date(IN_5)) as { reason?: string }).reason, "HOLD_EXPIRED");
  assert.equal((verify(proof, held(), "SUBMIT", CART, new Date(IN_10 + 1)) as { reason?: string }).reason, "HOLD_EXPIRED");
  // A held proof is still fine for preview, and a HELD state without any hold reference is not submit-capable.
  assert.deepEqual(verify(proof, held(), "PREVIEW", CART, new Date(IN_10 + 1)), { ok: true, held: true });
  const bare = base({ state: "HELD", merchandise: [], shipping: null, paidSubtotalVnd: 580_000 });
  assert.equal((verify(issue(bare), bare, "SUBMIT") as { reason?: string }).reason, "HOLD_REQUIRED");
});

test("facts must be consistent: bad sums, a preview with a hold, a held voucher without one, gift prices", () => {
  assert.equal(areUsableVoucherProofFacts(base()), true);
  assert.equal(areUsableVoucherProofFacts(base({ totalVnd: 580_001 })), false);
  assert.equal(areUsableVoucherProofFacts(base({ paidSubtotalVnd: 579_999, totalVnd: 579_999 })), false);
  assert.equal(areUsableVoucherProofFacts(base({ merchandise: [{ campaignId: "m1", campaignRevision: 3, amountVnd: 40_000, hold: { holdId: "h", expiresAtMs: IN_10 } }] })), false);
  assert.equal(areUsableVoucherProofFacts(held({ shipping: { campaignId: "s1", campaignRevision: 2, amountVnd: 30_000, hold: null } })), false);
  assert.equal(areUsableVoucherProofFacts(base({ lines: [...base().lines, { pancakeVariationId: "G1", quantity: 1, unitPriceVnd: 1_000, role: "GIFT" }] })), false);
  assert.equal(areUsableVoucherProofFacts(base({ lines: [] })), false);
  assert.throws(() => issue(base({ totalVnd: 1 })), TypeError);
  assert.throws(() => issueVoucherQuoteProof({ facts: base(), cartId: "", secret: SECRET }), TypeError);
  assert.throws(() => issueVoucherQuoteProof({ facts: base(), cartId: CART, secret: "short" }), TypeError);
});

test("line order is canonicalized; a gift line rides the proof at 0đ", () => {
  const a = base({ lines: [{ pancakeVariationId: "V1", quantity: 2, unitPriceVnd: 290_000, role: "PAID" }, { pancakeVariationId: "G1", quantity: 1, unitPriceVnd: 0, role: "GIFT" }] });
  const b = base({ lines: [...a.lines].reverse() });
  assert.equal(voucherQuoteDigest(a), voucherQuoteDigest(b));
  assert.equal((verify(issue(a), b) as { ok: boolean }).ok, true);
  assert.match(voucherQuoteDigest(a), /^[0-9a-f]{64}$/);
});

test("oversized facts yield no token instead of one the verifier would refuse", () => {
  const lines = Array.from({ length: 300 }, (_, i) => ({ pancakeVariationId: `${"v".repeat(60)}${i}`, quantity: 1, unitPriceVnd: 100_000 + i, role: "PAID" as const }));
  const paid = lines.reduce((sum, l) => sum + l.unitPriceVnd, 0);
  assert.equal(issueVoucherQuoteProof({ facts: base({ lines, paidSubtotalVnd: paid, totalVnd: paid }), cartId: CART, secret: SECRET }), null);
});

test("legacy compatibility: this proof shares no bytes with the existing formats, and they still verify as before", () => {
  const legacyFacts = { items: [{ variantExternalId: "V1", quantity: 1, unitPriceVnd: 100_000, fulfillmentState: "READY" as const }], merchandiseSubtotalVnd: 100_000, shippingFeeVnd: 30_000, totalVnd: 130_000, totalQuantity: 1 };
  const legacy = issueRenderedQuoteProof({ quote: legacyFacts, cartId: CART, secret: SECRET });
  assert.deepEqual(verifyRenderedQuoteProof({ proof: legacy, cartId: CART, currentQuote: legacyFacts, secret: SECRET }), { ok: true });
  // A voucher proof is not accepted as a legacy proof, and a legacy proof is not a voucher proof.
  assert.equal((verifyRenderedQuoteProof({ proof: issue(base()), cartId: CART, currentQuote: legacyFacts, secret: SECRET }) as { ok: boolean }).ok, false);
  assert.equal((verify(legacy, base()) as { ok: boolean }).ok, false);
  assert.equal(typeof benefitQuoteDigest, "function");
  assert.match(checkoutAttemptKey(CART, SECRET), /^[0-9a-f]{64}$/);
});

/* ------------------------------------------------------------------ from a real quote + the order snapshot */

const SHOP = 940_012;
function voucher(id: string, input: Record<string, unknown>): VoucherCampaign {
  const parsed = validateVoucherCampaign({ name: id, kind: "MERCHANDISE", issuance: "AUTO", visibility: "PUBLIC", scope: { mode: "ALL_SHOP", excludeProductIds: [] }, ...input });
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  return { ...(parsed as { value: object }).value, id, pancakeShopId: SHOP, revision: 4, isEnabled: true, enabledAt: new Date("2026-10-01T00:00:00Z"), disabledAt: null, redeemedUses: 0, redeemedVnd: 0, reservedUses: 0, reservedVnd: 0 } as VoucherCampaign;
}

function realQuote() {
  const campaigns = [
    voucher("m20", { discount: { type: "FIXED_AMOUNT_VND", amountVnd: 20_000 }, minEligibleSubtotalVnd: 100_000 }),
    voucher("s600", { kind: "SHIPPING_FREE", minEligibleSubtotalVnd: 600_000 }),
  ];
  const quote = buildVoucherQuote({
    lines: [{ lineId: "a", product: { productId: "a", shopId: String(SHOP), categoryKeys: [] }, quantity: 1, unitPriceVnd: 620_000 }],
    campaigns,
    existingOtherPromotions: false,
    campaignShippingFeeVnd: () => 30_000,
    giftOutcome: () => ({ entitledSlots: 0, retainedSelectedSlots: 0 }),
  });
  assert.equal(quote.ok, true);
  return { quote: quote as Extract<typeof quote, { ok: true }>, campaigns };
}

test("proof facts built from a real quote bind the chosen vouchers, their revisions and amounts", () => {
  const { quote, campaigns } = realQuote();
  const facts = voucherProofFactsFromQuote({ quote, campaigns, paidRevision: BigInt(3), lines: [{ pancakeVariationId: "V1", quantity: 1, unitPriceVnd: 600_000, role: "PAID" }] });
  assert.equal(facts.state, "PREVIEW");
  assert.deepEqual(facts.merchandise, [{ campaignId: "m20", campaignRevision: 4, amountVnd: 20_000, hold: null }]);
  assert.deepEqual(facts.shipping, { campaignId: "s600", campaignRevision: 4, amountVnd: 30_000, hold: null });
  assert.equal(facts.totalVnd, 600_000);
  assert.equal((verify(issue(facts), facts) as { ok: boolean }).ok, true);
  const withHolds = voucherProofFactsFromQuote({ quote, campaigns, paidRevision: BigInt(3), lines: facts.lines, holds: { merchandise: { m20: { holdId: "hm", expiresAtMs: IN_10 } }, shipping: { holdId: "hs", expiresAtMs: IN_10 } } });
  assert.equal(withHolds.state, "HELD");
  assert.deepEqual(verify(issue(withHolds), withHolds, "SUBMIT"), { ok: true, held: true });
  assert.throws(() => voucherProofFactsFromQuote({ quote, campaigns: [], paidRevision: BigInt(0), lines: facts.lines }), TypeError);
});

test("the order snapshot freezes what was applied and round-trips through a strict parser", () => {
  const { quote, campaigns } = realQuote();
  const snapshot = buildVoucherOrderSnapshot({ quote, revisions: new Map(campaigns.map((c) => [c.id, c.revision])) });
  assert.deepEqual(snapshot, {
    v: 2,
    merchandise: [{ campaignId: "m20", slot: "MERCHANDISE", campaignRevision: 4, amountVnd: 20_000, allocation: [{ lineId: "a", deductionVnd: 20_000 }] }],
    shipping: { campaignId: "s600", campaignRevision: 4, waivedFeeVnd: 30_000 },
    paidBeforeVnd: 620_000,
    paidAfterVnd: 600_000,
    shippingFeeBeforeVoucherVnd: 30_000,
    shippingFeeVnd: 0,
    totalVnd: 600_000,
  });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.deepEqual(parseVoucherOrderSnapshot(JSON.parse(JSON.stringify(snapshot))), snapshot);
});

test("the strict parser refuses unknown versions, extra keys and sums that do not reconcile", () => {
  const { quote, campaigns } = realQuote();
  const good = JSON.parse(JSON.stringify(buildVoucherOrderSnapshot({ quote, revisions: new Map(campaigns.map((c) => [c.id, c.revision])) })));
  assert.notEqual(parseVoucherOrderSnapshot(good), null);
  for (const mutate of [
    (s: Record<string, unknown>) => ({ ...s, v: 3 }),
    (s: Record<string, unknown>) => ({ ...s, extra: 1 }),
    (s: Record<string, unknown>) => ({ ...s, totalVnd: 600_001 }),
    (s: Record<string, unknown>) => ({ ...s, paidAfterVnd: 599_999 }),
    (s: Record<string, unknown>) => ({ ...s, merchandise: [{ ...(s.merchandise as object[])[0], amountVnd: 19_999 }] }),
    (s: Record<string, unknown>) => ({ ...s, shippingFeeVnd: 5 }),
    (s: Record<string, unknown>) => ({ ...s, shipping: { campaignId: "bad id", campaignRevision: 1, waivedFeeVnd: 30_000 } }),
  ]) {
    assert.equal(parseVoucherOrderSnapshot(mutate(good)), null);
  }
  for (const junk of [null, undefined, "x", 5, [], {}]) assert.equal(parseVoucherOrderSnapshot(junk), null);
  assert.throws(() => buildVoucherOrderSnapshot({ quote, revisions: new Map() }), TypeError);
});

// --- ADR 0020: several merchandise vouchers -----------------------------------------------------------------------------

const binding = (campaignId: string, amountVnd: number) => ({ campaignId, campaignRevision: 1, amountVnd, hold: null });

test("ADR 0020: the same vouchers in another order are another quote (different digest, STALE_QUOTE)", () => {
  const forward = base({ merchandise: [binding("a1", 30_000), binding("b1", 10_000)] });
  const reversed = base({ merchandise: [binding("b1", 10_000), binding("a1", 30_000)] });
  assert.notEqual(voucherQuoteDigest(forward), voucherQuoteDigest(reversed));
  assert.equal((verify(issue(forward), reversed) as { reason?: string }).reason, "STALE_QUOTE");
  assert.deepEqual(verify(issue(forward), forward), { ok: true, held: false });
});

test("ADR 0020: a held quote expires at the EARLIEST of all its holds, merchandise included", () => {
  const facts = held({
    merchandise: [
      { campaignId: "a1", campaignRevision: 1, amountVnd: 30_000, hold: { holdId: "ha", expiresAtMs: IN_10 } },
      { campaignId: "b1", campaignRevision: 1, amountVnd: 10_000, hold: { holdId: "hb", expiresAtMs: IN_5 - 1_000 } },
    ],
    shipping: null,
  });
  assert.deepEqual(verify(issue(facts), facts, "SUBMIT"), { ok: true, held: true });
  assert.equal((verify(issue(facts), facts, "SUBMIT", CART, new Date(IN_5 - 1_000)) as { reason?: string }).reason, "HOLD_EXPIRED");
});

test("ADR 0020: facts with a duplicated voucher, too many vouchers, or a voucher without its hold are unusable", () => {
  assert.equal(areUsableVoucherProofFacts(base({ merchandise: [binding("a1", 1_000), binding("a1", 2_000)] })), false);
  assert.equal(areUsableVoucherProofFacts(base({ merchandise: Array.from({ length: 9 }, (_, index) => binding(`m${index}`, 1_000)) })), false);
  assert.equal(areUsableVoucherProofFacts(held({ merchandise: [binding("a1", 1_000)] })), false);
  assert.equal(areUsableVoucherProofFacts(base({ merchandise: [binding("a1", 1_000), binding("b1", 2_000)] })), true);
});

test("ADR 0020: a stored v1 snapshot (one voucher, no slot) still parses, as the equivalent v2", () => {
  const v1 = {
    v: 1,
    merchandise: { campaignId: "m20", campaignRevision: 4, amountVnd: 20_000, allocation: [{ lineId: "a", deductionVnd: 20_000 }] },
    shipping: null,
    paidBeforeVnd: 620_000,
    paidAfterVnd: 600_000,
    shippingFeeBeforeVoucherVnd: 30_000,
    shippingFeeVnd: 30_000,
    totalVnd: 630_000,
  };
  const parsed = parseVoucherOrderSnapshot(v1)!;
  assert.equal(parsed.v, 2);
  assert.deepEqual(parsed.merchandise, [{ campaignId: "m20", slot: "MERCHANDISE", campaignRevision: 4, amountVnd: 20_000, allocation: [{ lineId: "a", deductionVnd: 20_000 }] }]);
  assert.equal(parseVoucherOrderSnapshot({ ...v1, merchandise: null }), null, "a v1 row with no voucher but a discount does not reconcile");
});

test("ADR 0020: a v2 snapshot sums every voucher, and refuses two vouchers in one slot or one voucher twice", () => {
  const entry = (campaignId: string, slot: string, amountVnd: number) => ({ campaignId, slot, campaignRevision: 1, amountVnd, allocation: [{ lineId: `l-${campaignId}`, deductionVnd: amountVnd }] });
  const make = (merchandise: unknown[], paidAfterVnd: number) => ({
    v: 2, merchandise, shipping: null, paidBeforeVnd: 620_000, paidAfterVnd, shippingFeeBeforeVoucherVnd: 30_000, shippingFeeVnd: 30_000, totalVnd: paidAfterVnd + 30_000,
  });
  assert.notEqual(parseVoucherOrderSnapshot(make([entry("a1", "MERCHANDISE:A", 30_000), entry("b1", "MERCHANDISE:B", 10_000)], 580_000)), null);
  assert.equal(parseVoucherOrderSnapshot(make([entry("a1", "MERCHANDISE:A", 30_000), entry("b1", "MERCHANDISE:B", 10_000)], 590_000)), null, "the sum must reconcile");
  assert.equal(parseVoucherOrderSnapshot(make([entry("a1", "MERCHANDISE:A", 30_000), entry("a2", "MERCHANDISE:A", 10_000)], 580_000)), null, "one slot, one voucher");
  assert.equal(parseVoucherOrderSnapshot(make([entry("a1", "MERCHANDISE:A", 30_000), entry("a1", "MERCHANDISE:B", 10_000)], 580_000)), null, "one voucher once");
  assert.equal(parseVoucherOrderSnapshot(make([entry("a1", "SHIPPING_FREE", 30_000)], 590_000)), null, "a merchandise voucher cannot sit in the shipping slot");
});
