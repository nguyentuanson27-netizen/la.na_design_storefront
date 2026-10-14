import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import ts from "typescript";

import type { GiftQuantityCandidateReadClient } from "../../src/commerce/gift-quantity-candidate-repository.ts";
import {
  MAX_QUOTE_CART_ITEMS,
  MAX_QUOTE_ITEM_QUANTITY,
  resolveGiftQuantityQuote,
  validateQuoteCartItems,
  type QuoteCartLine,
} from "../../src/commerce/gift-quantity-quote.ts";

const ON = { LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true" } as const;
const NOW = new Date("2026-10-13T12:00:00.000Z");
const PAST = new Date("2026-10-01T00:00:00.000Z");

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

test("only the cart repository consumes the tier quote engine (no PDP/PLP/feed/structured-data path can)", () => {
  const root = join(import.meta.dirname, "..", "..", "src");
  const importers = new Map<string, string[]>();
  // These admin modules may validate configuration/price safety, never calculate a cart price.
  const adminValidators: Record<string, readonly string[]> = {
    "commerce/gift-quantity-stack-peers.ts": ["STACK_PEER_ANY"],
    "commerce/gift-quantity-tier-rule.ts": ["MAX_TIERS_PER_CAMPAIGN", "validateTierConfig"],
    "commerce/gift-quantity-publish-guards.ts": ["findPricesInvalidForTier"],
  };
  for (const file of sourceFiles(root)) {
    const path = relative(root, file).split("\\").join("/");
    for (const { kind, names } of engineImports(readFileSync(file, "utf8"))) {
      const allowed = adminValidators[path];
      if (allowed) {
        assert.ok(names.every((name) => allowed.includes(name)), `${path} may only import its validation functions/constants`);
        continue;
      }
      const list = importers.get(kind) ?? [];
      list.push(path);
      importers.set(kind, list);
    }
  }
  assert.deepEqual(importers.get("quote")?.sort(), ["commerce/storefront-cart-repository.ts"]);
  assert.deepEqual(importers.get("stack")?.sort(), ["commerce/gift-quantity-quote.ts"]);
  assert.deepEqual(importers.get("tier")?.sort(), ["commerce/gift-quantity-stack.ts"]);
});
