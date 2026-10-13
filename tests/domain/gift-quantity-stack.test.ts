import assert from "node:assert/strict";
import test from "node:test";

import {
  applyLegacyStackStep,
  priceStack,
  STACK_PEER_ANY,
  type StackInputLine,
  type StackLegacyCampaign,
  type StackLegacyConsent,
  type StackPeer,
  type StackResult,
  type StackTierParticipant,
} from "../../src/commerce/gift-quantity-stack.ts";
import type { QuantityTierConfig } from "../../src/commerce/gift-quantity-tier.ts";
import { resolvePromotionPricing, type ApplicablePromotionCampaign } from "../../src/commerce/promotion-pricing.ts";

const NOW = new Date("2026-10-13T00:00:00Z");
const everything = () => true;
const productIn = (...ids: string[]) => (p: { productId: string }) => ids.includes(p.productId);

const flash = (extra: Partial<StackLegacyCampaign> = {}): StackLegacyCampaign => ({
  id: "flash-1", kind: "FLASH_SALE", discountType: "PERCENTAGE", percentageValue: 10, fixedPriceVnd: null, ...extra,
});
const fixed = (price: number, id = "fixed-1"): StackLegacyCampaign => ({
  id, kind: "PROMOTION", discountType: "FIXED_PRICE", percentageValue: null, fixedPriceVnd: BigInt(price),
});

function legacyOf(campaign: StackLegacyCampaign, base: number) {
  const applicable: ApplicablePromotionCampaign = { ...campaign, name: campaign.id, startsAt: null, endsAt: null };
  const result = resolvePromotionPricing({ basePriceVnd: base, campaigns: [applicable], now: NOW });
  return result.isDiscounted && result.effectivePriceVnd !== null ? { campaign, effectivePriceVnd: result.effectivePriceVnd } : null;
}

function line(lineKey: string, quantity: number, basePriceVnd: number, productId = "p1", legacy: StackLegacyCampaign | null = null): StackInputLine {
  return {
    lineKey, pancakeVariationId: `var-${lineKey}`, quantity, product: { productId, categoryKeys: [] }, basePriceVnd,
    legacy: legacy === null ? null : legacyOf(legacy, basePriceVnd),
  };
}

const pctTier = (value: number, threshold = 1): QuantityTierConfig => ({
  unit: "PERCENTAGE", discountedUnits: "ALL_ELIGIBLE_UNITS", selectionPriority: null, tiers: [{ minQuantity: threshold, discountValue: value }],
});
const vndTier = (value: number, threshold = 1): QuantityTierConfig => ({ ...pctTier(value, threshold), unit: "FIXED_AMOUNT_PER_UNIT_VND" });

function tier(id: string, config: QuantityTierConfig, opts: Partial<StackTierParticipant> = {}): StackTierParticipant {
  return { id, config, resolve: everything, priority: null, stackingEnabled: false, peers: [], ...opts };
}
const peers = (...entries: Array<[StackPeer["kind"], string]>): StackPeer[] => entries.map(([kind, campaignId]) => ({ kind, campaignId }));
const consents = (entries: Record<string, number> = {}): StackLegacyConsent =>
  new Map(Object.entries(entries).map(([id, priority]) => [id, { priority }]));

function ok(result: StackResult) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result as Extract<StackResult, { ok: true }>;
}

test("parity: with no tier campaigns the price is exactly what the legacy resolver produced", () => {
  const lines = [line("a", 2, 1_000_000, "p1", flash()), line("b", 1, 500_000, "p2"), line("c", 3, 299_999, "p3", fixed(250_000))];
  const result = ok(priceStack({ lines, tiers: [], legacyConsents: consents() }));
  assert.deepEqual(result.groups.map((group) => [group.lineKey, group.unitPriceVnd]), [["a", 900_000], ["b", 500_000], ["c", 250_000]]);
  assert.equal(result.subtotalVnd, 2 * 900_000 + 500_000 + 3 * 250_000);
  assert.deepEqual(result.dropped, []);
  assert.equal(result.groups[0]!.steps[0]!.source, "LEGACY");
  assert.deepEqual(result.groups[1]!.steps, []);
});

test("EX-09: Flash 10% then Tier 5% stacks on the remaining price: 1.000.000 -> 900.000 -> 855.000", () => {
  const result = ok(priceStack({
    lines: [line("a", 1, 1_000_000, "p1", flash())],
    tiers: [tier("tier-1", pctTier(5), { priority: 2, stackingEnabled: true, peers: peers(["FLASH_SALE", STACK_PEER_ANY]) })],
    legacyConsents: consents({ "flash-1": 1 }),
  }));
  assert.equal(result.groups[0]!.unitPriceVnd, 855_000);
  assert.deepEqual(result.groups[0]!.steps.map((step) => [step.campaignId, step.inputPriceVnd, step.outputPriceVnd, step.appliedQuantity]), [
    ["flash-1", 1_000_000, 900_000, 1],
    ["tier-1", 900_000, 855_000, 1],
  ]);
  assert.deepEqual(result.dropped, []);
});

test("priority decides the order and the order changes the money (VND tier before or after the percentage)", () => {
  const base = { stackingEnabled: true, peers: peers(["FLASH_SALE", "flash-1"]) } as const;
  const flashFirst = ok(priceStack({
    lines: [line("a", 1, 1_000_000, "p1", flash())],
    tiers: [tier("t", vndTier(100_000), { ...base, priority: 2 })],
    legacyConsents: consents({ "flash-1": 1 }),
  }));
  assert.equal(flashFirst.groups[0]!.unitPriceVnd, 800_000); // 1m -10% = 900k, -100k
  const tierFirst = ok(priceStack({
    lines: [line("a", 1, 1_000_000, "p1", flash())],
    tiers: [tier("t", vndTier(100_000), { ...base, priority: 1 })],
    legacyConsents: consents({ "flash-1": 2 }),
  }));
  assert.equal(tierFirst.groups[0]!.unitPriceVnd, 810_000); // 1m -100k = 900k, -10%
  assert.deepEqual(tierFirst.groups[0]!.steps.map((step) => step.source), ["QUANTITY_TIER", "LEGACY"]);
});

test("D-01: without the legacy campaign's consent the tier steps aside and legacy keeps its price", () => {
  const result = ok(priceStack({
    lines: [line("a", 1, 1_000_000, "p1", flash())],
    tiers: [tier("t", pctTier(5), { priority: 2, stackingEnabled: true, peers: peers(["FLASH_SALE", STACK_PEER_ANY]) })],
    legacyConsents: consents(),
  }));
  assert.equal(result.groups[0]!.unitPriceVnd, 900_000, "Flash is untouched");
  assert.deepEqual(result.dropped, [{ campaignId: "t", reason: "STACK_NOT_PERMITTED", otherCampaignId: "flash-1" }]);
});

test("D-01: the tier must also allow the legacy campaign (by kind or by id), both ways", () => {
  const run = (tierPeers: StackPeer[], stackingEnabled = true) => priceStack({
    lines: [line("a", 1, 1_000_000, "p1", flash())],
    tiers: [tier("t", pctTier(5), { priority: 2, stackingEnabled, peers: tierPeers })],
    legacyConsents: consents({ "flash-1": 1 }),
  });
  assert.equal(ok(run(peers(["FLASH_SALE", "flash-1"]))).groups[0]!.unitPriceVnd, 855_000, "by id");
  assert.equal(ok(run(peers(["FLASH_SALE", "other"]))).groups[0]!.unitPriceVnd, 900_000, "another id");
  assert.equal(ok(run(peers(["PROMOTION", STACK_PEER_ANY]))).groups[0]!.unitPriceVnd, 900_000, "another kind");
  assert.equal(ok(run(peers(["FLASH_SALE", STACK_PEER_ANY]), false)).groups[0]!.unitPriceVnd, 900_000, "stacking off");
  assert.equal(ok(run([])).groups[0]!.unitPriceVnd, 900_000, "no peers");
});

test("a tier on a line no legacy campaign touches needs no stacking configuration", () => {
  const result = ok(priceStack({
    lines: [line("a", 1, 1_000_000, "p1", flash()), line("b", 1, 400_000, "p2")],
    tiers: [tier("t", pctTier(10), { resolve: productIn("p2") })],
    legacyConsents: consents(),
  }));
  assert.deepEqual(result.groups.map((group) => [group.lineKey, group.unitPriceVnd]), [["a", 900_000], ["b", 360_000]]);
  assert.deepEqual(result.dropped, []);
});

test("two tiers on the same unit: both must allow each other and have distinct priorities", () => {
  const both = (a: Partial<StackTierParticipant>, b: Partial<StackTierParticipant>) => priceStack({
    lines: [line("a", 1, 1_000_000)],
    tiers: [tier("t1", pctTier(10), { stackingEnabled: true, peers: peers(["QUANTITY_TIER", "t2"]), priority: 1, ...a }), tier("t2", pctTier(10), { stackingEnabled: true, peers: peers(["QUANTITY_TIER", STACK_PEER_ANY]), priority: 2, ...b })],
    legacyConsents: consents(),
  });
  const stacked = ok(both({}, {}));
  assert.equal(stacked.groups[0]!.unitPriceVnd, 810_000); // 1m -10% -10%
  assert.deepEqual(stacked.dropped, []);

  const tie = ok(both({ priority: 1 }, { priority: 1 }));
  assert.equal(tie.groups[0]!.unitPriceVnd, 1_000_000, "a tie fails closed: neither is applied");
  assert.deepEqual(tie.dropped.map((d) => [d.campaignId, d.reason]), [["t1", "STACK_PRIORITY_CONFLICT"], ["t2", "STACK_PRIORITY_CONFLICT"]]);

  const missing = ok(both({ priority: null }, {}));
  assert.deepEqual(missing.dropped.map((d) => d.reason), ["STACK_PRIORITY_CONFLICT", "STACK_PRIORITY_CONFLICT"]);

  const oneWay = ok(both({ peers: [] }, {}));
  assert.deepEqual(oneWay.dropped.map((d) => d.reason), ["STACK_NOT_PERMITTED", "STACK_NOT_PERMITTED"]);
  assert.equal(oneWay.groups[0]!.unitPriceVnd, 1_000_000);

  const off = ok(both({}, { stackingEnabled: false }));
  assert.equal(off.groups[0]!.unitPriceVnd, 1_000_000);
});

test("two tiers on disjoint products do not interact and need no priority", () => {
  const result = ok(priceStack({
    lines: [line("a", 1, 100_000, "p1"), line("b", 1, 100_000, "p2")],
    tiers: [tier("t1", pctTier(10), { resolve: productIn("p1") }), tier("t2", pctTier(20), { resolve: productIn("p2") })],
    legacyConsents: consents(),
  }));
  assert.deepEqual(result.groups.map((group) => group.unitPriceVnd), [90_000, 80_000]);
  assert.deepEqual(result.dropped, []);
});

test("R-02: a legacy FIXED_PRICE inside a stack is a ceiling and never raises an already lowered price", () => {
  const run = (fixedPrice: number) => ok(priceStack({
    lines: [line("a", 1, 1_000_000, "p1", fixed(fixedPrice))],
    tiers: [tier("t", pctTier(10), { priority: 1, stackingEnabled: true, peers: peers(["PROMOTION", STACK_PEER_ANY]) })],
    legacyConsents: consents({ "fixed-1": 2 }),
  }));
  assert.equal(run(950_000).groups[0]!.unitPriceVnd, 900_000, "tier 900k then ceiling 950k leaves 900k");
  assert.equal(run(800_000).groups[0]!.unitPriceVnd, 800_000, "the ceiling lowers it further");
  assert.equal(applyLegacyStackStep(fixed(950_000), 900_000), 900_000);
  assert.equal(applyLegacyStackStep(fixed(800_000), 900_000), 800_000);
  assert.equal(applyLegacyStackStep(fixed(800_000), 700_000), 700_000);
  assert.equal(applyLegacyStackStep(flash(), 1_000_000), 900_000);
  assert.equal(applyLegacyStackStep(flash({ percentageValue: null }), 1_000_000), null);
  assert.equal(applyLegacyStackStep(fixed(0), 1_000_000), null);
  assert.equal(applyLegacyStackStep(flash(), 0), null);
});

test("EX-21: a VND tier that Flash leaves too little room for is dropped whole, then everything downstream is recomputed", () => {
  // 44.444 -> Flash 10% -> 40.000; tier 50.000 cannot leave a paid unit >= 1
  const result = ok(priceStack({
    lines: [line("a", 1, 44_444, "p1", flash())],
    tiers: [tier("t", vndTier(50_000), { priority: 2, stackingEnabled: true, peers: peers(["FLASH_SALE", STACK_PEER_ANY]) })],
    legacyConsents: consents({ "flash-1": 1 }),
  }));
  assert.equal(result.groups[0]!.unitPriceVnd, 40_000, "not clamped to 1 VND and not partially applied");
  assert.deepEqual(result.dropped, [{ campaignId: "t", reason: "TIER_PRICE_INVALID", otherCampaignId: null }]);
  assert.deepEqual(result.groups[0]!.steps.map((step) => step.source), ["LEGACY"]);
});

test("dropping an invalid tier re-runs the chain: a downstream tier is recomputed on the corrected prices and quantities", () => {
  // t1 (priority 1) is invalid on the cheap line; t2 (priority 2) would have seen t1's output.
  const lines = [line("cheap", 1, 40_000), line("rich", 1, 900_000)];
  const stackedPeers = peers(["QUANTITY_TIER", STACK_PEER_ANY]);
  const result = ok(priceStack({
    lines,
    tiers: [
      tier("t1", vndTier(50_000, 2), { priority: 1, stackingEnabled: true, peers: stackedPeers }),
      tier("t2", pctTier(10, 2), { priority: 2, stackingEnabled: true, peers: stackedPeers }),
    ],
    legacyConsents: consents(),
  }));
  assert.deepEqual(result.dropped, [{ campaignId: "t1", reason: "TIER_PRICE_INVALID", otherCampaignId: null }]);
  assert.deepEqual(result.groups.map((group) => [group.lineKey, group.unitPriceVnd]), [["cheap", 36_000], ["rich", 810_000]]);
  assert.ok(result.groups.every((group) => group.steps.every((step) => step.campaignId === "t2")));
});

test("quantity is counted per tier scope, then a tier splits a line into segments with stable distinct keys (EX-17)", () => {
  const result = ok(priceStack({
    lines: [line("v", 3, 100_001, "p1"), line("other", 5, 10_000, "p2")],
    tiers: [tier("t", { unit: "PERCENTAGE", discountedUnits: "FROM_REACHED_THRESHOLD", selectionPriority: "CHEAPEST_FIRST", tiers: [{ minQuantity: 3, discountValue: 10 }] }, { resolve: productIn("p1") })],
    legacyConsents: consents(),
  }));
  const dressGroups = result.groups.filter((group) => group.lineKey === "v");
  assert.deepEqual(dressGroups.map((group) => [group.groupKey, group.quantity, group.unitPriceVnd]), [["v:disc", 1, 90_001], ["v:full", 2, 100_001]]);
  assert.equal(dressGroups.reduce((sum, group) => sum + group.lineTotalVnd, 0), 290_003);
  assert.deepEqual(result.groups.find((group) => group.lineKey === "other")!.groupKey, "other", "an untouched line keeps its key");
  assert.equal(new Set(result.groups.map((group) => group.groupKey)).size, result.groups.length);
});

test("tier below its threshold on the cart leaves prices as they were", () => {
  const result = ok(priceStack({ lines: [line("a", 1, 100_000)], tiers: [tier("t", pctTier(10, 3))], legacyConsents: consents() }));
  assert.equal(result.groups[0]!.unitPriceVnd, 100_000);
  assert.deepEqual(result.dropped, []);
});

test("a tier campaign that is itself invalid is dropped with a reason and never prices", () => {
  const broken = tier("t", { unit: "PERCENTAGE", discountedUnits: "ALL_ELIGIBLE_UNITS", selectionPriority: null, tiers: [] });
  const result = ok(priceStack({ lines: [line("a", 1, 100_000)], tiers: [broken], legacyConsents: consents() }));
  assert.equal(result.groups[0]!.unitPriceVnd, 100_000);
  assert.deepEqual(result.dropped, [{ campaignId: "t", reason: "TIER_CONFIG_INVALID", otherCampaignId: null }]);
});

test("the result does not depend on the order lines, tiers or consents are supplied in", () => {
  const lines = [line("b", 2, 300_000, "p2", flash()), line("a", 3, 500_000, "p1"), line("c", 1, 999_999, "p1", flash())];
  const stackedPeers = { stackingEnabled: true, peers: peers(["FLASH_SALE", STACK_PEER_ANY], ["QUANTITY_TIER", STACK_PEER_ANY]) } as const;
  const tiers = [
    tier("t2", pctTier(5, 2), { ...stackedPeers, priority: 2 }),
    tier("t1", { unit: "FIXED_AMOUNT_PER_UNIT_VND", discountedUnits: "FROM_REACHED_THRESHOLD", selectionPriority: "MOST_EXPENSIVE_FIRST", tiers: [{ minQuantity: 2, discountValue: 7_001 }] }, { ...stackedPeers, priority: 3 }),
  ];
  const forward = ok(priceStack({ lines, tiers, legacyConsents: consents({ "flash-1": 1 }) }));
  const reversed = ok(priceStack({ lines: [...lines].reverse(), tiers: [...tiers].reverse(), legacyConsents: consents({ "flash-1": 1 }) }));
  assert.deepEqual(forward, reversed);
});

test("money identities: every group total equals unit x quantity, no unit is created or lost, no price below 1 VND", () => {
  const lines = [line("a", 7, 123_457, "p1", flash()), line("b", 5, 98_765, "p1"), line("c", 2, 1_000_001, "p2", fixed(900_000))];
  const result = ok(priceStack({
    lines,
    tiers: [tier("t", { unit: "PERCENTAGE", discountedUnits: "FROM_REACHED_THRESHOLD", selectionPriority: "CHEAPEST_FIRST", tiers: [{ minQuantity: 3, discountValue: 12 }] }, { resolve: productIn("p1"), priority: 5, stackingEnabled: true, peers: peers(["FLASH_SALE", STACK_PEER_ANY]) })],
    legacyConsents: consents({ "flash-1": 1 }),
  }));
  for (const group of result.groups) {
    assert.equal(group.lineTotalVnd, group.unitPriceVnd * group.quantity);
    assert.ok(group.unitPriceVnd >= 1);
  }
  for (const source of lines) {
    assert.equal(result.groups.filter((group) => group.lineKey === source.lineKey).reduce((sum, group) => sum + group.quantity, 0), source.quantity);
  }
  assert.equal(result.subtotalVnd, result.groups.reduce((sum, group) => sum + group.lineTotalVnd, 0));
});

test("invalid input is refused, not priced", () => {
  const good = line("a", 1, 100_000);
  const bad = (overrides: Partial<StackInputLine>): StackResult => priceStack({ lines: [{ ...good, ...overrides }], tiers: [], legacyConsents: consents() });
  assert.deepEqual(bad({ quantity: 0 }), { ok: false, reason: "INPUT_INVALID" });
  assert.deepEqual(bad({ basePriceVnd: 0 }), { ok: false, reason: "INPUT_INVALID" });
  assert.deepEqual(bad({ lineKey: "" }), { ok: false, reason: "INPUT_INVALID" });
  assert.deepEqual(priceStack({ lines: [], tiers: [], legacyConsents: consents() }), { ok: false, reason: "INPUT_INVALID" });
  assert.deepEqual(priceStack({ lines: [good, good], tiers: [], legacyConsents: consents() }), { ok: false, reason: "INPUT_INVALID" });
  assert.deepEqual(priceStack({ lines: [good], tiers: [tier("x", pctTier(1)), tier("x", pctTier(1))], legacyConsents: consents() }), { ok: false, reason: "INPUT_INVALID" });
  assert.deepEqual(bad({ legacy: { campaign: flash(), effectivePriceVnd: 200_000 } }), { ok: false, reason: "INPUT_INVALID" }, "legacy cannot raise a price");
  assert.deepEqual(priceStack({ lines: Array.from({ length: 201 }, (_, i) => line(`l${i}`, 1, 100)), tiers: [], legacyConsents: consents() }), { ok: false, reason: "INPUT_INVALID" });
});
