import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import ts from "typescript";
import type { CartGiftState } from "../../src/commerce/cart-gift-selection.ts";
import { buildCartPromotionView } from "../../src/routes/cart-promotion-model.ts";

import type { GiftQuantityCandidateReadClient } from "../../src/commerce/gift-quantity-candidate-repository.ts";
import {
  MAX_QUOTE_CART_ITEMS,
  MAX_QUOTE_ITEM_QUANTITY,
  resolveGiftQuantityQuote as resolveQuote,
  MAX_QUANTITY_PROGRESS_TRIALS,
  validateQuoteCartItems,
  type QuoteCartLine,
} from "../../src/commerce/gift-quantity-quote.ts";

const ON = { LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true" } as const;
const NOW = new Date("2026-10-13T12:00:00.000Z");
const PAST = new Date("2026-10-01T00:00:00.000Z");

// Unit fixtures have unlimited sellability; repository/database tests supply the real authority.
const resolveGiftQuantityQuote = (input: Parameters<typeof resolveQuote>[0]) => resolveQuote({ canAddQuantity: () => true, ...input });

function tierRecord(id: string, tiers: Array<[number, number]>) {
  return {
    id, kind: "QUANTITY_TIER", name: id, startsAt: PAST, endsAt: null, isEnabled: true, enabledAt: PAST, disabledAt: null,
    revision: 7, stackPriority: null, stackingEnabled: false, scopeMode: "GLOBAL_ALL_PAID_LINES", categoryKeys: [],
    frozenAt: null, frozenCampaignRevision: null, giftTrigger: null, minimumQuantity: null, minimumSubtotalVnd: null,
    subtotalScope: null, awardMode: null, maxGiftsPerOrder: null, allowDuplicateGifts: null,
    tierUnit: "PERCENTAGE", tierDiscountedUnits: "ALL_ELIGIBLE_UNITS", tierSelectionPriority: null,
    targets: [], tiers: tiers.map(([minQuantity, discountValue]) => ({ minQuantity, discountValue })), giftOptions: [], stackPeers: [],
  };
}

function fakeClient(records: unknown[], counter: { calls: string[] } = { calls: [] }): GiftQuantityCandidateReadClient {
  return {
    giftQuantityCampaign: { findMany: async () => { counter.calls.push("campaign"); return records as never; } },
    giftQuantityFrozenProduct: { findMany: async () => { counter.calls.push("frozen"); return []; } },
    productCategoryMembership: { findMany: async () => { counter.calls.push("membership"); return []; } },
  };
}

const line = (variantId: string, quantity: number, basePriceVnd = 100_000): QuoteCartLine => ({
  variantId, pancakeVariationId: `pv-${variantId}`, productId: `p-${variantId}`, quantity, basePriceVnd, legacy: null,
});

test("quantity progress follows the stored ladder at 2 → 3 → 4 → 5 without discounting early", async () => {
  for (const quantity of [2, 3, 4, 5]) {
    const quote = await resolveGiftQuantityQuote({ lines: [line("a", quantity)], now: NOW, client: fakeClient([tierRecord("five", [[5, 10]])]), env: ON });
    assert.ok(quote.enabled && quote.ok);
    assert.equal(quote.subtotalVnd, quantity === 5 ? 450_000 : quantity * 100_000);
    assert.deepEqual(quote.quantityProgress, quantity === 5 ? [] : [{
      campaignId: "five", currentQuantity: quantity, reachedThresholdQuantity: null,
      discountedUnits: "ALL_ELIGIBLE_UNITS",
      next: { thresholdQuantity: 5, unit: "PERCENTAGE", value: 10, shortfallQuantity: 5 - quantity },
    }]);
  }
});

test("price-only calls with no capacity authority cannot promise quantity milestones", async () => {
  const quote = await resolveQuote({ lines: [line("a", 4)], now: NOW, client: fakeClient([tierRecord("five", [[5, 10]])]), env: ON });
  assert.ok(quote.enabled && quote.ok);
  assert.deepEqual(quote.quantityProgress, []);
  assert.equal(quote.subtotalVnd, 400_000);
});

test("50 campaigns × 50 lines reuse identical additions and obey the quote-wide trial budget", async () => {
  for (const differentThresholds of [false, true]) {
    let probes = 0;
    const quote = await resolveGiftQuantityQuote({
      lines: Array.from({ length: 50 }, (_, i) => line(`v${i}`, 1)), now: NOW, env: ON,
      client: fakeClient(Array.from({ length: 50 }, (_, i) => tierRecord(`tier${i}`, [[differentThresholds ? 51 + i : 51, 10]]))),
      canAddQuantity: () => { probes++; return true; },
      preservesQuantityGifts: () => false,
    });
    assert.ok(quote.enabled && quote.ok);
    assert.deepEqual(quote.quantityProgress, []);
    assert.equal(probes, MAX_QUANTITY_PROGRESS_TRIALS, "at most 50 unique additions reach pricing, never 2.500");
    assert.equal(quote.subtotalVnd, 5_000_000);
  }
});

test("campaigns sharing a milestone price each identical addition once", async () => {
  let probes = 0;
  const quote = await resolveGiftQuantityQuote({ lines: [line("a", 2), line("b", 2)], now: NOW, env: ON,
    client: fakeClient([tierRecord("first", [[5, 10]]), tierRecord("second", [[5, 10]])]),
    canAddQuantity: () => { probes++; return true; },
  });
  assert.ok(quote.enabled && quote.ok);
  assert.equal(probes, 2, "two campaigns share two additions; not four separate priceStack calls");
  assert.deepEqual(quote.quantityProgress, []);
});

test("quantity progress counts scoped paid units and skips equal-value rungs", async () => {
  const record = { ...tierRecord("scoped", [[3, 5], [5, 5], [8, 12]]), scopeMode: "DYNAMIC_CATEGORY", categoryKeys: [], targets: [{ productId: "p-a", role: "INCLUDE" }] };
  const quote = await resolveGiftQuantityQuote({ lines: [line("a", 4), line("outside", 20)], now: NOW, client: fakeClient([record]), env: ON });
  assert.ok(quote.enabled && quote.ok);
  assert.deepEqual(quote.quantityProgress, [{
    campaignId: "scoped", currentQuantity: 4, reachedThresholdQuantity: 3, discountedUnits: "ALL_ELIGIBLE_UNITS",
    next: { thresholdQuantity: 8, unit: "PERCENTAGE", value: 12, shortfallQuantity: 4 },
  }]);
  const outside = await resolveGiftQuantityQuote({ lines: [line("outside", 4)], now: NOW, client: fakeClient([record]), env: ON });
  assert.ok(outside.enabled && outside.ok);
  assert.deepEqual(outside.quantityProgress, []);
});

test("quantity progress promises no milestone that would conflict with another campaign at that quantity", async () => {
  for (const activeThreshold of [1, 5]) {
    const first = tierRecord("first", [[activeThreshold, 5]]);
    const next = tierRecord("next", [[5, 10]]);
    const quote = await resolveGiftQuantityQuote({ lines: [line("a", 4)], now: NOW, client: fakeClient([first, next]), env: ON });
    assert.ok(quote.enabled && quote.ok);
    assert.equal(quote.subtotalVnd, activeThreshold === 1 ? 380_000 : 400_000);
    assert.deepEqual(quote.quantityProgress, [], "idle tiers must also obey stacking at the advertised threshold");
  }
});

test("quantity progress needs mutual consent and distinct priorities, then advertises both active and idle ladders", async () => {
  for (const [consented, priority, expected] of [[false, 2, false], [true, 1, false], [true, 2, true]] as const) {
    const first = { ...tierRecord("first", [[1, 5]]), stackingEnabled: true, stackPriority: 1, stackPeers: [{ peerKind: "QUANTITY_TIER", peerCampaignId: "next" }] };
    const next = { ...tierRecord("next", [[5, 10]]), stackingEnabled: consented, stackPriority: priority, stackPeers: [{ peerKind: "QUANTITY_TIER", peerCampaignId: "first" }] };
    const quote = await resolveGiftQuantityQuote({ lines: [line("a", 4)], now: NOW, client: fakeClient([first, next]), env: ON });
    assert.ok(quote.enabled && quote.ok);
    assert.deepEqual(quote.quantityProgress.map((entry) => entry.campaignId), expected ? ["next"] : []);
    assert.equal(quote.subtotalVnd, 380_000, "a progress probe never changes the actual paid quote");
  }
});

test("quantity progress does not advertise invalid prices or invalid campaigns", async () => {
  const invalidPrice = { ...tierRecord("fixed", [[5, 100_000]]), tierUnit: "FIXED_AMOUNT_PER_UNIT_VND" };
  for (const campaign of [invalidPrice, tierRecord("bad", [[5, 100]])]) {
    const quote = await resolveGiftQuantityQuote({ lines: [line("a", 4)], now: NOW, client: fakeClient([campaign]), env: ON });
    assert.ok(quote.enabled && quote.ok);
    assert.deepEqual(quote.quantityProgress, []);
  }
});

test("quantity progress uses the legacy campaign's consent without changing its charged price", async () => {
  const legacy = {
    campaign: { id: "flash", kind: "FLASH_SALE", discountType: "PERCENTAGE", percentageValue: 10, fixedPriceVnd: null } as NonNullable<QuoteCartLine["legacy"]>["campaign"],
    effectivePriceVnd: 90_000,
  };
  const tier = { ...tierRecord("next", [[5, 10]]), stackPriority: 2, stackingEnabled: true, stackPeers: [{ peerKind: "FLASH_SALE", peerCampaignId: "flash" }] };
  for (const consented of [false, true]) {
    const quote = await resolveGiftQuantityQuote({ lines: [{ ...line("a", 4), legacy }], now: NOW, client: fakeClient([tier]), env: ON,
      readLegacyConsents: async () => consented ? new Map([["flash", { priority: 1 }]]) : new Map(),
    });
    assert.ok(quote.enabled && quote.ok);
    assert.equal(quote.subtotalVnd, 360_000);
    assert.equal(quote.quantityProgress.length, consented ? 1 : 0);
  }
});

for (const { fixedPriceVnd, discount, expectedProgress, expectedFutureTotal } of [
  { fixedPriceVnd: 50_000, discount: 10, expectedProgress: false, expectedFutureTotal: 250_000 },
  { fixedPriceVnd: 90_000, discount: 20, expectedProgress: true, expectedFutureTotal: 400_000 },
]) {
  test(`legacy FIXED_PRICE ${fixedPriceVnd} after tier ${discount}%: quote and banner use the real additional saving`, async () => {
    const legacy = { campaign: { id: "ceiling", kind: "FLASH_SALE", discountType: "FIXED_PRICE", percentageValue: null, fixedPriceVnd: BigInt(fixedPriceVnd) } as NonNullable<QuoteCartLine["legacy"]>["campaign"], effectivePriceVnd: fixedPriceVnd };
    const tier = { ...tierRecord("next", [[5, discount]]), stackingEnabled: true, stackPriority: 1,
      stackPeers: [{ peerKind: "FLASH_SALE", peerCampaignId: "ceiling" }] };
    const quote = async (quantity: number, includeTier = true) => {
      const result = await resolveGiftQuantityQuote({ lines: [{ ...line("a", quantity), legacy }], now: NOW, env: ON,
        client: fakeClient(includeTier ? [tier] : []), readLegacyConsents: async () => new Map([["ceiling", { priority: 2 }]]),
      });
      assert.ok(result.enabled && result.ok);
      return result;
    };
    const current = await quote(4);
    const reached = await quote(5);
    const withoutTier = await quote(5, false);
    assert.equal(current.subtotalVnd, fixedPriceVnd * 4);
    assert.equal(reached.subtotalVnd, expectedFutureTotal);
    assert.equal(withoutTier.subtotalVnd - reached.subtotalVnd, expectedProgress ? 50_000 : 0);
    assert.deepEqual(reached.dropped, []);
    assert.equal(reached.groups.some((group) => group.steps.some((step) => step.source === "LEGACY" && step.campaignId === "ceiling")), !expectedProgress,
      "the legacy ledger step disappears only when the tier beats its price ceiling");
    assert.equal(current.quantityProgress.length, expectedProgress ? 1 : 0);
    const view = buildCartPromotionView({ quote: { benefits: current }, entitlements: [], selections: [], campaigns: [] } as unknown as CartGiftState);
    assert.equal(view?.items.some((item) => item.state === "progress" && item.kind === "TIER") ?? false, expectedProgress);
    if (expectedProgress) assert.equal(view!.items[0]!.title, "Mua thêm 1 sản phẩm áp dụng để được giảm 20%");
  });
}

test("an already-earned tier is the baseline: its next rung must add a real saving", async () => {
  // Both 6% and 7% on 10 VND round to 9 VND. Removing the whole campaign would falsely
  // attribute its already-earned 1 VND/unit saving to the next rung.
  const quote = await resolveGiftQuantityQuote({ lines: [line("a", 4, 10)], now: NOW, env: ON, client: fakeClient([tierRecord("next", [[3, 6], [5, 7]])]) });
  assert.ok(quote.enabled && quote.ok);
  assert.equal(quote.subtotalVnd, 36);
  assert.deepEqual(quote.quantityProgress, [], "7% saves nothing beyond the already-earned 6% after canonical rounding");
});

test("an explicit conflict dropping an earned tier still blocks a financially better milestone", async () => {
  const first = { ...tierRecord("earned", [[1, 5]]), scopeMode: "DYNAMIC_CATEGORY", targets: [{ productId: "p-a", role: "INCLUDE" }] };
  const next = { ...tierRecord("next", [[3, 50]]), scopeMode: "DYNAMIC_CATEGORY", targets: [{ productId: "p-b", role: "INCLUDE" }],
    stackingEnabled: true, stackPriority: 2, stackPeers: [{ peerKind: "QUANTITY_TIER", peerCampaignId: "conflict" }] };
  const conflict = { ...tierRecord("conflict", [[4, 1]]), stackingEnabled: true, stackPriority: 3,
    stackPeers: [{ peerKind: "QUANTITY_TIER", peerCampaignId: "next" }] };
  const quote = async (bQuantity: number) => {
    const result = await resolveGiftQuantityQuote({ lines: [line("a", 1), line("b", bQuantity)], now: NOW, env: ON, client: fakeClient([first, next, conflict]) });
    assert.ok(result.enabled && result.ok);
    return result;
  };
  const current = await quote(2), future = await quote(3);
  assert.equal(current.subtotalVnd, 295_000);
  assert.equal(future.subtotalVnd, 250_000);
  assert.ok(future.dropped.some((entry) => entry.campaignId === "earned" && entry.reason === "STACK_NOT_PERMITTED"));
  assert.equal(future.dropped.some((entry) => entry.campaignId === "next"), false);
  assert.deepEqual(current.quantityProgress, [], "a missing no-op ledger step and an explicit conflict are different");
});

test("counterfactual pricing consumes the same quote-wide 50-run budget", async () => {
  let probes = 0;
  const legacy = { campaign: { id: "ceiling", kind: "FLASH_SALE", discountType: "FIXED_PRICE", percentageValue: null, fixedPriceVnd: BigInt(50_000) } as NonNullable<QuoteCartLine["legacy"]>["campaign"], effectivePriceVnd: 50_000 };
  const tier = { ...tierRecord("next", [[51, 10]]), stackingEnabled: true, stackPriority: 1,
    stackPeers: [{ peerKind: "FLASH_SALE", peerCampaignId: "ceiling" }] };
  const quote = await resolveGiftQuantityQuote({ lines: Array.from({ length: 50 }, (_, i) => ({ ...line(`v${i}`, 1), legacy })), now: NOW, env: ON,
    client: fakeClient([tier]), readLegacyConsents: async () => new Map([["ceiling", { priority: 2 }]]),
    canAddQuantity: () => { probes++; return true; },
  });
  assert.ok(quote.enabled && quote.ok);
  assert.equal(probes, MAX_QUANTITY_PROGRESS_TRIALS / 2, "each addition spends one future run and one comparison run");
  assert.deepEqual(quote.quantityProgress, []);
  assert.equal(quote.subtotalVnd, 2_500_000);
});

test("partial-unit milestones retain selection rules and can be reached using an eligible variant", async () => {
  const tier = { ...tierRecord("partial", [[5, 50_000]]), tierUnit: "FIXED_AMOUNT_PER_UNIT_VND", tierDiscountedUnits: "FROM_REACHED_THRESHOLD", tierSelectionPriority: "MOST_EXPENSIVE_FIRST" };
  const quote = await resolveGiftQuantityQuote({ lines: [line("cheap", 3, 30_000), line("expensive", 1)], now: NOW, client: fakeClient([tier]), env: ON });
  assert.ok(quote.enabled && quote.ok);
  assert.equal(quote.subtotalVnd, 190_000);
  assert.equal(quote.quantityProgress[0]?.next.shortfallQuantity, 1);
  assert.equal(quote.quantityProgress[0]?.discountedUnits, "FROM_REACHED_THRESHOLD");
});

test("gate OFF/unset/malformed: nothing is read and the result is disabled", async () => {
  const throwing = new Proxy({}, { get: () => { throw new Error("must not read while OFF"); } }) as never;
  for (const env of [{}, { LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "1" }, { LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "TRUE" }, { LA_PROMOTION_ACTIVATION_ENABLED: "true" }]) {
    assert.deepEqual(await resolveGiftQuantityQuote({ lines: [line("a", 3)], now: NOW, client: throwing, env }), { enabled: false });
    assert.deepEqual(await resolveGiftQuantityQuote({ lines: [], now: NOW, client: throwing, env }), { enabled: false });
  }
});

test("gate ON: tier prices every unit, recomputed from the quantity each call; revisions are reported", async () => {
  const client = fakeClient([tierRecord("t1", [[3, 10]])]);
  const price = async (quantity: number) => {
    const quote = await resolveGiftQuantityQuote({ lines: [line("a", quantity)], now: NOW, client, env: ON });
    assert.ok(quote.enabled && quote.ok);
    return quote.enabled && quote.ok ? quote : null!;
  };
  assert.equal((await price(2)).subtotalVnd, 200_000);
  assert.equal((await price(3)).subtotalVnd, 270_000);
  const four = await price(4);
  assert.equal(four.subtotalVnd, 360_000);
  assert.equal(four.campaignRevisions.get("t1"), 7);
  assert.equal(four.groups[0]!.lineKey, "a");
});

test("gate ON with nothing to price is an empty, valid quote and reads nothing", async () => {
  const counter = { calls: [] as string[] };
  const quote = await resolveGiftQuantityQuote({ lines: [], now: NOW, client: fakeClient([], counter), env: ON });
  assert.ok(quote.enabled && quote.ok);
  assert.equal(quote.enabled && quote.ok && quote.subtotalVnd, 0);
  assert.deepEqual(counter.calls, []);
});

test("the number of statements is constant in the number of lines and none is read for membership when no tier is active", async () => {
  const counter = { calls: [] as string[] };
  await resolveGiftQuantityQuote({ lines: Array.from({ length: 30 }, (_, i) => line(`l${i}`, 1)), now: NOW, client: fakeClient([tierRecord("t1", [[3, 10]])], counter), env: ON });
  assert.deepEqual(counter.calls, ["campaign", "membership"]);
  counter.calls.length = 0;
  await resolveGiftQuantityQuote({ lines: Array.from({ length: 30 }, (_, i) => line(`l${i}`, 1)), now: NOW, client: fakeClient([], counter), env: ON });
  assert.deepEqual(counter.calls, ["campaign"]);
});

test("a lookup that exceeds its bound fails closed, never as 'no tier applies'", async () => {
  const records = Array.from({ length: 51 }, (_, i) => tierRecord(`t${i}`, [[1, 5]]));
  assert.deepEqual(
    await resolveGiftQuantityQuote({ lines: [line("a", 1)], now: NOW, client: fakeClient(records), env: ON }),
    { enabled: true, ok: false, reason: "LOOKUP_FAILED" },
  );
});

test("a malformed or duplicate line key fails closed instead of being priced", async () => {
  const client = fakeClient([tierRecord("t1", [[1, 10]])]);
  for (const lines of [[line("a|disc", 1)], [line("a", 1), line("a", 1)], [line("a", 0)], [line("a", 1.5)], [line("a", Number.MAX_SAFE_INTEGER)]]) {
    assert.deepEqual(await resolveGiftQuantityQuote({ lines, now: NOW, client, env: ON }), { enabled: true, ok: false, reason: "INPUT_INVALID" });
  }
});

test("paid money is integer VND within safe-integer bounds, per group and in total", async () => {
  const client = fakeClient([tierRecord("t1", [[2, 33]])]);
  const quote = await resolveGiftQuantityQuote({ lines: [line("a", 3, 99_999), line("b", 4, 12_345)], now: NOW, client, env: ON });
  assert.ok(quote.enabled && quote.ok);
  if (!quote.enabled || !quote.ok) return;
  for (const group of quote.groups) {
    assert.ok(Number.isSafeInteger(group.unitPriceVnd) && group.unitPriceVnd >= 1);
    assert.equal(group.lineTotalVnd, group.unitPriceVnd * group.quantity);
  }
  assert.equal(quote.subtotalVnd, quote.groups.reduce((sum, group) => sum + group.lineTotalVnd, 0));
});

test("a split line gets collision-free derived group keys and keeps its source line key", async () => {
  const client = fakeClient([{ ...tierRecord("t1", [[3, 10]]), tierDiscountedUnits: "FROM_REACHED_THRESHOLD", tierSelectionPriority: "CHEAPEST_FIRST" }]);
  const quote = await resolveGiftQuantityQuote({ lines: [line("a", 3)], now: NOW, client, env: ON });
  assert.ok(quote.enabled && quote.ok);
  if (!quote.enabled || !quote.ok) return;
  assert.deepEqual(quote.groups.map((group) => group.groupKey).sort(), ["a|disc", "a|full"]);
  assert.deepEqual([...new Set(quote.groups.map((group) => group.lineKey))], ["a"]);
});

const LOOKUP_FAILED = { enabled: true, ok: false, reason: "LOOKUP_FAILED" } as const;

test("every read boundary failure resolves to the typed LOOKUP_FAILED, never a throw or a legacy-priced quote", async () => {
  const boom = () => Promise.reject(new Error("postgresql://user:secret@db.internal/prod connection reset"));
  const base = fakeClient([tierRecord("t1", [[1, 10]])]);
  const fixed = { ...tierRecord("t2", [[1, 10]]), scopeMode: "FIXED_PRODUCT_SET", frozenAt: PAST, frozenCampaignRevision: 1 };

  const campaignFails: GiftQuantityCandidateReadClient = { ...base, giftQuantityCampaign: { findMany: boom } };
  const membershipFails: GiftQuantityCandidateReadClient = { ...base, productCategoryMembership: { findMany: boom } };
  const frozenFails: GiftQuantityCandidateReadClient = { ...fakeClient([fixed]), giftQuantityFrozenProduct: { findMany: boom } };
  for (const client of [campaignFails, membershipFails, frozenFails]) {
    const result = await resolveGiftQuantityQuote({ lines: [line("a", 2)], now: NOW, client, env: ON });
    assert.deepEqual(result, LOOKUP_FAILED);
    assert.equal(JSON.stringify(result).includes("secret"), false, "the cause is not echoed");
  }
});

test("a failing or malformed legacy-consent reader is LOOKUP_FAILED / INPUT_INVALID, and OFF never calls it", async () => {
  const client = fakeClient([tierRecord("t1", [[1, 10]])]);
  const legacyLine: QuoteCartLine = {
    ...line("a", 2),
    legacy: {
      campaign: { id: "flash-1", kind: "FLASH_SALE", discountType: "PERCENTAGE", percentageValue: 10, fixedPriceVnd: null } as never,
      effectivePriceVnd: 90_000,
    },
  };
  assert.deepEqual(
    await resolveGiftQuantityQuote({ lines: [legacyLine], now: NOW, client, env: ON, readLegacyConsents: async () => { throw new Error("consent store down"); } }),
    LOOKUP_FAILED,
  );
  assert.deepEqual(
    await resolveGiftQuantityQuote({ lines: [legacyLine], now: NOW, client, env: ON, readLegacyConsents: async () => ({}) as never }),
    { enabled: true, ok: false, reason: "INPUT_INVALID" },
  );
  assert.deepEqual(
    await resolveGiftQuantityQuote({ lines: [legacyLine], now: NOW, client, env: ON, readLegacyConsents: async () => new Map([["flash-1", { priority: 1.5 }]]) }),
    { enabled: true, ok: false, reason: "INPUT_INVALID" },
  );
  let calls = 0;
  const counting = async () => { calls += 1; return new Map(); };
  assert.deepEqual(await resolveGiftQuantityQuote({ lines: [legacyLine], now: NOW, client, env: {}, readLegacyConsents: counting }), { enabled: false });
  assert.equal(calls, 0, "gate OFF never reaches the reader");
});

test("validateQuoteCartItems: unique well-formed variant ids, positive safe-integer quantities, bounded count", () => {
  const ok = (items: unknown) => validateQuoteCartItems(items);
  assert.equal(ok([]), true);
  assert.equal(ok([{ variantId: "a", quantity: 1 }, { variantId: "b", quantity: MAX_QUOTE_ITEM_QUANTITY }]), true);
  assert.equal(ok(Array.from({ length: MAX_QUOTE_CART_ITEMS }, (_, i) => ({ variantId: `v${i}`, quantity: 1 }))), true);

  assert.equal(ok(Array.from({ length: MAX_QUOTE_CART_ITEMS + 1 }, (_, i) => ({ variantId: `v${i}`, quantity: 1 }))), false);
  assert.equal(ok([{ variantId: "a", quantity: 1 }, { variantId: "a", quantity: 2 }]), false, "duplicate variant");
  for (const quantity of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_QUOTE_ITEM_QUANTITY + 1, Number.MAX_SAFE_INTEGER + 1, "2", null, undefined]) {
    assert.equal(ok([{ variantId: "a", quantity }]), false, String(quantity));
  }
  for (const variantId of ["", "a|disc", "a b", "x".repeat(65), 7, null, undefined]) {
    assert.equal(ok([{ variantId, quantity: 1 }]), false, String(variantId));
  }
  for (const items of [null, undefined, "x", {}, [null], [7], [[]]]) assert.equal(ok(items), false);
});

// A price that exists only once a cart reaches a quantity must never reach a surface that publishes
// an unconditional product price. Only the cart repository may consume the quote engine.
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

function engineImports(text: string) {
  const source = ts.createSourceFile("boundary.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return source.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) return [];
    const kind = statement.moduleSpecifier.text.match(/gift-quantity-(quote|stack|tier)(?:\.ts)?$/)?.[1];
    if (!kind) return [];
    const bindings = statement.importClause?.namedBindings;
    const names = bindings && ts.isNamedImports(bindings)
      ? bindings.elements.filter((entry) => !entry.isTypeOnly).map((entry) => (entry.propertyName ?? entry.name).text)
      : ["*"];
    return names.length === 0 ? [] : [{ kind, names }];
  });
}

test("engine import boundary distinguishes erased types from runtime pricing imports", () => {
  assert.deepEqual(engineImports('import type { StackPeer } from "./gift-quantity-stack.ts";'), []);
  assert.deepEqual(engineImports('import { type StackPeer, priceStack as price } from "./gift-quantity-stack.ts";'), [{ kind: "stack", names: ["priceStack"] }]);
});

// Modules allowed to import part of the engines without becoming a price surface.
// Checkout Upsell reads the canonical stage value and validates config; it cannot call pricing.
// - Validators check configuration or price safety; they never calculate a cart price.
// - The tier editor's preview (GQ09b) is a simulated, admin-only illustration: it runs the pure
//   tier function on one sample line and is never a buyer-authoritative cart price. It may import
//   exactly these runtime symbols and nothing from the quote/stack engines.
const adminEngineImports: Record<string, readonly string[]> = {
  "commerce/promotion-upsell-policy.ts": ["orderValueTierInputSubtotal", "validateTierConfig"],
  "commerce/gift-quantity-stack-peers.ts": ["STACK_PEER_ANY"],
  "commerce/gift-quantity-tier-rule.ts": ["MAX_ORDER_SUBTOTAL_THRESHOLD_VND", "MAX_TIERS_PER_CAMPAIGN", "validateTierConfig"],
  "commerce/gift-quantity-publish-guards.ts": ["findPricesInvalidForTier"],
  "components/admin/gift-quantity-tier-fields.tsx": ["MAX_ORDER_SUBTOTAL_THRESHOLD_VND", "MAX_TIER_UNITS", "MAX_TIERS_PER_CAMPAIGN", "priceTier", "validateTierConfig"],
};

/** Importers per engine kind; a declared admin module exceeding its symbols fails immediately. */
function engineImporters(sources: ReadonlyArray<Readonly<{ path: string; text: string }>>) {
  const importers = new Map<string, string[]>();
  for (const { path, text } of sources) {
    for (const { kind, names } of engineImports(text)) {
      const allowed = adminEngineImports[path];
      if (allowed) {
        assert.ok(names.every((name) => allowed.includes(name)), `${path} may only import its validation functions/constants`);
        continue;
      }
      const list = importers.get(kind) ?? [];
      list.push(path);
      importers.set(kind, list);
    }
  }
  return importers;
}

test("only the cart repository consumes the tier quote engine (no PDP/PLP/feed/structured-data path can)", () => {
  const root = join(import.meta.dirname, "..", "..", "src");
  const importers = engineImporters(sourceFiles(root).map((file) => ({
    path: relative(root, file).split("\\").join("/"),
    text: readFileSync(file, "utf8"),
  })));
  assert.deepEqual(importers.get("quote")?.sort(), ["commerce/storefront-cart-repository.ts"]);
  // Gift selection may import only the gift stack-consent resolver, not paid tier arithmetic.
  assert.deepEqual(importers.get("stack")?.sort(), ["commerce/cart-gift-selection.ts", "commerce/gift-quantity-quote.ts"]);
  const selectionSource = readFileSync(join(root, "commerce", "cart-gift-selection.ts"), "utf8");
  assert.match(selectionSource, /resolveGiftCampaignStacking/);
  assert.doesNotMatch(selectionSource, /\bpriceStack\b/);
  assert.deepEqual(importers.get("tier")?.sort(), ["commerce/gift-quantity-stack.ts"]);
});

test("the admin tier preview exception is exact: any other importer still breaks the boundary", () => {
  const tierImport = 'import { priceTier } from "@/commerce/gift-quantity-tier";';
  const previewPath = "components/admin/gift-quantity-tier-fields.tsx";
  // The declared preview may use the pure tier function, so it is not counted as an importer.
  assert.equal(engineImporters([{ path: previewPath, text: tierImport }]).get("tier"), undefined);
  // Buyer-facing and other admin modules importing the same function are reported, so the boundary assertion fails.
  assert.deepEqual(engineImporters([{ path: "components/storefront/price-tag.tsx", text: tierImport }]).get("tier"), ["components/storefront/price-tag.tsx"]);
  assert.deepEqual(engineImporters([{ path: "app/(storefront)/p/[slug]/page.tsx", text: tierImport }]).get("tier"), ["app/(storefront)/p/[slug]/page.tsx"]);
  assert.deepEqual(engineImporters([{ path: "components/admin/other-panel.tsx", text: tierImport }]).get("tier"), ["components/admin/other-panel.tsx"]);
  // The preview never gains the cart quote or stack engines.
  assert.throws(() => engineImporters([{ path: previewPath, text: 'import { priceStack } from "@/commerce/gift-quantity-stack";' }]));
  assert.throws(() => engineImporters([{ path: previewPath, text: 'import { quoteGiftQuantity } from "@/commerce/gift-quantity-quote";' }]));
});

test("Upsell policy may inspect stages but cannot calculate a cart price", () => {
  assert.throws(() => engineImporters([{ path: "commerce/promotion-upsell-policy.ts", text: 'import { priceStack } from "./gift-quantity-stack.ts";' }]));
});
