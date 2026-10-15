import assert from "node:assert/strict";
import test from "node:test";

import {
  priceStack,
  type StackInputLine,
  type StackLegacyCampaign,
  type StackLegacyConsent,
  type StackPeer,
  type StackResult,
  type StackTierParticipant,
} from "../../src/commerce/gift-quantity-stack.ts";
import {
  findPricesInvalidForTier,
  priceOrderSubtotalTier,
  priceQuantityTier,
  priceTier,
  validateTierConfig,
  type QuantityTierConfig,
  type TierInputLine,
  type TierResult,
} from "../../src/commerce/gift-quantity-tier.ts";
import { resolvePromotionPricing, type ApplicablePromotionCampaign } from "../../src/commerce/promotion-pricing.ts";

/**
 * Order-value ladders: "from X ₫ take Y % / Z ₫ off the order". The invariants that matter for money are
 * asserted as invariants (the discounts add up to exactly Z, no unit falls under 1 ₫, input order never
 * changes the answer), not just on a few hand-picked numbers.
 */

const NOW = new Date("2026-10-15T00:00:00Z");

const orderPct = (tiers: ReadonlyArray<readonly [number, number]>): QuantityTierConfig => ({
  basis: "ORDER_SUBTOTAL", unit: "PERCENTAGE", discountedUnits: "ALL_ELIGIBLE_UNITS", selectionPriority: null,
  tiers: tiers.map(([minQuantity, discountValue]) => ({ minQuantity, discountValue })),
});
const orderTotal = (tiers: ReadonlyArray<readonly [number, number]>): QuantityTierConfig => ({ ...orderPct(tiers), unit: "FIXED_AMOUNT_TOTAL_VND" });

const tl = (lineKey: string, quantity: number, unitPriceVnd: number, variation = `var-${lineKey}`): TierInputLine => ({
  lineKey, pancakeVariationId: variation, quantity, unitPriceVnd,
});

function applied(result: TierResult) {
  assert.equal(result.status, "APPLIED", JSON.stringify(result));
  return result as Extract<TierResult, { status: "APPLIED" }>;
}

const sumTotal = (result: Extract<TierResult, { status: "APPLIED" }>) => result.segments.reduce((sum, s) => sum + s.lineTotalVnd, 0);
const unitsOf = (result: Extract<TierResult, { status: "APPLIED" }>) => result.segments.reduce((sum, s) => sum + s.quantity, 0);

/* ---------------------------------------------------------------- configuration */

test("a valid order-value ladder passes; mixing the two bases' units does not", () => {
  assert.deepEqual(validateTierConfig(orderPct([[1_000_000, 5], [2_000_000, 10]])), []);
  assert.deepEqual(validateTierConfig(orderTotal([[3_000_000, 200_000]])), []);

  assert.ok(validateTierConfig({ ...orderPct([[1_000_000, 5]]), unit: "FIXED_AMOUNT_PER_UNIT_VND" }).includes("UNIT_INVALID"), "a per-unit amount is a quantity idea");
  const quantityWithTotal: QuantityTierConfig = { unit: "FIXED_AMOUNT_TOTAL_VND", discountedUnits: "ALL_ELIGIBLE_UNITS", selectionPriority: null, tiers: [{ minQuantity: 3, discountValue: 2 }] };
  assert.ok(validateTierConfig(quantityWithTotal).includes("UNIT_INVALID"), "a total amount is an order-value idea");
});

test("an order-value ladder has no 'from the threshold' slice and no selection priority", () => {
  assert.ok(validateTierConfig({ ...orderPct([[1_000_000, 5]]), discountedUnits: "FROM_REACHED_THRESHOLD", selectionPriority: "CHEAPEST_FIRST" }).includes("DISCOUNTED_UNITS_INVALID"));
  assert.ok(validateTierConfig({ ...orderPct([[1_000_000, 5]]), selectionPriority: "CHEAPEST_FIRST" }).includes("SELECTION_PRIORITY_NOT_APPLICABLE"));
});

test("thresholds are bounded by the column, and a total off must be smaller than the order that earns it", () => {
  assert.ok(validateTierConfig(orderPct([[2_000_000_001, 5]])).includes("THRESHOLD_INVALID"));
  assert.deepEqual(validateTierConfig(orderPct([[2_000_000_000, 5]])), []);
  assert.ok(validateTierConfig(orderTotal([[500_000, 500_000]])).includes("DISCOUNT_NOT_BELOW_THRESHOLD"));
  assert.ok(validateTierConfig(orderTotal([[500_000, 600_000]])).includes("DISCOUNT_NOT_BELOW_THRESHOLD"));
  assert.deepEqual(validateTierConfig(orderTotal([[500_000, 499_999]])), []);
});

test("the usual ladder rules still hold on this basis", () => {
  assert.ok(validateTierConfig(orderPct([[2_000_000, 5], [1_000_000, 10]])).includes("THRESHOLD_NOT_STRICTLY_INCREASING"));
  assert.ok(validateTierConfig(orderPct([[1_000_000, 10], [2_000_000, 5]])).includes("VALUE_DECREASES_WITH_THRESHOLD"));
  assert.ok(validateTierConfig(orderPct([[1_000_000, 100]])).includes("VALUE_INVALID"));
  assert.ok(validateTierConfig(orderPct([])).includes("TIERS_EMPTY"));
});

test("a ladder without a basis is a quantity ladder, exactly as before", () => {
  const legacy: QuantityTierConfig = { unit: "PERCENTAGE", discountedUnits: "ALL_ELIGIBLE_UNITS", selectionPriority: null, tiers: [{ minQuantity: 3, discountValue: 10 }] };
  assert.deepEqual(validateTierConfig(legacy), []);
  const result = applied(priceTier(legacy, [tl("a", 3, 100_000)]));
  assert.equal(result.totalDiscountVnd, 30_000);
  assert.equal(priceQuantityTier(orderPct([[1_000, 5]]), [tl("a", 1, 5_000)]).status, "INVALID_INPUT", "a quantity pricer refuses an order-value ladder");
  assert.equal(priceOrderSubtotalTier(legacy, [tl("a", 3, 100_000)]).status, "INVALID_INPUT", "and vice versa");
});

/* ---------------------------------------------------------------- percentage */

test("below the first rung nothing changes; exactly on it the rung applies", () => {
  const config = orderPct([[1_000_000, 5]]);
  const below = priceOrderSubtotalTier(config, [tl("a", 1, 999_999)]);
  assert.equal(below.status, "NOT_REACHED");
  assert.ok(below.status === "NOT_REACHED" && below.segments.every((s) => !s.discounted));

  const on = applied(priceOrderSubtotalTier(config, [tl("a", 1, 1_000_000)]));
  assert.equal(on.totalDiscountVnd, 50_000, "the threshold is inclusive");
});

test("the highest reached rung wins, and the percentage is rounded half-up per unit", () => {
  const config = orderPct([[1_000_000, 5], [2_000_000, 10]]);
  const result = applied(priceOrderSubtotalTier(config, [tl("a", 3, 689_001)]));
  // 3 × 689.001 = 2.067.003 reaches the 10 % rung; one unit = 620.100,9 -> 620.101 (half-up), so 68.900 off each.
  assert.equal(result.winningTier.discountValue, 10);
  assert.deepEqual(result.segments.map((s) => [s.segmentKey, s.quantity, s.unitPriceVnd]), [["a|disc", 3, 620_101]]);
  assert.equal(result.totalDiscountVnd, 3 * (689_001 - 620_101));
});

test("a percentage that would leave any unit under 1 VND drops the whole tier, prices unchanged", () => {
  const result = priceOrderSubtotalTier(orderPct([[1_000, 99]]), [tl("cheap", 1, 1), tl("dear", 1, 5_000)]);
  // 1 ₫ at 99 % off rounds to 0 ₫ -> invalid for that unit, so nothing is discounted anywhere.
  assert.equal(result.status, "TIER_PRICE_INVALID");
  assert.ok(result.status === "TIER_PRICE_INVALID" && result.segments.every((s) => s.unitPriceVnd === s.unitPriceBeforeVnd));
});

/* ---------------------------------------------------------------- fixed total */

test("a fixed total comes off exactly once, however it has to be split", () => {
  const lines = [tl("a", 3, 100_000), tl("b", 1, 250_000), tl("c", 2, 33_333)];
  const subtotal = 3 * 100_000 + 250_000 + 2 * 33_333;
  const result = applied(priceOrderSubtotalTier(orderTotal([[500_000, 100_000]]), lines));
  assert.equal(result.totalDiscountVnd, 100_000);
  assert.equal(sumTotal(result), subtotal - 100_000, "the order is exactly 100.000 ₫ cheaper");
  assert.equal(unitsOf(result), 6, "no unit appears or disappears");
});

test("the split follows price: a dearer unit carries a larger share, and the shares are never off by more than 1 ₫ within a line", () => {
  const result = applied(priceOrderSubtotalTier(orderTotal([[500_000, 100_000]]), [tl("a", 3, 100_000), tl("b", 1, 250_000)]));
  const perUnit = new Map<string, number[]>();
  for (const s of result.segments) {
    const list = perUnit.get(s.lineKey) ?? [];
    for (let i = 0; i < s.quantity; i += 1) list.push(s.stepDiscountPerUnitVnd);
    perUnit.set(s.lineKey, list);
  }
  for (const [, discounts] of perUnit) assert.ok(Math.max(...discounts) - Math.min(...discounts) <= 1);
  assert.ok(Math.min(...perUnit.get("b")!) > Math.max(...perUnit.get("a")!), "250.000 ₫ unit takes more than a 100.000 ₫ unit");
  assert.ok(result.segments.filter((s) => s.lineKey === "a").length <= 2, "a line splits into at most two segments");
});

test("the remainder goes to the largest fractional share, with ties settled by price, variation and line -- never input order", () => {
  // D=10 over three equal-price units of one VND-share 3.33...: floors 3,3,3 and 1 ₫ owed.
  const lines = [tl("x", 1, 100), tl("y", 1, 100), tl("z", 1, 100)];
  const config = orderTotal([[300, 10]]);
  const first = applied(priceOrderSubtotalTier(config, lines));
  const second = applied(priceOrderSubtotalTier(config, [...lines].reverse()));
  const shape = (r: Extract<TierResult, { status: "APPLIED" }>) => r.segments.map((s) => `${s.segmentKey}:${s.quantity}:${s.unitPriceVnd}`).sort();
  assert.deepEqual(shape(first), shape(second));
  assert.equal(first.totalDiscountVnd, 10);
  // Equal prices tie on remainder and price; the lowest variation id ('var-x') takes the extra VND.
  assert.deepEqual(first.segments.find((s) => s.lineKey === "x")!.stepDiscountPerUnitVnd, 4);
  assert.deepEqual(first.segments.find((s) => s.lineKey === "y")!.stepDiscountPerUnitVnd, 3);
});

test("invariants hold across many shapes of order: exact total, every unit >= 1 ₫, input order irrelevant", () => {
  let seed = 7;
  const next = (max: number) => { seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff; return (seed % max) + 1; };
  for (let round = 0; round < 300; round += 1) {
    const count = next(5);
    const lines = Array.from({ length: count }, (_, i) => tl(`l${i}`, next(6), next(3) === 1 ? next(50) * 1000 : 20_000 + next(900_000)));
    const subtotal = lines.reduce((sum, l) => sum + l.quantity * l.unitPriceVnd, 0);
    const threshold = Math.max(2, Math.floor(subtotal / 2));
    const discount = 1 + (next(1_000_000) % (threshold - 1));
    const config = orderTotal([[threshold, discount]]);
    const a = priceOrderSubtotalTier(config, lines);
    const b = priceOrderSubtotalTier(config, [...lines].reverse());
    assert.equal(a.status, b.status);
    if (a.status !== "APPLIED") {
      assert.equal(a.status, "TIER_PRICE_INVALID", `only the all-or-nothing refusal is expected: ${JSON.stringify(lines)} D=${discount}`);
      continue;
    }
    assert.equal(a.totalDiscountVnd, discount);
    assert.equal(sumTotal(a), subtotal - discount);
    assert.equal(unitsOf(a), lines.reduce((sum, l) => sum + l.quantity, 0));
    assert.ok(a.segments.every((s) => s.unitPriceVnd >= 1 && s.stepDiscountPerUnitVnd >= 0));
    const shape = (r: Extract<TierResult, { status: "APPLIED" }>) => r.segments.map((s) => `${s.segmentKey}:${s.quantity}:${s.unitPriceVnd}`).sort();
    assert.deepEqual(shape(a), shape(b as Extract<TierResult, { status: "APPLIED" }>));
    const keys = a.segments.map((s) => s.segmentKey);
    assert.equal(new Set(keys).size, keys.length, "segment keys are unique");
  }
});

test("a total that would take any unit under 1 ₫ drops the whole tier (all or nothing)", () => {
  // S = 1.000.000, D = 999.999: the 1 ₫ unit is owed the odd VND and would reach 0.
  const result = priceOrderSubtotalTier(orderTotal([[1_000_000, 999_999]]), [tl("tiny", 1, 1), tl("big", 1, 999_999)]);
  assert.equal(result.status, "TIER_PRICE_INVALID");
  assert.ok(result.status === "TIER_PRICE_INVALID" && result.offendingLineKeys.includes("tiny"));
  assert.ok(result.status === "TIER_PRICE_INVALID" && result.totalDiscountVnd === 0 && result.segments.every((s) => !s.discounted));
});

test("the ladder picks the dearest rung reached, for a fixed total too", () => {
  const config = orderTotal([[1_000_000, 50_000], [3_000_000, 200_000]]);
  assert.equal(applied(priceOrderSubtotalTier(config, [tl("a", 1, 2_500_000)])).totalDiscountVnd, 50_000);
  assert.equal(applied(priceOrderSubtotalTier(config, [tl("a", 1, 3_000_000)])).totalDiscountVnd, 200_000);
});

test("publish-time price safety has nothing to say about a total (it is split at quote time)", () => {
  assert.deepEqual(findPricesInvalidForTier(orderTotal([[1_000_000, 999_999]]), [1, 2, 3]), []);
  assert.deepEqual(findPricesInvalidForTier(orderPct([[1_000, 99]]), [1, 5_000]), [1], "a percentage still can");
});

/* ---------------------------------------------------------------- inside the stack */

const everything = () => true;
function sline(lineKey: string, quantity: number, basePriceVnd: number, productId = "p1", legacy: StackLegacyCampaign | null = null): StackInputLine {
  let legacyEntry: StackInputLine["legacy"] = null;
  if (legacy !== null) {
    const campaign: ApplicablePromotionCampaign = { ...legacy, name: legacy.id, startsAt: null, endsAt: null };
    const priced = resolvePromotionPricing({ basePriceVnd, campaigns: [campaign], now: NOW });
    if (priced.isDiscounted && priced.effectivePriceVnd !== null) legacyEntry = { campaign: legacy, effectivePriceVnd: priced.effectivePriceVnd };
  }
  return { lineKey, pancakeVariationId: `var-${lineKey}`, quantity, product: { productId, categoryKeys: [] }, basePriceVnd, legacy: legacyEntry };
}
const participant = (id: string, config: QuantityTierConfig, opts: Partial<StackTierParticipant> = {}): StackTierParticipant => ({
  id, config, resolve: everything, priority: null, stackingEnabled: false, peers: [], ...opts,
});
const qtyPct = (threshold: number, value: number): QuantityTierConfig => ({
  unit: "PERCENTAGE", discountedUnits: "ALL_ELIGIBLE_UNITS", selectionPriority: null, tiers: [{ minQuantity: threshold, discountValue: value }],
});
const flash: StackLegacyCampaign = { id: "flash", kind: "FLASH_SALE", discountType: "PERCENTAGE", percentageValue: 10, fixedPriceVnd: null };
const peers = (...entries: Array<[StackPeer["kind"], string]>): StackPeer[] => entries.map(([kind, campaignId]) => ({ kind, campaignId }));
const noConsent: StackLegacyConsent = new Map();
const ok = (result: StackResult) => { assert.equal(result.ok, true, JSON.stringify(result)); return result as Extract<StackResult, { ok: true }>; };

test("alone, an order-value ladder is judged on the plain subtotal and writes a QUANTITY_TIER step", () => {
  const result = ok(priceStack({
    lines: [sline("a", 3, 400_000), sline("b", 1, 100_000)],
    tiers: [participant("order", orderPct([[1_000_000, 10]]))],
    legacyConsents: noConsent,
  }));
  assert.equal(result.subtotalVnd, 1_170_000, "1.300.000 reaches 1.000.000, so 10 % comes off");
  const step = result.groups[0]!.steps[0]!;
  assert.deepEqual([step.source, step.kind, step.campaignId], ["QUANTITY_TIER", "QUANTITY_TIER", "order"]);
});

test("the threshold is judged AFTER the other discounts, so a Flash Sale can keep the order under it", () => {
  // Without the sale: 2 × 520.000 = 1.040.000 >= 1.000.000. With a 10 % legacy sale it is 936.000 < 1.000.000.
  const result = ok(priceStack({
    lines: [sline("a", 2, 520_000, "p1", flash)],
    tiers: [participant("order", orderPct([[1_000_000, 10]]), { stackingEnabled: true, priority: 2, peers: peers(["FLASH_SALE", "*"]) })],
    legacyConsents: new Map([["flash", { priority: 1 }]]),
  }));
  assert.equal(result.subtotalVnd, 2 * 468_000);
  assert.ok(result.groups.every((g) => g.steps.every((s) => s.source === "LEGACY")), "the order ladder did not apply");
  assert.deepEqual(result.dropped, []);
});

test("it runs last: a quantity ladder and a Flash Sale are applied first, then the order value is judged", () => {
  const result = ok(priceStack({
    lines: [sline("a", 4, 300_000, "p1", flash)], // 270.000 after the sale -> 1.080.000
    tiers: [
      // Priority 1 would put it first if it were a quantity ladder; the order-value ladder must still go last.
      participant("order", orderPct([[1_000_000, 10]]), { stackingEnabled: true, priority: 1, peers: peers(["FLASH_SALE", "*"], ["QUANTITY_TIER", "*"]) }),
      participant("qty", qtyPct(4, 10), { stackingEnabled: true, priority: 2, peers: peers(["FLASH_SALE", "*"], ["QUANTITY_TIER", "*"]) }),
    ],
    legacyConsents: new Map([["flash", { priority: 3 }]]),
  }));
  // sale 300.000 -> 270.000; qty 10 % -> 243.000 (4 × 243.000 = 972.000 < 1.000.000), so the order rung is NOT reached.
  assert.equal(result.subtotalVnd, 972_000);
  assert.ok(result.groups.flatMap((g) => g.steps).every((s) => s.campaignId !== "order"));
});

test("an order-value ladder that is not under the threshold takes no part in conflict detection", () => {
  // Order ladder idle (cart far below 5.000.000) must not make the quantity ladder step aside.
  const result = ok(priceStack({
    lines: [sline("a", 4, 100_000)],
    tiers: [participant("order", orderPct([[5_000_000, 10]])), participant("qty", qtyPct(4, 10))],
    legacyConsents: noConsent,
  }));
  assert.deepEqual(result.dropped, []);
  assert.equal(result.subtotalVnd, 360_000);
});

test("two ladders that have not agreed to stack both step aside when both would apply (existing rule, new basis)", () => {
  const result = ok(priceStack({
    lines: [sline("a", 4, 400_000)],
    tiers: [participant("order", orderPct([[1_000_000, 10]])), participant("qty", qtyPct(4, 10))],
    legacyConsents: noConsent,
  }));
  assert.deepEqual(result.dropped.map((d) => [d.campaignId, d.reason]), [["order", "STACK_NOT_PERMITTED"], ["qty", "STACK_NOT_PERMITTED"]]);
  assert.equal(result.subtotalVnd, 1_600_000, "nothing applied: fail closed");
});

test("a fixed total inside the stack splits into unique group keys and sums exactly", () => {
  const result = ok(priceStack({
    lines: [sline("a", 3, 100_000), sline("b", 1, 250_000)],
    tiers: [participant("order", orderTotal([[500_000, 100_000]]))],
    legacyConsents: noConsent,
  }));
  assert.equal(result.subtotalVnd, 550_000 - 100_000);
  const keys = result.groups.map((g) => g.groupKey);
  assert.equal(new Set(keys).size, keys.length);
  const saved = result.groups.flatMap((g) => g.steps.filter((s) => s.source === "QUANTITY_TIER").map((s) => (s.inputPriceVnd - s.outputPriceVnd) * s.appliedQuantity)).reduce((a, b) => a + b, 0);
  assert.equal(saved, 100_000, "the ledger of steps adds up to the promised amount");
});

test("an invalid order ladder price drops it whole and the chain re-runs without it", () => {
  const result = ok(priceStack({
    lines: [sline("tiny", 1, 1), sline("big", 1, 999_999)],
    tiers: [participant("order", orderTotal([[1_000_000, 999_999]]))],
    legacyConsents: noConsent,
  }));
  assert.deepEqual(result.dropped.map((d) => [d.campaignId, d.reason]), [["order", "TIER_PRICE_INVALID"]]);
  assert.equal(result.subtotalVnd, 1_000_000);
});

/* ---------------------------------------------------------------- through the signed checkout quote */

import { buildBenefitCheckoutQuoteFacts } from "../../src/commerce/checkout-quote.ts";
import { benefitQuoteDigest, issueBenefitQuoteProof, verifyBenefitQuoteProof } from "../../src/commerce/checkout-quote-proof.ts";
import { validateQuoteStructure } from "../../src/commerce/order-quote-rules.ts";

const SECRET = "order-value-secret-at-least-32-characters-long";
const CART = "0f8d3c2a-4b1e-4d7a-9c6b-2e5f1a8d4c30";

/** What the checkout does with the stack's groups: facts, proof, and the structure the order stores. */
function throughCheckout(result: Extract<StackResult, { ok: true }>) {
  const facts = buildBenefitCheckoutQuoteFacts({
    paid: result.groups.map((group) => ({
      groupKey: group.groupKey,
      pancakeVariationId: group.pancakeVariationId,
      quantity: group.quantity,
      unitPriceVnd: group.unitPriceVnd,
      steps: group.steps.map((step) => ({
        campaignId: step.campaignId, source: step.source, campaignKind: String(step.kind), priority: step.priority,
        inputPriceVnd: step.inputPriceVnd, outputPriceVnd: step.outputPriceVnd, appliedQuantity: step.appliedQuantity,
      })),
      fulfillmentState: "READY" as const,
    })),
    gifts: [],
    entitlements: [],
  });
  assert.ok(facts, "the stack's groups must make a consistent signed quote");
  return facts;
}

test("a fixed total's split segments survive the signed quote: ids unique, ledger valid, proof verifies", () => {
  const result = ok(priceStack({
    lines: [sline("a", 3, 100_000), sline("b", 1, 250_000), sline("c", 2, 33_333)],
    tiers: [participant("order", orderTotal([[500_000, 100_000]]))],
    legacyConsents: noConsent,
  }));
  const facts = throughCheckout(result);
  assert.equal(facts.paidSubtotalVnd, result.subtotalVnd);
  assert.equal(new Set(facts.lines.map((line) => line.lineId)).size, facts.lines.length);
  assert.ok(validateQuoteStructure(facts).ok);
  const proof = issueBenefitQuoteProof({ quote: facts, cartId: CART, secret: SECRET });
  assert.ok(proof);
  assert.equal(verifyBenefitQuoteProof({ proof, cartId: CART, currentQuote: facts, secret: SECRET }).ok, true);
  assert.match(benefitQuoteDigest(facts), /^[0-9a-f]{64}$/);
});

test("a Flash Sale, a quantity ladder and an order-value total chain into one valid three-step ledger", () => {
  const consentsAll: StackLegacyConsent = new Map([["flash", { priority: 1 }]]);
  const everyone = peers(["FLASH_SALE", "*"], ["QUANTITY_TIER", "*"]);
  const result = ok(priceStack({
    lines: [sline("a", 4, 300_000, "p1", flash), sline("b", 2, 250_000, "p1", flash)],
    tiers: [
      participant("qty", qtyPct(3, 10), { stackingEnabled: true, priority: 2, peers: everyone }),
      participant("order", orderTotal([[1_000_000, 150_000]]), { stackingEnabled: true, priority: 3, peers: everyone }),
    ],
    legacyConsents: consentsAll,
  }));
  assert.deepEqual(result.dropped, []);
  // After the 10 % sale and 10 % quantity ladder: 4 × 243.000 + 2 × 202.500 = 1.377.000 reaches the rung.
  const orderSteps = result.groups.flatMap((group) => group.steps.filter((step) => step.campaignId === "order"));
  assert.ok(orderSteps.length > 0, "the order-value total applied");
  for (const group of result.groups) {
    // Sale, then quantity ladder, then order value: the ledger walks from the catalog price to the price paid.
    assert.deepEqual(group.steps.map((step) => step.campaignId).filter((id, index, all) => all.indexOf(id) === index), ["flash", "qty", "order"].filter((id) => group.steps.some((step) => step.campaignId === id)));
    let running = group.basePriceVnd;
    for (const step of group.steps) { assert.equal(step.inputPriceVnd, running); running = step.outputPriceVnd; }
    assert.equal(running, group.unitPriceVnd);
  }
  assert.equal(result.subtotalVnd, 1_377_000 - 150_000);

  const facts = throughCheckout(result);
  assert.ok(validateQuoteStructure(facts).ok);
  const proof = issueBenefitQuoteProof({ quote: facts, cartId: CART, secret: SECRET })!;
  assert.equal(verifyBenefitQuoteProof({ proof, cartId: CART, currentQuote: facts, secret: SECRET }).ok, true);
  // A quote with the order-value step stripped is a different quote, and the proof of the real one refuses it.
  const tampered = { ...facts, lines: facts.lines.map((line) => ({ ...line, discountSteps: line.discountSteps.filter((step) => step.campaignId !== "order") })) };
  assert.equal(verifyBenefitQuoteProof({ proof, cartId: CART, currentQuote: tampered as never, secret: SECRET }).ok, false);
});

test("a ladder reachable only BEFORE another discount is not reached, so it cannot make a valid tier step aside", () => {
  // 4 × 300.000 = 1.200.000 clears 1.100.000, but the 10 % quantity ladder takes it to 1.080.000: the
  // order ladder never applies, so neither campaign conflicts and the quantity ladder keeps its discount.
  const result = ok(priceStack({
    lines: [sline("a", 4, 300_000)],
    tiers: [participant("order", orderPct([[1_100_000, 5]])), participant("qty", qtyPct(4, 10))],
    legacyConsents: noConsent,
  }));
  assert.deepEqual(result.dropped, []);
  assert.equal(result.subtotalVnd, 1_080_000);
  assert.deepEqual(result.groups.flatMap((g) => g.steps).map((s) => s.campaignId), ["qty"]);
});

test("the same holds when an earlier discount is a Flash Sale that the ladder has no consent to stack with", () => {
  const result = ok(priceStack({
    lines: [sline("a", 4, 300_000, "p1", flash)], // 270.000 -> 1.080.000 after the sale
    tiers: [participant("order", orderPct([[1_100_000, 5]]))],
    legacyConsents: new Map([["flash", { priority: 1 }]]),
  }));
  assert.deepEqual(result.dropped, []);
  assert.equal(result.subtotalVnd, 1_080_000);
});

test("an order ladder that an EARLIER order ladder brings under its rung is idle: no conflict, the earlier one keeps its discount", () => {
  // 1.100.000 clears A (1.000.000, 20 %, first) which makes it 880.000 -- under B's 900.000 -- so B never applies.
  const result = ok(priceStack({
    lines: [sline("a", 1, 1_100_000)],
    tiers: [
      participant("a", orderPct([[1_000_000, 20]]), { priority: 1 }),
      participant("b", orderPct([[900_000, 10]]), { priority: 2 }),
    ],
    legacyConsents: noConsent,
  }));
  assert.deepEqual(result.dropped, []);
  assert.equal(result.subtotalVnd, 880_000);
  assert.deepEqual(result.groups.flatMap((g) => g.steps).map((s) => s.campaignId), ["a"]);
});

test("two order ladders that both really apply and have not agreed to stack still drop each other", () => {
  // 2.000.000: A (20 %) leaves 1.600.000, which still clears B's 900.000, so both would apply.
  const result = ok(priceStack({
    lines: [sline("a", 1, 2_000_000)],
    tiers: [
      participant("a", orderPct([[1_000_000, 20]]), { priority: 1 }),
      participant("b", orderPct([[900_000, 10]]), { priority: 2 }),
    ],
    legacyConsents: noConsent,
  }));
  assert.deepEqual(result.dropped.map((d) => [d.campaignId, d.reason]), [["a", "STACK_NOT_PERMITTED"], ["b", "STACK_NOT_PERMITTED"]]);
  assert.equal(result.subtotalVnd, 2_000_000, "nothing applied: fail closed");
});

test("the order the ladders are listed in never changes the outcome", () => {
  const tiers = [
    participant("a", orderPct([[1_000_000, 20]]), { priority: 1 }),
    participant("b", orderPct([[900_000, 10]]), { priority: 2 }),
  ];
  const run = (list: StackTierParticipant[]) => ok(priceStack({ lines: [sline("a", 1, 1_100_000)], tiers: list, legacyConsents: noConsent }));
  assert.deepEqual(run([...tiers]), run([...tiers].reverse()));
});
