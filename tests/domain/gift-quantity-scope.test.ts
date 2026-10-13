import assert from "node:assert/strict";
import test from "node:test";

import {
  buildScopeResolver,
  computeFrozenProductIds,
  DYNAMIC_CATEGORY,
  expandScopeCategoryKeys,
  FIXED_PRODUCT_SET,
  GLOBAL_ALL_PAID_LINES,
  MAX_FROZEN_PRODUCTS,
  MAX_SCOPE_CATEGORIES,
  MAX_SCOPE_EXCLUDED_PRODUCTS,
  MAX_SCOPE_INCLUDED_PRODUCTS,
  sumScopeTotals,
  applyExcludeWins,
  validateScopeConfig,
  type FrozenProductSet,
  type ScopeConfig,
  type ScopeProductFacts,
  type ScopedPaidLine,
} from "../../src/commerce/gift-quantity-scope.ts";

const product = (productId: string, ...categoryKeys: string[]): ScopeProductFacts => ({ productId, categoryKeys });
const line = (p: ScopeProductFacts, quantity: number, unitPriceVnd: number): ScopedPaidLine => ({
  product: p,
  quantity,
  unitPriceVnd,
});
const frozen = (productIds: string[]): FrozenProductSet => ({
  productIds,
  frozenAt: new Date("2026-10-13T00:00:00Z"),
  campaignRevision: 1,
});

function valid(input: unknown, allowGlobal = false): ScopeConfig {
  const result = validateScopeConfig(input, { allowGlobal });
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as { scope: ScopeConfig }).scope;
}

function codes(input: unknown, allowGlobal = false): string[] {
  const result = validateScopeConfig(input, { allowGlobal });
  assert.equal(result.ok, false);
  return (result as unknown as { issues: readonly { code: string }[] }).issues.map((issue) => issue.code);
}

test("EX-22: global all-paid scope needs no category or products and covers every paid line", () => {
  const scope = valid({ mode: GLOBAL_ALL_PAID_LINES }, true);
  const dress = product("dress");
  const accessory = product("acc", "phuKien");
  const totals = sumScopeTotals(buildScopeResolver(scope, null), [line(dress, 1, 600_000), line(accessory, 1, 500_000)]);
  assert.deepEqual(totals, { quantity: 2, subtotalVnd: 1_100_000 });
});

test("global scope is refused outside GIFT ORDER_SUBTOTAL ALL_PAID_LINES and refuses any target list", () => {
  assert.deepEqual(codes({ mode: GLOBAL_ALL_PAID_LINES }, false), ["scope-global-not-allowed"]);
  for (const extra of [
    { categoryKeys: ["aoDai"] },
    { includeProductIds: ["p1"] },
    { excludeProductIds: ["p1"] },
  ]) {
    assert.deepEqual(codes({ mode: GLOBAL_ALL_PAID_LINES, ...extra }, true), ["scope-global-with-targets"]);
  }
  // explicitly empty arrays are not targets
  valid({ mode: GLOBAL_ALL_PAID_LINES, categoryKeys: [], includeProductIds: [], excludeProductIds: [] }, true);
});

test("non-global scopes require a real selection; exclusions alone select nothing", () => {
  assert.deepEqual(codes({ mode: DYNAMIC_CATEGORY }), ["scope-empty"]);
  assert.deepEqual(codes({ mode: DYNAMIC_CATEGORY, excludeProductIds: ["p1"] }), ["scope-empty"]);
  assert.deepEqual(codes({ mode: "ANYTHING" }), ["scope-mode-invalid"]);
  assert.deepEqual(codes(null), ["scope-mode-invalid"]);
  assert.deepEqual(codes("x"), ["scope-mode-invalid"]);
});

test("categories must be approved taxonomy keys; ids must be clean, unique strings", () => {
  assert.ok(codes({ mode: DYNAMIC_CATEGORY, categoryKeys: ["nope"] }).includes("scope-category-unknown"));
  assert.ok(codes({ mode: DYNAMIC_CATEGORY, categoryKeys: ["aoDai", "aoDai"] }).includes("scope-duplicate-entry"));
  assert.ok(codes({ mode: DYNAMIC_CATEGORY, includeProductIds: [""] }).includes("scope-product-id-invalid"));
  assert.ok(codes({ mode: DYNAMIC_CATEGORY, includeProductIds: [" p1"] }).includes("scope-product-id-invalid"));
  assert.ok(codes({ mode: DYNAMIC_CATEGORY, includeProductIds: [5] }).includes("scope-product-id-invalid"));
  assert.ok(codes({ mode: DYNAMIC_CATEGORY, includeProductIds: ["a".repeat(65)] }).includes("scope-product-id-invalid"));
  assert.ok(codes({ mode: DYNAMIC_CATEGORY, includeProductIds: "p1" }).includes("scope-product-id-invalid"));
  assert.ok(codes({ mode: DYNAMIC_CATEGORY, includeProductIds: ["p1", "p1"] }).includes("scope-duplicate-entry"));
  assert.ok(codes({ mode: DYNAMIC_CATEGORY, categoryKeys: "aoDai" }).includes("scope-category-unknown"));
});

test("inputs are bounded", () => {
  const many = (n: number) => Array.from({ length: n }, (_, index) => `p${index}`);
  assert.ok(
    codes({ mode: DYNAMIC_CATEGORY, categoryKeys: Array(MAX_SCOPE_CATEGORIES + 1).fill("aoDai") }).includes(
      "scope-category-too-many",
    ),
  );
  assert.ok(
    codes({ mode: DYNAMIC_CATEGORY, includeProductIds: many(MAX_SCOPE_INCLUDED_PRODUCTS + 1) }).includes(
      "scope-included-too-many",
    ),
  );
  assert.ok(
    codes({
      mode: DYNAMIC_CATEGORY,
      categoryKeys: ["aoDai"],
      excludeProductIds: many(MAX_SCOPE_EXCLUDED_PRODUCTS + 1),
    }).includes("scope-excluded-too-many"),
  );
  valid({ mode: DYNAMIC_CATEGORY, includeProductIds: many(MAX_SCOPE_INCLUDED_PRODUCTS) });
});

test("validated scopes are normalized and frozen", () => {
  const scope = valid({ mode: DYNAMIC_CATEGORY, categoryKeys: ["aoDai"], extra: "ignored" }) as Extract<
    ScopeConfig,
    { categoryKeys: readonly string[] }
  >;
  assert.deepEqual(scope.includeProductIds, []);
  assert.equal(Object.isFrozen(scope), true);
  assert.equal("extra" in scope, false);
});

test("R-07: a parent category covers its children through the existing listing keys", () => {
  const covered = expandScopeCategoryKeys(["aoDai"]);
  assert.ok(covered.has("aoDai") && covered.has("aoDaiCachTan") && covered.has("aoDaiTet"));
  assert.equal(covered.has("setDo"), false);
  // a child selection does not widen to the parent or siblings
  const child = expandScopeCategoryKeys(["aoDaiTet"]);
  assert.deepEqual([...child], ["aoDaiTet"]);
});

test("dynamic scope: category + include union, exclude always wins", () => {
  const scope = valid({
    mode: DYNAMIC_CATEGORY,
    categoryKeys: ["aoDai"],
    includeProductIds: ["acc-gold"],
    excludeProductIds: ["dress-b", "acc-gold-excluded"],
  });
  const resolve = buildScopeResolver(scope, null);
  assert.equal(resolve(product("dress-a", "aoDaiTet")), true, "child category via parent");
  assert.equal(resolve(product("dress-b", "aoDaiTet")), false, "excluded product in a selected category");
  assert.equal(resolve(product("acc-gold", "phuKien")), true, "explicit include outside categories");
  assert.equal(resolve(product("set-1", "setVay")), false, "outside every selected category");
  assert.equal(resolve(product("none")), false, "no membership");
  // exclude beats include
  const both = buildScopeResolver(
    valid({ mode: DYNAMIC_CATEGORY, categoryKeys: ["aoDai"], includeProductIds: ["p"], excludeProductIds: ["p"] }),
    null,
  );
  assert.equal(both(product("p", "aoDaiTet")), false, "in a selected category and on both lists: excluded");
  assert.equal(both(product("p")), false);
});

test("EX-16: dynamic scope sees a new product immediately, fixed scope does not", () => {
  const config = {
    mode: DYNAMIC_CATEGORY,
    categoryKeys: ["setVay"],
  };
  const dynamic = buildScopeResolver(valid(config), null);
  const fixedConfig = valid({ ...config, mode: FIXED_PRODUCT_SET });
  const snapshot = computeFrozenProductIds(fixedConfig, [product("old", "setVay"), product("other", "phuKien")]);
  assert.equal(snapshot.ok, true);
  const fixed = buildScopeResolver(
    fixedConfig,
    frozen([...(snapshot as unknown as { productIds: readonly string[] }).productIds]),
  );

  const fresh = product("new", "setVay");
  assert.equal(dynamic(fresh), true);
  assert.equal(fixed(fresh), false, "category membership added after the freeze never joins a fixed scope");
  assert.equal(fixed(product("old", "setVay")), true);
  // membership of a frozen product changing later does not remove it either
  assert.equal(fixed(product("old", "phuKien")), true);
});

test("fixed scope that was never frozen matches nothing (fail closed)", () => {
  const fixedConfig = valid({ mode: FIXED_PRODUCT_SET, categoryKeys: ["setVay"] });
  assert.equal(buildScopeResolver(fixedConfig, null)(product("p", "setVay")), false);
});

test("fixed scope re-applies exclusions over a stale snapshot", () => {
  const fixedConfig = valid({
    mode: FIXED_PRODUCT_SET,
    categoryKeys: ["setVay"],
    excludeProductIds: ["p2"],
  });
  const resolve = buildScopeResolver(fixedConfig, frozen(["p1", "p2"]));
  assert.equal(resolve(product("p1")), true);
  assert.equal(resolve(product("p2")), false);
});

test("computeFrozenProductIds: union of covered categories and includes minus excludes, sorted and bounded", () => {
  const fixedConfig = valid({
    mode: FIXED_PRODUCT_SET,
    categoryKeys: ["aoDai"],
    includeProductIds: ["uncategorised", "excluded-include"],
    excludeProductIds: ["dress-b", "excluded-include"],
  });
  const result = computeFrozenProductIds(fixedConfig, [
    product("dress-c", "aoDaiCuoi"),
    product("dress-a", "aoDaiTet"),
    product("dress-b", "aoDaiTet"),
    product("set-1", "setVay"),
  ]);
  assert.deepEqual(result, { ok: true, productIds: ["dress-a", "dress-c", "uncategorised"] });

  const onlyIncludes = computeFrozenProductIds(fixedConfig, [product("set-1", "setVay")]);
  assert.deepEqual(onlyIncludes, { ok: true, productIds: ["uncategorised"] }, "explicit includes freeze without membership");

  const none = computeFrozenProductIds(valid({ mode: FIXED_PRODUCT_SET, categoryKeys: ["setVay"] }), [
    product("x", "phuKien"),
  ]);
  assert.deepEqual(none, { ok: false, code: "scope-frozen-empty" });

  const tooMany = computeFrozenProductIds(
    valid({ mode: FIXED_PRODUCT_SET, categoryKeys: ["setVay"] }),
    Array.from({ length: MAX_FROZEN_PRODUCTS + 1 }, (_, index) => product(`p${index}`, "setVay")),
  );
  assert.deepEqual(tooMany, { ok: false, code: "scope-frozen-too-many" });

  assert.deepEqual(computeFrozenProductIds(valid({ mode: DYNAMIC_CATEGORY, categoryKeys: ["aoDai"] }), []), {
    ok: false,
    code: "scope-mode-invalid",
  });
});

test("computeFrozenProductIds is deterministic regardless of input order", () => {
  const config = valid({ mode: FIXED_PRODUCT_SET, categoryKeys: ["aoDai"] });
  const rows = [product("b", "aoDaiTet"), product("a", "aoDaiCuoi"), product("c", "aoDai")];
  assert.deepEqual(computeFrozenProductIds(config, rows), computeFrozenProductIds(config, [...rows].reverse()));
});

test("EX-05: ALL_PAID_LINES reaches the threshold, ELIGIBLE_PAID_LINES (dress only) does not", () => {
  const dress = product("dress", "vayDam");
  const accessory = product("acc", "phuKien");
  const lines = [line(dress, 1, 600_000), line(accessory, 1, 500_000)];
  const all = sumScopeTotals(buildScopeResolver(valid({ mode: GLOBAL_ALL_PAID_LINES }, true), null), lines);
  const eligible = sumScopeTotals(
    buildScopeResolver(valid({ mode: DYNAMIC_CATEGORY, categoryKeys: ["vayDam"] }), null),
    lines,
  );
  assert.equal(all.subtotalVnd >= 1_000_000, true);
  assert.equal(eligible.subtotalVnd >= 1_000_000, false);
  assert.equal(eligible.subtotalVnd, 600_000);
});

test("EX-06: quantity counts across variants and products; a set sold as one product counts once per unit", () => {
  const resolver = buildScopeResolver(valid({ mode: DYNAMIC_CATEGORY, categoryKeys: ["vayDam", "setDo"] }), null);
  const dressA = product("dress-a", "vayDam");
  const dressB = product("dress-b", "vayDam");
  const set = product("set", "setVay");
  // two variants of dress A are two lines of the same product; dress B another product; one set
  const lines = [line(dressA, 1, 500_000), line(dressA, 1, 500_000), line(dressB, 1, 500_000), line(set, 1, 900_000)];
  assert.equal(sumScopeTotals(resolver, lines).quantity, 4);
});

test("totals ignore out-of-scope lines and reject invalid or overflowing lines", () => {
  const resolver = buildScopeResolver(valid({ mode: DYNAMIC_CATEGORY, categoryKeys: ["phuKien"] }), null);
  const inScope = product("a", "phuKien");
  const outScope = product("b", "vayDam");
  assert.deepEqual(sumScopeTotals(resolver, [line(inScope, 2, 100_000), line(outScope, 9, 1)]), {
    quantity: 2,
    subtotalVnd: 200_000,
  });
  assert.deepEqual(sumScopeTotals(resolver, []), { quantity: 0, subtotalVnd: 0 });
  assert.throws(() => sumScopeTotals(resolver, [line(inScope, 0, 1)]), RangeError);
  assert.throws(() => sumScopeTotals(resolver, [line(inScope, 1.5, 1)]), RangeError);
  assert.throws(() => sumScopeTotals(resolver, [line(inScope, 1, 0)]), RangeError, "a paid line can never be 0 VND");
  assert.throws(() => sumScopeTotals(resolver, [line(inScope, 1, -5)]), RangeError);
  assert.throws(
    () => sumScopeTotals(resolver, [line(inScope, Number.MAX_SAFE_INTEGER, 2)]),
    RangeError,
    "overflow is an error, never a silent wrap",
  );
  // invalid lines are rejected even when out of scope: the cart is malformed either way
  assert.throws(() => sumScopeTotals(resolver, [line(outScope, 0, 1)]), RangeError);
});

test("F04: exclude wins is applied once, at validation — a product on both lists comes back only as excluded", () => {
  const result = validateScopeConfig(
    { mode: "DYNAMIC_CATEGORY", categoryKeys: ["vayDam"], includeProductIds: ["a", "b"], excludeProductIds: ["b", "c"] },
    { allowGlobal: false },
  );
  assert.ok(result.ok);
  if (!result.ok || result.scope.mode === "GLOBAL_ALL_PAID_LINES") return;
  assert.deepEqual([...result.scope.includeProductIds], ["a"]);
  assert.deepEqual([...result.scope.excludeProductIds], ["b", "c"]);
  assert.deepEqual(applyExcludeWins(["a", "b", "c"], ["b"]), ["a", "c"]);
  assert.deepEqual(applyExcludeWins(["a"], []), ["a"]);
});

test("F04: a scope whose only selection is cancelled by its own exclusions selects nothing and is refused as empty", () => {
  const result = validateScopeConfig(
    { mode: "FIXED_PRODUCT_SET", categoryKeys: [], includeProductIds: ["a"], excludeProductIds: ["a"] },
    { allowGlobal: false },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(!result.ok && result.issues.map((issue) => issue.code), ["scope-empty"]);
});
