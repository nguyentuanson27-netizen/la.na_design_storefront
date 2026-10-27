import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_VOUCHER_SCOPE_CATEGORIES,
  MAX_VOUCHER_SCOPE_EXCLUDED_PRODUCTS,
  MAX_VOUCHER_SCOPE_INCLUDED_PRODUCTS,
  buildVoucherScopeResolver,
  validateVoucherScope,
  type VoucherProductFacts,
  type VoucherScopeConfig,
} from "../../src/commerce/voucher-scope.ts";
import { GLOBAL_ALL_PAID_LINES, buildScopeResolver } from "../../src/commerce/gift-quantity-scope.ts";

const SHOP = "shop-1";
const product = (productId: string, categoryKeys: string[] = [], shopId = SHOP): VoucherProductFacts => ({
  productId,
  shopId,
  categoryKeys,
});

function valid(input: unknown): VoucherScopeConfig {
  const result = validateVoucherScope(input);
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as { scope: VoucherScopeConfig }).scope;
}

function codes(input: unknown): string[] {
  const result = validateVoucherScope(input);
  assert.equal(result.ok, false);
  return (result as unknown as { issues: readonly { code: string }[] }).issues.map((issue) => issue.code);
}

test("ALL_SHOP covers every product of the shop and honours an exclude list (EX-03 example)", () => {
  const scope = valid({ mode: "ALL_SHOP", excludeProductIds: ["bagB"] });
  const resolver = buildVoucherScopeResolver(scope, SHOP);
  assert.equal(resolver(product("dress")), true);
  assert.equal(resolver(product("no-category")), true);
  assert.equal(resolver(product("bagB", ["phuKien"])), false);
  // ALL_SHOP with no exclusions is the plain whole-shop voucher.
  assert.deepEqual(valid({ mode: "ALL_SHOP" }), { mode: "ALL_SHOP", excludeProductIds: [] });
});

test("ALL_SHOP refuses category and include targets as redundant", () => {
  assert.deepEqual(codes({ mode: "ALL_SHOP", categoryKeys: ["vayDam"] }), ["scope-all-shop-with-targets"]);
  assert.deepEqual(codes({ mode: "ALL_SHOP", includeProductIds: ["p1"] }), ["scope-all-shop-with-targets"]);
  // explicitly empty lists are not targets
  valid({ mode: "ALL_SHOP", categoryKeys: [], includeProductIds: [] });
});

test("the voucher resolver is independent of the Gift & Quantity global scope", () => {
  // GQ's global scope refuses any target on purpose; the voucher scope must not inherit that.
  const gq = buildScopeResolver({ mode: GLOBAL_ALL_PAID_LINES }, null);
  const voucher = buildVoucherScopeResolver(valid({ mode: "ALL_SHOP", excludeProductIds: ["x"] }), SHOP);
  assert.equal(gq({ productId: "x", categoryKeys: [] }), true);
  assert.equal(voucher(product("x")), false);
});

test("TARGETED = (category OR include) AND NOT exclude, with the dress/bag example", () => {
  // Category Dress + include Bag B + exclude Dress A => other dresses and Bag B qualify, Dress A does not.
  const scope = valid({
    mode: "TARGETED",
    categoryKeys: ["vayDam"],
    includeProductIds: ["bagB"],
    excludeProductIds: ["dressA"],
  });
  const resolver = buildVoucherScopeResolver(scope, SHOP);
  assert.equal(resolver(product("dressC", ["vayDam"])), true);
  assert.equal(resolver(product("bagB", ["phuKien"])), true);
  assert.equal(resolver(product("dressA", ["vayDam"])), false);
  assert.equal(resolver(product("bagZ", ["phuKien"])), false);
  assert.equal(resolver(product("uncategorised")), false);
});

test("category and include are OR, not AND", () => {
  const resolver = buildVoucherScopeResolver(
    valid({ mode: "TARGETED", categoryKeys: ["vayDam"], includeProductIds: ["bagB"] }),
    SHOP,
  );
  assert.equal(resolver(product("onlyCategory", ["vayDam"])), true);
  assert.equal(resolver(product("bagB")), true);
});

test("a parent category covers its children (taxonomy hierarchy), a child does not cover its parent", () => {
  const parent = buildVoucherScopeResolver(valid({ mode: "TARGETED", categoryKeys: ["aoDai"] }), SHOP);
  assert.equal(parent(product("a", ["aoDaiTet"])), true);
  assert.equal(parent(product("b", ["aoDai"])), true);
  assert.equal(parent(product("c", ["setVay"])), false);

  const child = buildVoucherScopeResolver(valid({ mode: "TARGETED", categoryKeys: ["aoDaiTet"] }), SHOP);
  assert.equal(child(product("a", ["aoDai"])), false);
  assert.equal(child(product("b", ["aoDaiTet"])), true);
});

test("membership is dynamic: the same scope covers a product once it joins the category", () => {
  const resolver = buildVoucherScopeResolver(valid({ mode: "TARGETED", categoryKeys: ["vayDam"] }), SHOP);
  assert.equal(resolver(product("new-dress", [])), false);
  assert.equal(resolver(product("new-dress", ["vayDam"])), true);
});

test("exclude wins over an include and over a category, and the include is dropped on normalize", () => {
  const scope = valid({
    mode: "TARGETED",
    categoryKeys: ["vayDam"],
    includeProductIds: ["p1", "p2"],
    excludeProductIds: ["p1"],
  });
  assert.deepEqual((scope as { includeProductIds: readonly string[] }).includeProductIds, ["p2"]);
  const resolver = buildVoucherScopeResolver(scope, SHOP);
  assert.equal(resolver(product("p1", ["vayDam"])), false);
  assert.equal(resolver(product("p2")), true);
});

test("a product of another shop never matches, in either mode", () => {
  const all = buildVoucherScopeResolver(valid({ mode: "ALL_SHOP" }), SHOP);
  const targeted = buildVoucherScopeResolver(valid({ mode: "TARGETED", includeProductIds: ["p1"] }), SHOP);
  assert.equal(all(product("p1", [], "shop-2")), false);
  assert.equal(targeted(product("p1", [], "shop-2")), false);
});

test("TARGETED needs a real selection; exclusions alone or an include fully excluded select nothing", () => {
  assert.deepEqual(codes({ mode: "TARGETED" }), ["scope-empty"]);
  assert.deepEqual(codes({ mode: "TARGETED", excludeProductIds: ["p1"] }), ["scope-empty"]);
  assert.deepEqual(codes({ mode: "TARGETED", includeProductIds: ["p1"], excludeProductIds: ["p1"] }), ["scope-empty"]);
});

test("unknown mode, non-object input and unknown categories are refused", () => {
  assert.deepEqual(codes({ mode: "GLOBAL_ALL_PAID_LINES" }), ["scope-mode-invalid"]);
  assert.deepEqual(codes(null), ["scope-mode-invalid"]);
  assert.deepEqual(codes("ALL_SHOP"), ["scope-mode-invalid"]);
  assert.ok(codes({ mode: "TARGETED", categoryKeys: ["nope"] }).includes("scope-category-unknown"));
  assert.ok(codes({ mode: "TARGETED", categoryKeys: [42] }).includes("scope-category-unknown"));
});

test("ids must be clean and unique, lists are bounded", () => {
  assert.ok(codes({ mode: "TARGETED", includeProductIds: [""] }).includes("scope-product-id-invalid"));
  assert.ok(codes({ mode: "TARGETED", includeProductIds: [" p1"] }).includes("scope-product-id-invalid"));
  assert.ok(codes({ mode: "TARGETED", includeProductIds: ["x".repeat(65)] }).includes("scope-product-id-invalid"));
  assert.ok(codes({ mode: "TARGETED", includeProductIds: "p1" }).includes("scope-product-id-invalid"));
  assert.ok(codes({ mode: "TARGETED", categoryKeys: ["vayDam", "vayDam"] }).includes("scope-duplicate-entry"));
  assert.ok(codes({ mode: "ALL_SHOP", excludeProductIds: ["p1", "p1"] }).includes("scope-duplicate-entry"));

  const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
  assert.ok(codes({ mode: "TARGETED", includeProductIds: ids(MAX_VOUCHER_SCOPE_INCLUDED_PRODUCTS + 1) }).includes("scope-included-too-many"));
  assert.ok(codes({ mode: "ALL_SHOP", excludeProductIds: ids(MAX_VOUCHER_SCOPE_EXCLUDED_PRODUCTS + 1) }).includes("scope-excluded-too-many"));
  assert.ok(
    codes({ mode: "TARGETED", categoryKeys: Array.from({ length: MAX_VOUCHER_SCOPE_CATEGORIES + 1 }, () => "vayDam") }).includes(
      "scope-category-too-many",
    ),
  );
  valid({ mode: "TARGETED", includeProductIds: ids(MAX_VOUCHER_SCOPE_INCLUDED_PRODUCTS) });
});

test("a validated scope is frozen", () => {
  const scope = valid({ mode: "TARGETED", categoryKeys: ["vayDam"] }) as unknown as { categoryKeys: string[] };
  assert.throws(() => scope.categoryKeys.push("phuKien"), TypeError);
});
