import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateGiftEntitlements,
  MAX_GIFTS_PER_ORDER_TECHNICAL_CAP,
  MAX_GIFT_CAMPAIGNS,
  validateGiftSelections,
  type GiftCampaignFacts,
  type GiftEntitlement,
  type GiftOptionFacts,
  type PaidGroup,
} from "../../src/commerce/gift-quantity-entitlement.ts";
import type { ScopeConfig } from "../../src/commerce/gift-quantity-scope.ts";

const dynamic = (...categoryKeys: string[]): ScopeConfig => ({
  mode: "DYNAMIC_CATEGORY", categoryKeys, includeProductIds: [], excludeProductIds: [],
});
const GLOBAL: ScopeConfig = { mode: "GLOBAL_ALL_PAID_LINES" };

const opt = (variantId: string, productId: string, readyAvailable = 5, composite = false): GiftOptionFacts => ({ variantId, productId, composite, readyAvailable });

function qtyCampaign(n: number, extra: Partial<GiftCampaignFacts> = {}): GiftCampaignFacts {
  return {
    id: "gift-q", revision: 3, trigger: "QUANTITY", minimumQuantity: n, minimumSubtotalVnd: null, subtotalScope: null, awardMode: null,
    maxGiftsPerOrder: null, allowDuplicateGifts: false, scope: dynamic("vayDam"), frozen: null,
    options: [opt("v-red-m", "gift-p"), opt("v-black-s", "gift-p"), opt("v-other", "gift-p2")], ...extra,
  };
}
function subtotalCampaign(t: number, awardMode: "ONCE" | "REPEAT_PER_THRESHOLD", extra: Partial<GiftCampaignFacts> = {}): GiftCampaignFacts {
  return {
    id: "gift-s", revision: 1, trigger: "ORDER_SUBTOTAL", minimumQuantity: null, minimumSubtotalVnd: t, subtotalScope: "ALL_PAID_LINES", awardMode,
    maxGiftsPerOrder: null, allowDuplicateGifts: false, scope: GLOBAL, frozen: null,
    options: [opt("v-red-m", "gift-p")], ...extra,
  };
}
const paid = (groupKey: string, quantity: number, unitPriceVnd: number, categoryKey = "vayDam", productId = groupKey): PaidGroup => ({
  groupKey, quantity, unitPriceVnd, product: { productId, categoryKeys: [categoryKey] },
});

function evaluate(campaigns: GiftCampaignFacts[], groups: PaidGroup[]) {
  const result = evaluateGiftEntitlements({ campaigns, paidGroups: groups });
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as { entitlements: readonly GiftEntitlement[] }).entitlements;
}
const one = (campaign: GiftCampaignFacts, groups: PaidGroup[]) => evaluate([campaign], groups)[0]!;

test("EX-01: N=2 grants floor(Q/2) slots; boundaries Q=N-1, N, 2N, 2N+1", () => {
  const slots = (q: number) => one(qtyCampaign(2), [paid("a", q, 500_000)]).entitled;
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(slots), [0, 1, 1, 2, 2, 3]);
  assert.equal(slots(1), 0);
  assert.equal(slots(2), 1);
  assert.equal(slots(4), 2);
  assert.equal(slots(6), 3);
});

test("EX-02: N=2, Q=10, max 3 per order grants 3, not 5, and says it was capped", () => {
  const result = one(qtyCampaign(2, { maxGiftsPerOrder: 3 }), [paid("a", 10, 100_000)]);
  assert.equal(result.earned, 5);
  assert.equal(result.entitled, 3);
  assert.equal(result.cappedByMaximum, true);
  assert.equal(result.shortfallToNext, null, "nothing to advertise once the cap is reached");
});

test("with no maximum the technical cap still bounds the slots", () => {
  const result = one(qtyCampaign(1, { options: [opt("v", "p", 1_000)], allowDuplicateGifts: true }), [paid("a", 500, 10_000)]);
  assert.equal(result.entitled, MAX_GIFTS_PER_ORDER_TECHNICAL_CAP);
  assert.equal(result.cappedByMaximum, true);
});

test("EX-03: subtotal T=1.000.000 — 999.999 grants none, 1.000.000 grants one (>= boundary)", () => {
  const slots = (s: number) => one(subtotalCampaign(1_000_000, "ONCE"), [paid("a", 1, s)]).entitled;
  assert.equal(slots(999_999), 0);
  assert.equal(slots(1_000_000), 1);
  assert.equal(slots(1_000_001), 1);
});

test("EX-04: S=2.500.000, T=1.000.000 — ONCE grants 1, REPEAT_PER_THRESHOLD grants 2", () => {
  const groups = [paid("a", 1, 2_500_000)];
  assert.equal(one(subtotalCampaign(1_000_000, "ONCE"), groups).entitled, 1);
  assert.equal(one(subtotalCampaign(1_000_000, "REPEAT_PER_THRESHOLD"), groups).entitled, 2);
  const boundaries = (s: number) => one(subtotalCampaign(1_000_000, "REPEAT_PER_THRESHOLD"), [paid("a", 1, s)]).entitled;
  assert.deepEqual([999_999, 1_000_000, 1_999_999, 2_000_000, 2_000_001].map(boundaries), [0, 1, 1, 2, 2]);
});

test("EX-05: dress 600k + accessory 500k, T=1m — ALL_PAID_LINES qualifies, ELIGIBLE_PAID_LINES (dress only) does not", () => {
  const groups = [paid("dress", 1, 600_000, "vayDam"), paid("acc", 1, 500_000, "phuKien")];
  assert.equal(one(subtotalCampaign(1_000_000, "ONCE"), groups).entitled, 1);
  const eligible = subtotalCampaign(1_000_000, "ONCE", { subtotalScope: "ELIGIBLE_PAID_LINES", scope: dynamic("vayDam") });
  const result = one(eligible, groups);
  assert.equal(result.entitled, 0);
  assert.equal(result.eligibleSubtotalVnd, 600_000);
  assert.deepEqual(result.shortfallToNext, { quantity: null, subtotalVnd: 400_000 });
});

test("EX-22: global all-paid scope sums every line with no category configured", () => {
  const result = one(subtotalCampaign(1_000_000, "ONCE"), [paid("dress", 1, 600_000, "vayDam"), paid("acc", 1, 500_000, "phuKien")]);
  assert.equal(result.eligibleSubtotalVnd, 1_100_000);
  assert.equal(result.entitled, 1);
});

test("EX-06: quantity counts across variants and products inside the scope", () => {
  const groups = [paid("a-s", 1, 500_000, "vayDam", "dress-a"), paid("a-m", 1, 500_000, "vayDam", "dress-a"), paid("b-l", 1, 500_000, "vayDam", "dress-b"), paid("acc", 5, 100_000, "phuKien")];
  const result = one(qtyCampaign(3), groups);
  assert.equal(result.eligibleQuantity, 3);
  assert.equal(result.entitled, 1);
});

test("EX-10: the threshold is judged on the post-discount subtotal (960k < 1m), not the 1.2m list price", () => {
  const result = one(subtotalCampaign(1_000_000, "ONCE"), [paid("a", 1, 960_000)]);
  assert.equal(result.eligibleSubtotalVnd, 960_000);
  assert.equal(result.entitled, 0);
});

test("gifts can never raise Q or S: only paid groups exist as input and a gift-only cart earns nothing", () => {
  assert.equal(one(qtyCampaign(1), []).entitled, 0);
  assert.equal(one(subtotalCampaign(1, "ONCE"), []).entitled, 0);
});

test("EX-15: only the variants the admin allowed are selectable; out-of-stock and not-READY options are not offered", () => {
  const campaign = qtyCampaign(2, { options: [opt("red-m", "p"), opt("black-s", "p"), opt("red-l-not-ready", "p", 0)] });
  const result = one(campaign, [paid("a", 2, 100_000)]);
  assert.deepEqual(result.selectableOptions.map((option) => option.variantId), ["black-s", "red-m"]);
  const validation = validateGiftSelections({
    entitlements: [result], campaigns: [campaign], selection: [{ campaignId: "gift-q", variantId: "red-l", quantity: 1 }],
  });
  assert.deepEqual(validation, { ok: false, issues: [{ error: "VARIANT_NOT_ALLOWED", lineIndex: 0, campaignId: "gift-q", variantId: null }] });
  const notReady = validateGiftSelections({
    entitlements: [result], campaigns: [campaign], selection: [{ campaignId: "gift-q", variantId: "red-l-not-ready", quantity: 1 }],
  });
  assert.equal(notReady.ok, false);
  assert.equal(!notReady.ok && notReady.issues[0]!.error, "OUT_OF_STOCK");
});

test("R-03: with duplicates off at most one unit per product even across variants; on, several are allowed within entitlement and stock", () => {
  const off = qtyCampaign(2, { options: [opt("red-m", "p"), opt("black-s", "p"), opt("other", "p2")] });
  const offEntitlement = one(off, [paid("a", 4, 100_000)]); // 2 slots
  assert.equal(offEntitlement.entitled, 2);
  const sameProduct = validateGiftSelections({
    entitlements: [offEntitlement], campaigns: [off],
    selection: [{ campaignId: "gift-q", variantId: "red-m", quantity: 1 }, { campaignId: "gift-q", variantId: "black-s", quantity: 1 }],
  });
  assert.deepEqual(sameProduct, { ok: false, issues: [{ error: "DUPLICATE_PRODUCT_NOT_ALLOWED", lineIndex: null, campaignId: "gift-q", variantId: null }] });
  const twoQuantity = validateGiftSelections({
    entitlements: [offEntitlement], campaigns: [off], selection: [{ campaignId: "gift-q", variantId: "red-m", quantity: 2 }],
  });
  assert.equal(!twoQuantity.ok && twoQuantity.issues[0]!.error, "DUPLICATE_PRODUCT_NOT_ALLOWED");
  const differentProducts = validateGiftSelections({
    entitlements: [offEntitlement], campaigns: [off],
    selection: [{ campaignId: "gift-q", variantId: "red-m", quantity: 1 }, { campaignId: "gift-q", variantId: "other", quantity: 1 }],
  });
  assert.equal(differentProducts.ok, true);

  const on = qtyCampaign(2, { options: off.options, allowDuplicateGifts: true });
  const onEntitlement = one(on, [paid("a", 4, 100_000)]);
  const duplicates = validateGiftSelections({
    entitlements: [onEntitlement], campaigns: [on], selection: [{ campaignId: "gift-q", variantId: "red-m", quantity: 2 }],
  });
  assert.equal(duplicates.ok, true);
});

test("duplicates off: grantable is limited by the number of distinct products that have stock", () => {
  const campaign = qtyCampaign(1, { options: [opt("a1", "pa"), opt("a2", "pa"), opt("b1", "pb")] });
  const result = one(campaign, [paid("x", 5, 100_000)]); // earned 5
  assert.equal(result.entitled, 5);
  assert.equal(result.grantable, 2, "two distinct products");
  assert.equal(result.unfulfillableForStock, 3);
});

test("EX-11: earned 3 but stock gives 1 — buying 1 and confirming the shortfall is valid and records 2 unclaimed for stock", () => {
  const campaign = qtyCampaign(2, { options: [opt("only", "p", 1)], allowDuplicateGifts: true });
  const result = one(campaign, [paid("a", 6, 100_000)]);
  assert.equal(result.entitled, 3);
  assert.equal(result.grantable, 1);
  const validation = validateGiftSelections({
    entitlements: [result], campaigns: [campaign], selection: [{ campaignId: "gift-q", variantId: "only", quantity: 1 }],
  });
  assert.equal(validation.ok, true);
  const summary = (validation as unknown as { summaries: readonly { requiresAcknowledgement: boolean; unclaimed: number; shortForStock: number; skippedWhileAvailable: number }[] }).summaries[0]!;
  assert.deepEqual(
    { requiresAcknowledgement: summary.requiresAcknowledgement, unclaimed: summary.unclaimed, shortForStock: summary.shortForStock, skippedWhileAvailable: summary.skippedWhileAvailable },
    { requiresAcknowledgement: true, unclaimed: 2, shortForStock: 2, skippedWhileAvailable: 0 },
  );
});

test("EX-12: earned 2, stock available, buyer takes none — allowed, with an acknowledgement for the 2 skipped slots", () => {
  const campaign = qtyCampaign(2, { options: [opt("a", "pa"), opt("b", "pb")] });
  const result = one(campaign, [paid("x", 4, 100_000)]);
  const validation = validateGiftSelections({ entitlements: [result], campaigns: [campaign], selection: [] });
  assert.equal(validation.ok, true);
  const [summary] = (validation as unknown as { summaries: readonly { selected: number; unclaimed: number; skippedWhileAvailable: number; shortForStock: number; requiresAcknowledgement: boolean }[] }).summaries;
  assert.deepEqual(summary, { campaignId: "gift-q", revision: 3, entitled: 2, selected: 0, unclaimed: 2, skippedWhileAvailable: 2, shortForStock: 0, requiresAcknowledgement: true });
});

test("taking every slot needs no acknowledgement", () => {
  const campaign = qtyCampaign(2, { options: [opt("a", "pa"), opt("b", "pb")] });
  const result = one(campaign, [paid("x", 4, 100_000)]);
  const validation = validateGiftSelections({
    entitlements: [result], campaigns: [campaign],
    selection: [{ campaignId: "gift-q", variantId: "a", quantity: 1 }, { campaignId: "gift-q", variantId: "b", quantity: 1 }],
  });
  assert.equal(validation.ok, true);
  assert.equal((validation as unknown as { summaries: readonly { requiresAcknowledgement: boolean }[] }).summaries[0]!.requiresAcknowledgement, false);
});

test("selection above the entitlement, for a campaign with no slots, or malformed is refused", () => {
  const campaign = qtyCampaign(2, { options: [opt("a", "pa"), opt("b", "pb"), opt("c", "pc")] });
  const result = one(campaign, [paid("x", 2, 100_000)]); // 1 slot
  const over = validateGiftSelections({
    entitlements: [result], campaigns: [campaign],
    selection: [{ campaignId: "gift-q", variantId: "a", quantity: 1 }, { campaignId: "gift-q", variantId: "b", quantity: 1 }],
  });
  assert.deepEqual(over, { ok: false, issues: [{ error: "OVER_ENTITLEMENT", lineIndex: null, campaignId: "gift-q", variantId: null }] });

  const empty = one(campaign, [paid("x", 1, 100_000)]); // 0 slots
  assert.equal(
    (validateGiftSelections({ entitlements: [empty], campaigns: [campaign], selection: [{ campaignId: "gift-q", variantId: "a", quantity: 1 }] }) as unknown as { issues: { error: string }[] }).issues[0]!.error,
    "CAMPAIGN_NOT_ENTITLED",
  );
  assert.equal(
    (validateGiftSelections({ entitlements: [result], campaigns: [campaign], selection: [{ campaignId: "unknown", variantId: "a", quantity: 1 }] }) as unknown as { issues: { error: string }[] }).issues[0]!.error,
    "CAMPAIGN_NOT_ENTITLED",
    "a forged campaign id is not entitled",
  );
  for (const bad of [{ quantity: 0 }, { quantity: -1 }, { quantity: 1.5 }]) {
    const outcome = validateGiftSelections({ entitlements: [result], campaigns: [campaign], selection: [{ campaignId: "gift-q", variantId: "a", ...bad }] });
    assert.equal(!outcome.ok && outcome.issues[0]!.error, "SELECTION_INVALID");
  }
  const dup = validateGiftSelections({
    entitlements: [result], campaigns: [campaign],
    selection: [{ campaignId: "gift-q", variantId: "a", quantity: 1 }, { campaignId: "gift-q", variantId: "a", quantity: 1 }],
  });
  assert.equal(!dup.ok && dup.issues[0]!.error, "SELECTION_INVALID", "the same line twice is malformed, not summed");
  const tooMany = validateGiftSelections({
    entitlements: [result], campaigns: [campaign],
    selection: Array.from({ length: 101 }, (_, i) => ({ campaignId: "gift-q", variantId: `v${i}`, quantity: 1 })),
  });
  assert.equal(!tooMany.ok && tooMany.issues[0]!.error, "SELECTION_INVALID");
});

test("physical stock is one pool across campaigns: the same variant under two campaigns cannot exceed it", () => {
  const a = qtyCampaign(1, { id: "gift-a", options: [opt("shared", "p", 1)] });
  const b = qtyCampaign(1, { id: "gift-b", options: [opt("shared", "p", 1)] });
  const entitlements = evaluate([a, b], [paid("x", 2, 100_000)]);
  const both = validateGiftSelections({
    entitlements, campaigns: [a, b],
    selection: [{ campaignId: "gift-a", variantId: "shared", quantity: 1 }, { campaignId: "gift-b", variantId: "shared", quantity: 1 }],
  });
  assert.deepEqual(both, { ok: false, issues: [{ error: "OUT_OF_STOCK", lineIndex: null, campaignId: null, variantId: "shared" }] });
});

test("each gift campaign counts on its own: one campaign's gifts never help another reach its threshold", () => {
  const a = qtyCampaign(2, { id: "gift-a" });
  const b = qtyCampaign(3, { id: "gift-b" });
  const entitlements = evaluate([b, a], [paid("x", 4, 100_000)]);
  assert.deepEqual(entitlements.map((entry) => [entry.campaignId, entry.entitled]), [["gift-a", 2], ["gift-b", 1]], "sorted by id, independent");
});

test("a Fixed scope matches only its frozen products; an unfrozen one grants nothing", () => {
  const fixedScope: ScopeConfig = { mode: "FIXED_PRODUCT_SET", categoryKeys: ["vayDam"], includeProductIds: [], excludeProductIds: [] };
  const groups = [paid("a", 2, 100_000, "vayDam", "old"), paid("b", 2, 100_000, "vayDam", "new")];
  const frozen = { productIds: ["old"], frozenAt: new Date(0), campaignRevision: 2 };
  assert.equal(one(qtyCampaign(1, { scope: fixedScope, frozen }), groups).eligibleQuantity, 2);
  assert.equal(one(qtyCampaign(1, { scope: fixedScope, frozen: null }), groups).entitled, 0);
});

test("next-slot hint: how much more quantity or subtotal reaches the next slot", () => {
  assert.deepEqual(one(qtyCampaign(3), [paid("a", 4, 1)]).shortfallToNext, { quantity: 2, subtotalVnd: null });
  assert.deepEqual(one(qtyCampaign(3), [paid("a", 3, 1)]).shortfallToNext, { quantity: 3, subtotalVnd: null });
  assert.deepEqual(one(subtotalCampaign(1_000_000, "REPEAT_PER_THRESHOLD"), [paid("a", 1, 1_300_000)]).shortfallToNext, { quantity: null, subtotalVnd: 700_000 });
  assert.equal(one(subtotalCampaign(1_000_000, "ONCE"), [paid("a", 1, 1_300_000)]).shortfallToNext, null, "ONCE has no further slot");
});

test("invalid campaigns or paid groups are refused rather than evaluated", () => {
  const bad = (campaigns: GiftCampaignFacts[], groups: PaidGroup[] = []) => evaluateGiftEntitlements({ campaigns, paidGroups: groups });
  assert.equal(bad([qtyCampaign(0)]).ok, false);
  assert.equal(bad([qtyCampaign(2, { scope: GLOBAL })]).ok, false, "quantity trigger needs a real scope");
  assert.equal(bad([subtotalCampaign(1_000_000, "ONCE", { scope: dynamic("vayDam") })]).ok, false, "ALL_PAID_LINES needs global");
  assert.equal(bad([subtotalCampaign(1_000_000, "ONCE", { subtotalScope: "ELIGIBLE_PAID_LINES" })]).ok, false, "ELIGIBLE needs a real scope");
  assert.equal(bad([subtotalCampaign(0, "ONCE")]).ok, false);
  assert.equal(bad([qtyCampaign(2, { maxGiftsPerOrder: 0 })]).ok, false);
  assert.equal(bad([qtyCampaign(2, { options: [opt("a", "p"), opt("a", "p")] })]).ok, false);
  assert.equal(bad([qtyCampaign(2, { options: [opt("a", "p", -1)] })]).ok, false);
  assert.equal(bad([qtyCampaign(2), qtyCampaign(2)]).ok, false, "duplicate campaign id");
  assert.equal(bad(Array.from({ length: MAX_GIFT_CAMPAIGNS + 1 }, (_, i) => qtyCampaign(2, { id: `c${i}` }))).ok, false);
  assert.equal(bad([qtyCampaign(2)], [paid("a", 0, 100)]).ok, false);
  assert.equal(bad([qtyCampaign(2)], [paid("a", 1, 0)]).ok, false, "a paid price can never be 0");
  assert.equal(bad([qtyCampaign(2)], [paid("a", 1, 100), paid("a", 1, 100)]).ok, false);
  assert.equal(bad([qtyCampaign(2)], [paid("a", Number.MAX_SAFE_INTEGER, 2)]).ok, false, "overflow is refused");
});

test("entitlement carries the campaign id and revision; a selection made under another revision is stale", () => {
  const campaign = qtyCampaign(2, { revision: 7, options: [opt("a", "pa"), opt("b", "pb")] });
  const result = one(campaign, [paid("x", 2, 100_000)]);
  assert.equal(result.campaignId, "gift-q");
  assert.equal(result.revision, 7);
  const ok = validateGiftSelections({ entitlements: [result], campaigns: [campaign], selection: [{ campaignId: "gift-q", variantId: "a", quantity: 1, campaignRevision: 7 }] });
  assert.equal(ok.ok, true);
  const stale = validateGiftSelections({ entitlements: [result], campaigns: [campaign], selection: [{ campaignId: "gift-q", variantId: "a", quantity: 1, campaignRevision: 6 }] });
  assert.deepEqual(stale, { ok: false, issues: [{ error: "STALE_CAMPAIGN_REVISION", lineIndex: 0, campaignId: "gift-q", variantId: null }] });
  // The campaign was edited after the entitlement was computed.
  const edited = validateGiftSelections({ entitlements: [result], campaigns: [{ ...campaign, revision: 8 }], selection: [{ campaignId: "gift-q", variantId: "a", quantity: 1 }] });
  assert.equal(!edited.ok && edited.issues[0]!.error, "STALE_CAMPAIGN_REVISION");
});

test("R-04: composite variants are never selectable even with stock", () => {
  const campaign = qtyCampaign(1, { options: [opt("set", "p", 9, true), opt("simple", "p2", 2)] });
  const result = one(campaign, [paid("x", 3, 100_000)]);
  assert.deepEqual(result.selectableOptions.map((option) => option.variantId), ["simple"]);
  assert.equal(result.grantable, 1, "distinct selectable products only");
  const outcome = validateGiftSelections({ entitlements: [result], campaigns: [campaign], selection: [{ campaignId: "gift-q", variantId: "set", quantity: 1 }] });
  assert.equal(!outcome.ok && outcome.issues[0]!.error, "VARIANT_NOT_ALLOWED");
});

test("result and issues do not depend on input order; forged ids are not echoed", () => {
  const a = qtyCampaign(2, { id: "gift-a", options: [opt("z", "pz"), opt("a", "pa")] });
  const b = subtotalCampaign(1_000_000, "REPEAT_PER_THRESHOLD", { id: "gift-b" });
  const groups = [paid("g1", 2, 400_000), paid("g2", 3, 250_000, "phuKien"), paid("g3", 1, 90_001)];
  const forward = evaluateGiftEntitlements({ campaigns: [a, b], paidGroups: groups });
  const reverse = evaluateGiftEntitlements({ campaigns: [b, a], paidGroups: [...groups].reverse() });
  assert.deepEqual(forward, reverse);
  assert.deepEqual((forward as unknown as { entitlements: GiftEntitlement[] }).entitlements[0]!.selectableOptions.map((option) => option.variantId), ["a", "z"]);

  const entitlements = evaluate([a], groups);
  const forged = validateGiftSelections({
    entitlements, campaigns: [a],
    selection: [
      { campaignId: "FORGED-<script>", variantId: "x", quantity: 1 },
      { campaignId: "gift-a", variantId: "FORGED-VARIANT", quantity: 1 },
      { campaignId: "gift-a", variantId: "z", quantity: 1.5 },
    ],
  });
  assert.equal(forged.ok, false);
  assert.doesNotMatch(JSON.stringify(forged), /FORGED/);
  assert.deepEqual(!forged.ok && forged.issues.map((issue) => [issue.error, issue.lineIndex]), [["CAMPAIGN_NOT_ENTITLED", 0], ["SELECTION_INVALID", 2], ["VARIANT_NOT_ALLOWED", 1]]);
  const reversed = validateGiftSelections({ entitlements, campaigns: [a], selection: [
    { campaignId: "gift-a", variantId: "z", quantity: 1 }, { campaignId: "gift-a", variantId: "a", quantity: 1 },
  ] });
  const swapped = validateGiftSelections({ entitlements, campaigns: [a], selection: [
    { campaignId: "gift-a", variantId: "a", quantity: 1 }, { campaignId: "gift-a", variantId: "z", quantity: 1 },
  ] });
  assert.deepEqual(reversed, swapped);
});

test("malformed selection lines never throw", () => {
  const campaign = qtyCampaign(1);
  const entitlements = evaluate([campaign], [paid("x", 1, 100)]);
  for (const line of [null, undefined, 7, "x", {}, { campaignId: 1, variantId: 2, quantity: "1" }]) {
    const outcome = validateGiftSelections({ entitlements, campaigns: [campaign], selection: [line as never] });
    assert.equal(!outcome.ok && outcome.issues[0]!.error, "SELECTION_INVALID");
  }
  const notAnArray = validateGiftSelections({ entitlements, campaigns: [campaign], selection: "x" as never });
  assert.equal(notAnArray.ok, false);
});

test("money is exact: BigInt T from the database, large safe sums, and unsafe totals are refused", () => {
  const big = subtotalCampaign(1_000_000, "REPEAT_PER_THRESHOLD", { minimumSubtotalVnd: BigInt(1_000_000) });
  const exact = one(big, [paid("a", 3, 333_333)]); // 999_999
  assert.equal(exact.entitled, 0);
  assert.equal(one(big, [paid("a", 3, 333_334)]).entitled, 1); // 1_000_002
  const huge = one(subtotalCampaign(1, "REPEAT_PER_THRESHOLD", { maxGiftsPerOrder: 5 }), [paid("a", 1, Number.MAX_SAFE_INTEGER)]);
  assert.equal(huge.eligibleSubtotalVnd, Number.MAX_SAFE_INTEGER);
  assert.equal(huge.entitled, 5);
  assert.equal(huge.cappedByMaximum, true);
  const refused = (campaign: GiftCampaignFacts, groups: PaidGroup[]) => evaluateGiftEntitlements({ campaigns: [campaign], paidGroups: groups }).ok;
  assert.equal(refused(subtotalCampaign(1, "ONCE"), [paid("a", 1, Number.MAX_SAFE_INTEGER), paid("b", 1, 1)]), false);
  assert.equal(refused(subtotalCampaign(1, "ONCE", { minimumSubtotalVnd: BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1) }), [paid("a", 1, 1)]), false);
  assert.equal(refused(subtotalCampaign(1, "ONCE", { minimumSubtotalVnd: BigInt(0) }), [paid("a", 1, 1)]), false);
  assert.equal(refused(subtotalCampaign(1, "ONCE", { minimumSubtotalVnd: 1.5 }), [paid("a", 1, 1)]), false);
});

test("a gift unit in the input is just another paid group: the engine has no gift channel, and paid-only totals decide", () => {
  const campaign = qtyCampaign(2, { options: [opt("g", "gp")] });
  // 3 paid units buy 1 slot; the one gift the buyer would take is not part of any input and cannot make it 2.
  const result = one(campaign, [paid("x", 3, 100_000)]);
  assert.equal(result.eligibleQuantity, 3);
  assert.equal(result.entitled, 1);
  const validation = validateGiftSelections({ entitlements: [result], campaigns: [campaign], selection: [{ campaignId: "gift-q", variantId: "g", quantity: 1 }] });
  assert.equal(validation.ok, true);
  assert.equal(one(campaign, [paid("x", 3, 100_000)]).eligibleQuantity, 3, "selecting a gift changes nothing");
});
