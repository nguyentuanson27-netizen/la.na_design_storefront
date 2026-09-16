import assert from "node:assert/strict";
import test from "node:test";

import { CATEGORY_NAVIGATION } from "../../src/brand/category.config.ts";
import {
  CATEGORY_KEYS,
  CategoryMembershipError,
  MAX_CATEGORY_MEMBERSHIPS,
  TOP_LEVEL_CATEGORY_KEYS,
  categoryAncestorKeys,
  categoryByKey,
  categoryByPath,
  categoryListingKeys,
  descendantCategoryKeys,
  findCategoryMembershipViolations,
  parseCategoryMembership,
  type CategoryKey,
  type CategoryMembershipPolicy,
} from "../../src/commerce/category-taxonomy.ts";
import { STATIC_CANONICAL_PATHS } from "../../src/seo/search-sitemap-repository.ts";

const PERMISSIVE: CategoryMembershipPolicy = { requireLeafMembership: false };
const LEAF_REQUIRED: CategoryMembershipPolicy = { requireLeafMembership: true };

/**
 * The owner-approved taxonomy, written out rather than derived.
 *
 * Deriving it from the config would make this test agree with any taxonomy at all. Spelling it out
 * is what makes adding, removing or renaming an approved category a deliberate, test-breaking act.
 */
const APPROVED_TAXONOMY = [
  { key: "aoDai", path: "/ao-dai", children: [
    { key: "aoDaiCachTan", path: "/ao-dai/cach-tan" },
    { key: "aoDaiTet", path: "/ao-dai/tet" },
    { key: "aoDaiCuoi", path: "/ao-dai/cuoi" },
    { key: "aoDai4Ta", path: "/ao-dai/4-ta" },
    { key: "aoDai6Ta", path: "/ao-dai/6-ta" },
  ] },
  { key: "setDo", path: "/set-do", children: [
    { key: "setVay", path: "/set-do/set-vay" },
    { key: "setQuanAo", path: "/set-do/set-quan-ao" },
  ] },
  { key: "vayDam", path: "/vay-dam", children: [] },
  { key: "phuKien", path: "/phu-kien", children: [] },
] as const;

test("G4 the taxonomy is exactly the approved category tree", () => {
  assert.deepEqual(
    TOP_LEVEL_CATEGORY_KEYS,
    APPROVED_TAXONOMY.map((root) => root.key),
  );

  for (const root of APPROVED_TAXONOMY) {
    const node = categoryByKey(root.key);
    assert.ok(node, `missing approved top-level category ${root.key}`);
    assert.equal(node.path, root.path);
    assert.equal(node.parentKey, null);
    assert.equal(node.topLevelKey, root.key, "a top-level category is its own tree root");
    assert.deepEqual(node.childKeys, root.children.map((child) => child.key));

    for (const child of root.children) {
      const childNode = categoryByKey(child.key);
      assert.ok(childNode, `missing approved subcategory ${child.key}`);
      assert.equal(childNode.path, child.path);
      assert.equal(childNode.parentKey, root.key);
      assert.equal(childNode.topLevelKey, root.key, "a subcategory inherits its tree root");
    }
  }
});

test("G4 category keys and paths are unique identities", () => {
  assert.equal(new Set(CATEGORY_KEYS).size, CATEGORY_KEYS.length, "duplicate category key");

  const paths = CATEGORY_KEYS.map((key) => categoryByKey(key)?.path);
  assert.equal(new Set(paths).size, paths.length, "duplicate category path");
  assert.equal(paths.includes(undefined), false);
});

test("G4 every category resolves deterministically from its route path", () => {
  for (const key of CATEGORY_KEYS) {
    const node = categoryByKey(key);
    assert.ok(node);
    assert.equal(categoryByPath(node.path)?.key, key);
  }

  // Query state is not part of category identity, and neither is a near-miss path.
  assert.equal(categoryByPath("/ao-dai?page=2"), null);
  assert.equal(categoryByPath("/ao-dai/"), null);
  assert.equal(categoryByPath("/khong-ton-tai"), null);
  assert.equal(categoryByPath(undefined), null);
});

test("G4 non-category namespaces are never category identities", () => {
  // `/collections` is a separate editorial namespace; the others are projections, not membership
  // authorities. Any of them resolving here would mean the taxonomy had absorbed a foreign concept.
  for (const path of ["/collections", "/collections/ao-dai", "/new-arrivals", "/sale", "/shop"]) {
    assert.equal(categoryByPath(path), null, `${path} must not resolve as a category`);
  }
});

test("G4 child membership projects into the parent listing without a derived row", () => {
  // The parent listing widens to cover its descendants...
  assert.deepEqual(categoryListingKeys("aoDai"), [
    "aoDai",
    "aoDaiCachTan",
    "aoDaiTet",
    "aoDaiCuoi",
    "aoDai4Ta",
    "aoDai6Ta",
  ]);
  assert.deepEqual(categoryListingKeys("setDo"), ["setDo", "setVay", "setQuanAo"]);

  // ...while a subcategory listing stays exactly itself, so a product assigned to `Áo dài Tết`
  // appears on `/ao-dai` and on `/ao-dai/tet`, but never on a sibling subcategory.
  assert.deepEqual(categoryListingKeys("aoDaiTet"), ["aoDaiTet"]);
  assert.equal(categoryListingKeys("aoDaiTet").includes("aoDaiCuoi"), false);

  // A childless top-level category is its own whole listing.
  assert.deepEqual(categoryListingKeys("vayDam"), ["vayDam"]);
  assert.deepEqual(categoryListingKeys("unknown-key"), []);
});

test("G4 ancestors give breadcrumb order, root first", () => {
  assert.deepEqual(categoryAncestorKeys("aoDaiTet"), ["aoDai"]);
  assert.deepEqual(categoryAncestorKeys("setVay"), ["setDo"]);
  assert.deepEqual(categoryAncestorKeys("aoDai"), []);
  assert.deepEqual(categoryAncestorKeys("vayDam"), []);
});

test("G4 membership accepts several categories inside one top-level tree", () => {
  const result = parseCategoryMembership(["aoDaiTet", "aoDai4Ta"], PERMISSIVE);

  assert.equal(result.topLevelKey, "aoDai");
  assert.deepEqual(result.categoryKeys, ["aoDaiTet", "aoDai4Ta"]);
});

test("G4 membership normalizes to taxonomy order regardless of admin input order", () => {
  const declared = parseCategoryMembership(["aoDaiTet", "aoDai4Ta"], PERMISSIVE);
  const reversed = parseCategoryMembership(["aoDai4Ta", "aoDaiTet"], PERMISSIVE);

  assert.deepEqual(reversed.categoryKeys, declared.categoryKeys);
});

test("G4 membership fails closed across two top-level trees", () => {
  // The owner's own counterexample: `Áo dài Tết` + `Set váy`.
  assert.throws(
    () => parseCategoryMembership(["aoDaiTet", "setVay"], PERMISSIVE),
    (error: unknown) =>
      error instanceof CategoryMembershipError &&
      error.reason === "category-membership-multiple-top-level",
  );

  // Two childless top-level categories are the same violation.
  assert.throws(
    () => parseCategoryMembership(["vayDam", "phuKien"], PERMISSIVE),
    (error: unknown) =>
      error instanceof CategoryMembershipError &&
      error.reason === "category-membership-multiple-top-level",
  );
});

test("G4 membership rejects unknown, duplicate, oversized and malformed input", () => {
  const cases: ReadonlyArray<readonly [unknown, string]> = [
    [["khong-ton-tai"], "category-membership-unknown-key"],
    // A collection slug is not a category key, and must not become one by resembling a path.
    [["ao-dai"], "category-membership-unknown-key"],
    [["aoDaiTet", "aoDaiTet"], "category-membership-duplicate"],
    [Array.from({ length: MAX_CATEGORY_MEMBERSHIPS + 1 }, () => "aoDaiTet"), "category-membership-too-many"],
    ["aoDaiTet", "category-membership-shape"],
    [null, "category-membership-shape"],
    [{ 0: "aoDaiTet" }, "category-membership-shape"],
    [[42], "category-membership-unknown-key"],
  ];

  for (const [input, reason] of cases) {
    assert.throws(
      () => parseCategoryMembership(input, PERMISSIVE),
      (error: unknown) =>
        error instanceof CategoryMembershipError && error.reason === reason,
      `expected ${reason} for ${JSON.stringify(input)}`,
    );
  }
});

test("G4 inherited object property names are not category identities", () => {
  // The lookup is Map-backed rather than an object literal, so an admin submission cannot resolve
  // a category through the prototype chain. An object-backed index would have matched several of
  // these and let `__proto__` through as a "known" key.
  for (const key of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
    assert.equal(categoryByKey(key), null, `${key} must not resolve as a category`);
    assert.throws(
      () => parseCategoryMembership([key], PERMISSIVE),
      (error: unknown) =>
        error instanceof CategoryMembershipError &&
        error.reason === "category-membership-unknown-key",
    );
  }
});

test("G4 validated membership cannot be mutated by its caller", () => {
  const result = parseCategoryMembership(["aoDaiTet"], PERMISSIVE);

  assert.throws(() => (result.categoryKeys as CategoryKey[]).push("setVay"), TypeError);
  assert.deepEqual(result.categoryKeys, ["aoDaiTet"]);
});

test("G4 an empty selection is valid and means no category", () => {
  const result = parseCategoryMembership([], PERMISSIVE);

  assert.equal(result.topLevelKey, null);
  assert.deepEqual(result.categoryKeys, []);
});

test("G4 the parent-only rule is a policy flag, not a structural choice", () => {
  // OWNER DECISION PENDING: may a product sit directly on `Áo dài` with no subcategory?
  // Both answers are expressible against the same taxonomy and the same persisted shape, so this
  // test pins that neutrality rather than pretending a decision was made.
  const parentOnly = ["aoDai"];

  assert.deepEqual(
    parseCategoryMembership(parentOnly, PERMISSIVE).categoryKeys,
    ["aoDai"],
  );
  assert.throws(
    () => parseCategoryMembership(parentOnly, LEAF_REQUIRED),
    (error: unknown) =>
      error instanceof CategoryMembershipError &&
      error.reason === "category-membership-parent-only",
  );

  // Under either policy, a parent assigned together with one of its own children is valid, and a
  // childless top-level category is always assignable since it has no leaf to require.
  for (const policy of [PERMISSIVE, LEAF_REQUIRED]) {
    assert.deepEqual(
      parseCategoryMembership(["aoDai", "aoDaiTet"], policy).categoryKeys,
      ["aoDai", "aoDaiTet"],
    );
    assert.equal(parseCategoryMembership(["vayDam"], policy).topLevelKey, "vayDam");
  }
});

test("G4 the membership bound follows the largest approved tree", () => {
  // `Áo dài` + five subcategories is the widest legitimate selection today.
  assert.equal(MAX_CATEGORY_MEMBERSHIPS, 6);
  assert.equal(
    MAX_CATEGORY_MEMBERSHIPS,
    Math.max(...TOP_LEVEL_CATEGORY_KEYS.map((key) => descendantCategoryKeys(key).length)),
  );
});

test("G4 the taxonomy stays in step with the routes and sitemap it already owns", () => {
  // The same config drives navigation, the route manifest and the sitemap. If category identity
  // ever diverged from the crawlable paths, membership would describe pages that do not exist.
  const navigationPaths = CATEGORY_NAVIGATION.flatMap((root) => [
    root.href,
    ...(root.children ?? []).map((child) => child.href),
  ]);

  assert.deepEqual(
    CATEGORY_KEYS.map((key) => categoryByKey(key)?.path),
    navigationPaths,
  );
  for (const path of navigationPaths) {
    assert.ok(
      STATIC_CANONICAL_PATHS.includes(path as (typeof STATIC_CANONICAL_PATHS)[number]),
      `${path} must stay a canonical crawlable path`,
    );
  }
});

test("G4 the integrity check catches the cross-tree state no schema can refuse", () => {
  // Review 5229201195's counterexample. The rejected composite-FK shape accepted this row because
  // the FK only compared a denormalized `topLevelKey` string; the taxonomy, which lives in code, is
  // the only thing that knows `setVay` is not under `aoDai`. So detection is where it belongs.
  const violations = findCategoryMembershipViolations([
    { productId: "P", categoryKey: "aoDaiTet" },
    { productId: "P", categoryKey: "setVay" },
  ]);

  assert.deepEqual(violations, [
    { productId: "P", reason: "multiple-top-level", categoryKeys: ["aoDaiTet", "setVay"] },
  ]);
});

test("G4 the integrity check reports stale keys a taxonomy edit left behind", () => {
  const violations = findCategoryMembershipViolations([
    { productId: "P", categoryKey: "aoDaiTet" },
    { productId: "P", categoryKey: "removedCategory" },
  ]);

  assert.deepEqual(violations, [
    { productId: "P", reason: "unknown-category", categoryKeys: ["removedCategory"] },
  ]);
});

test("G4 the integrity check passes valid memberships and scopes findings per product", () => {
  // Same tree, several nodes, and a parent alongside its child are all legitimate.
  assert.deepEqual(
    findCategoryMembershipViolations([
      { productId: "ok1", categoryKey: "aoDaiTet" },
      { productId: "ok1", categoryKey: "aoDai4Ta" },
      { productId: "ok2", categoryKey: "aoDai" },
      { productId: "ok2", categoryKey: "aoDaiTet" },
      { productId: "ok3", categoryKey: "vayDam" },
    ]),
    [],
  );
  assert.deepEqual(findCategoryMembershipViolations([]), []);

  // One bad product must not implicate its neighbours.
  const mixed = findCategoryMembershipViolations([
    { productId: "good", categoryKey: "aoDaiTet" },
    { productId: "bad", categoryKey: "aoDaiTet" },
    { productId: "bad", categoryKey: "phuKien" },
  ]);
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0]?.productId, "bad");
});
