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
  resolveGiftCampaignStacking,
  stackPeersAllow,
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
  assert.deepEqual(dressGroups.map((group) => [group.groupKey, group.quantity, group.unitPriceVnd]), [["v|disc", 1, 90_001], ["v|full", 2, 100_001]]);
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

test("F08: derived group keys cannot collide with caller keys — a key that looks like a derived one is refused, and repeated splits stay unique", () => {
  const line = (lineKey: string, quantity: number, basePriceVnd: number): StackInputLine => ({
    lineKey, pancakeVariationId: `var-${lineKey}`, quantity, product: { productId: `p-${lineKey}`, categoryKeys: ["vayDam"] }, basePriceVnd, legacy: null,
  });
  const tier = (id: string, minQuantity: number): StackTierParticipant => ({
    id, config: { unit: "PERCENTAGE", discountedUnits: "FROM_REACHED_THRESHOLD", selectionPriority: "CHEAPEST_FIRST", tiers: [{ minQuantity, discountValue: 10 }] },
    resolve: () => true, priority: 1, stackingEnabled: false, peers: [],
  });
  for (const bad of ["x|disc", "x:disc", "a b", "", "x".repeat(65)]) {
    assert.deepEqual(priceStack({ lines: [line("x", 3, 100_001), line(bad, 1, 50_000)], tiers: [tier("t", 3)], legacyConsents: new Map() }), { ok: false, reason: "INPUT_INVALID" }, JSON.stringify(bad));
  }
  const result = priceStack({ lines: [line("x", 3, 100_001), line("y", 3, 100_001)], tiers: [tier("t", 3)], legacyConsents: new Map() });
  assert.ok(result.ok);
  if (!result.ok) return;
  const keys = result.groups.map((group) => group.groupKey);
  assert.equal(new Set(keys).size, keys.length, "every group key is unique");
  assert.ok(keys.every((key) => key === "x" || key === "y" || /^[xy]\|(disc|full)$/.test(key)), JSON.stringify(keys));
});

const giftPeer = (campaignId: string): StackPeer => ({ kind: "GIFT_ITEM", campaignId });

test("F02: a gift campaign can be named as a peer, by id or by wildcard", () => {
  assert.equal(stackPeersAllow([giftPeer("g2")], "GIFT_ITEM", "g2"), true);
  assert.equal(stackPeersAllow([giftPeer("g2")], "GIFT_ITEM", "g3"), false);
  assert.equal(stackPeersAllow([giftPeer(STACK_PEER_ANY)], "GIFT_ITEM", "anything"), true);
  assert.equal(stackPeersAllow([giftPeer(STACK_PEER_ANY)], "QUANTITY_TIER", "anything"), false, "the wildcard is per kind");
});

test("F02: two gift campaigns run together only when both enable stacking and each names the other", () => {
  const g = (id: string, stackingEnabled: boolean, peers: StackPeer[]) => ({ id, stackingEnabled, peers });
  // mutual consent
  assert.deepEqual(
    resolveGiftCampaignStacking([g("a", true, [giftPeer("b")]), g("b", true, [giftPeer(STACK_PEER_ANY)])]),
    { permitted: ["a", "b"], dropped: [] },
  );
  // one-way: b does not name a -> both step aside, with the other side reported
  const oneWay = resolveGiftCampaignStacking([g("a", true, [giftPeer("b")]), g("b", true, [])]);
  assert.deepEqual(oneWay.permitted, []);
  assert.deepEqual(oneWay.dropped, [
    { campaignId: "a", reason: "STACK_NOT_PERMITTED", otherCampaignId: "b" },
    { campaignId: "b", reason: "STACK_NOT_PERMITTED", otherCampaignId: "a" },
  ]);
  // naming each other is not enough while one has stacking switched off
  assert.deepEqual(resolveGiftCampaignStacking([g("a", true, [giftPeer("b")]), g("b", false, [giftPeer("a")])]).permitted, []);
  // no configuration at all: two campaigns that never opted in do not combine
  assert.deepEqual(resolveGiftCampaignStacking([g("a", false, []), g("b", false, [])]).permitted, []);
});

test("F02: a lone gift campaign always runs, a third refused pair drops only its members, and order never matters", () => {
  const g = (id: string, stackingEnabled: boolean, peers: StackPeer[]) => ({ id, stackingEnabled, peers });
  assert.deepEqual(resolveGiftCampaignStacking([g("only", false, [])]), { permitted: ["only"], dropped: [] });
  const campaigns = [
    g("a", true, [giftPeer("b")]),
    g("b", true, [giftPeer("a")]),
    g("c", false, []),
  ];
  const forward = resolveGiftCampaignStacking(campaigns);
  const backward = resolveGiftCampaignStacking([...campaigns].reverse());
  assert.deepEqual(forward, backward);
  // c conflicts with both a and b, so all three step aside; nothing is picked at random
  assert.deepEqual(forward.permitted, []);
  assert.deepEqual(forward.dropped.map((entry) => entry.campaignId), ["a", "b", "c"]);
});

test("R03: a tier that has not reached its first threshold takes no part in conflicts — it cannot cancel a valid tier's discount", () => {
  const lines = [line("a", 2, 1_000_000)];
  // A reaches (N=1) and has no stacking configuration; B overlaps the same line but needs 5 units
  const valid = tier("a-valid", pctTier(10, 1));
  const idle = tier("b-idle", pctTier(30, 5));
  for (const order of [[valid, idle], [idle, valid]]) {
    const result = ok(priceStack({ lines, tiers: order, legacyConsents: consents() }));
    assert.equal(result.groups[0]!.unitPriceVnd, 900_000, "the reached tier keeps its 10%");
    assert.deepEqual(result.dropped, [], "the idle tier is neither dropped nor reported, and it dropped nobody");
  }
  // once B does reach its threshold the pair genuinely conflicts and both step aside, as before
  const reached = ok(priceStack({ lines: [line("a", 5, 1_000_000)], tiers: [valid, idle], legacyConsents: consents() }));
  assert.equal(reached.groups[0]!.unitPriceVnd, 1_000_000);
  assert.deepEqual(reached.dropped.map((d) => [d.campaignId, d.reason]), [["a-valid", "STACK_NOT_PERMITTED"], ["b-idle", "STACK_NOT_PERMITTED"]]);
});

test("R03: an idle tier does not pull a non-consenting legacy campaign into the chain or change its price", () => {
  const flash: StackLegacyCampaign = { id: "flash", kind: "FLASH_SALE", discountType: "PERCENTAGE", percentageValue: 20, fixedPriceVnd: null };
  const result = ok(priceStack({
    lines: [line("a", 1, 1_000_000, "p1", flash)],
    tiers: [tier("idle", pctTier(30, 5))],
    legacyConsents: consents(),
  }));
  assert.equal(result.groups[0]!.unitPriceVnd, 800_000, "the running Flash Sale keeps its price");
  assert.deepEqual(result.dropped, []);
  assert.deepEqual(result.groups[0]!.steps.map((step) => step.campaignId), ["flash"]);
});

test("R03: quantity is counted over the tier's own scope, and an invalid configuration is still reported rather than treated as idle", () => {
  const onlyP2 = tier("scoped", pctTier(10, 3), { resolve: (product) => product.productId === "p2" });
  // 5 units overall but only 1 in the tier's scope: idle
  const idle = ok(priceStack({ lines: [line("a", 4, 100_000, "p1"), line("b", 1, 100_000, "p2")], tiers: [onlyP2], legacyConsents: consents() }));
  assert.deepEqual(idle.groups.map((g) => g.unitPriceVnd), [100_000, 100_000]);
  const invalid = ok(priceStack({ lines: [line("a", 1, 100_000)], tiers: [tier("bad", { ...pctTier(10), tiers: [] })], legacyConsents: consents() }));
  assert.deepEqual(invalid.dropped.map((d) => [d.campaignId, d.reason]), [["bad", "TIER_CONFIG_INVALID"]]);
});

test("R03-F1: a tier with an invalid configuration is dropped as invalid and never makes a valid tier on the same lines step aside", () => {
  // two products at 100.000d, both campaigns cover the whole cart, stacking OFF on both
  const lines = [line("a", 1, 100_000, "p1"), line("b", 1, 100_000, "p2")];
  const valid = tier("A", pctTier(10, 1));
  const invalid = tier("B", { ...pctTier(10, 1), tiers: [] });
  for (const tiers of [[valid, invalid], [invalid, valid]]) {
    const result = ok(priceStack({ lines, tiers, legacyConsents: consents() }));
    assert.equal(result.subtotalVnd, 180_000, "the valid tier still applies: 2 x 90.000d");
    assert.deepEqual(result.dropped, [{ campaignId: "B", reason: "TIER_CONFIG_INVALID", otherCampaignId: null }]);
  }
  // an invalid config is reported even when it touches no line in the cart
  const elsewhere = ok(priceStack({
    lines,
    tiers: [valid, tier("Z", { ...pctTier(10, 1), tiers: [] }, { resolve: productIn("nothing") })],
    legacyConsents: consents(),
  }));
  assert.equal(elsewhere.subtotalVnd, 180_000);
  assert.deepEqual(elsewhere.dropped.map((d) => [d.campaignId, d.reason]), [["Z", "TIER_CONFIG_INVALID"]]);
});

test("two unstacked gift campaigns: higher minimumQuantity threshold supersedes lower one", () => {
  const g = (id: string, minimumQuantity: number) => ({ id, stackingEnabled: false, peers: [], minimumQuantity });
  const buy3 = g("buy-3", 3);
  const buy4 = g("buy-4", 4);

  const forward = resolveGiftCampaignStacking([buy3, buy4]);
  assert.deepEqual(forward.permitted, ["buy-4"]);
  assert.deepEqual(forward.dropped, [{ campaignId: "buy-3", reason: "STACK_NOT_PERMITTED", otherCampaignId: "buy-4" }]);

  const reverse = resolveGiftCampaignStacking([buy4, buy3]);
  assert.deepEqual(reverse.permitted, ["buy-4"]);
  assert.deepEqual(reverse.dropped, [{ campaignId: "buy-3", reason: "STACK_NOT_PERMITTED", otherCampaignId: "buy-4" }]);
});

