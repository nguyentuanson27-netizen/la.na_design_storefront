import assert from "node:assert/strict";
import test from "node:test";

import type { CategoryKey } from "../../src/commerce/category-taxonomy.ts";
import {
  MAX_RELATED_PRODUCTS,
  listRelatedStorefrontProducts,
  type CategoryRankedProduct,
} from "../../src/commerce/storefront-related-products.ts";

type Product = Readonly<{ id: string; name: string }>;

function product(id: string, name = id.toUpperCase()): Product {
  return { id, name };
}

function ranked(id: string, position: number | null, name?: string): CategoryRankedProduct<Product> {
  return { product: product(id, name), position };
}

/**
 * A resolver harness that records which categories were visited, so the traversal order — not just
 * the final list — can be asserted. ADR 0013 §7 specifies both, and a test that only checks the
 * output cannot tell "visited in declared order" from "happened to produce the same four".
 */
function harness({
  categoryKeys = [],
  overrides = [],
  byCategory = {},
  limit,
}: {
  categoryKeys?: readonly CategoryKey[];
  overrides?: readonly Product[];
  byCategory?: Readonly<Record<string, readonly CategoryRankedProduct<Product>[]>>;
  limit?: number;
}) {
  const visited: string[] = [];

  return {
    visited,
    run: () =>
      listRelatedStorefrontProducts<Product>({
        currentProduct: { id: "source", categoryKeys },
        loadManualOverrides: async () => overrides,
        loadCategoryCandidates: async (categoryKey) => {
          visited.push(categoryKey);
          return byCategory[categoryKey] ?? [];
        },
        ...(limit === undefined ? {} : { limit }),
      }),
  };
}

test("M3a manual overrides come first, in the admin's order", async () => {
  const { run, visited } = harness({
    categoryKeys: ["aoDaiTet"],
    overrides: [product("pinned-b"), product("pinned-a")],
    byCategory: { aoDaiTet: [ranked("auto", null)] },
  });

  const related = await run();

  // Admin order is preserved, not re-sorted by name: "pinned-b" was picked first.
  assert.deepEqual(
    related.map((p) => p.id),
    ["pinned-b", "pinned-a", "auto"],
  );
  assert.deepEqual(visited, ["aoDaiTet", "aoDai", "aoDaiCachTan", "aoDaiCuoi", "aoDai4Ta", "aoDai6Ta"]);
});

test("M3a the source product never appears in its own related list", async () => {
  const { run } = harness({
    categoryKeys: ["vayDam"],
    overrides: [product("source")],
    byCategory: { vayDam: [ranked("source", 0), ranked("other", 1)] },
  });

  const related = await run();

  assert.deepEqual(
    related.map((p) => p.id),
    ["other"],
  );
});

test("M3a a product qualifying twice keeps its earliest placement", async () => {
  // "shared" is both a manual pick and a category candidate. Manual order must win: §7 requires
  // manual picks to stay ahead of any filled candidate.
  const { run } = harness({
    categoryKeys: ["setVay"],
    overrides: [product("shared")],
    byCategory: { setVay: [ranked("first", 0), ranked("shared", 1)] },
  });

  const related = await run();

  assert.deepEqual(
    related.map((p) => p.id),
    ["shared", "first"],
  );
});

test("M3a within one category, ranked products precede unranked ones", async () => {
  // The boundary M3a must pin: an unranked product with a name that sorts first still loses to any
  // merchandised rank, because rank is a decision and name is only a tie-break.
  const { run } = harness({
    categoryKeys: ["phuKien"],
    byCategory: {
      phuKien: [
        ranked("unranked-early", null, "AAA"),
        ranked("ranked-late", 9, "ZZZ"),
        ranked("ranked-early", 1, "MMM"),
      ],
    },
  });

  const related = await run();

  assert.deepEqual(
    related.map((p) => p.id),
    ["ranked-early", "ranked-late", "unranked-early"],
  );
});

test("M3a unranked products fall back to name, then id", async () => {
  const { run } = harness({
    categoryKeys: ["phuKien"],
    byCategory: {
      phuKien: [
        ranked("z-id", null, "Same Name"),
        ranked("a-id", null, "Same Name"),
        ranked("b-id", null, "Another Name"),
      ],
    },
  });

  const related = await run();

  // "Another Name" sorts before "Same Name"; the two identical names tie-break on id, which is
  // unique and never null, so no tie reaches the database's discretion.
  assert.deepEqual(
    related.map((p) => p.id),
    ["b-id", "a-id", "z-id"],
  );
});

test("M3a several assigned categories are visited in the taxonomy's declared order", async () => {
  // Input order is deliberately reversed relative to the taxonomy. The stored set and the traversal
  // must agree, so a product's related list cannot depend on the order an admin ticked the boxes.
  const { run, visited } = harness({
    categoryKeys: ["aoDai6Ta", "aoDaiCachTan"],
    byCategory: {
      aoDaiCachTan: [ranked("from-cach-tan", null)],
      aoDai6Ta: [ranked("from-6-ta", null)],
    },
  });

  const related = await run();

  assert.deepEqual(visited.slice(0, 2), ["aoDaiCachTan", "aoDai6Ta"]);
  assert.deepEqual(
    related.map((p) => p.id),
    ["from-cach-tan", "from-6-ta"],
  );
});

test("M3a the assigned subcategory is exhausted before the tree is widened", async () => {
  const { run, visited } = harness({
    categoryKeys: ["aoDaiTet"],
    byCategory: {
      aoDaiTet: [ranked("same-subcategory", null, "ZZZ")],
      aoDaiCuoi: [ranked("same-tree", null, "AAA")],
    },
  });

  const related = await run();

  // "same-tree" has the name that sorts first, and still comes second: stage 2 is a closer
  // relationship than stage 3, and names only order *within* a category.
  assert.deepEqual(
    related.map((p) => p.id),
    ["same-subcategory", "same-tree"],
  );
  assert.equal(visited[0], "aoDaiTet");
  assert.ok(visited.indexOf("aoDaiCuoi") > 0);
});

test("M3a widening stays inside the product's own tree", async () => {
  const { run, visited } = harness({
    categoryKeys: ["aoDaiTet"],
    byCategory: { setVay: [ranked("other-tree", null)] },
  });

  const related = await run();

  assert.deepEqual(related, []);
  assert.ok(!visited.includes("setVay"), "a Set đồ category must never be visited for an Áo dài product");
  assert.ok(!visited.includes("vayDam"));
});

test("M3a a product with no categories and no overrides has no related products", async () => {
  // §7 step 4: no collection fallback at any stage. The superseded implementation would have
  // returned whatever else shared a collection; the approved contract returns nothing.
  const { run, visited } = harness({ categoryKeys: [], overrides: [] });

  assert.deepEqual(await run(), []);
  assert.deepEqual(visited, []);
});

test("M3a resolution stops once the limit is filled", async () => {
  const { run, visited } = harness({
    categoryKeys: ["aoDaiTet"],
    byCategory: {
      aoDaiTet: [
        ranked("a", 0),
        ranked("b", 1),
        ranked("c", 2),
        ranked("d", 3),
        ranked("e", 4),
      ],
      aoDai: [ranked("never-reached", null)],
    },
  });

  const related = await run();

  assert.equal(related.length, MAX_RELATED_PRODUCTS);
  assert.deepEqual(
    related.map((p) => p.id),
    ["a", "b", "c", "d"],
  );
  // The first category already filled the list, so no further category was loaded at all.
  assert.deepEqual(visited, ["aoDaiTet"]);
});

test("M3a a category key missing from the taxonomy is skipped, not thrown on", async () => {
  // A retired key must not 500 a PDP. ADR §4.8's pre-activation gate and findOrphanedCategoryKeys()
  // are what surface it; the read path degrades to the keys it still understands.
  const { run, visited } = harness({
    categoryKeys: ["retiredCategory", "vayDam"],
    byCategory: { vayDam: [ranked("still-listed", null)] },
  });

  const related = await run();

  assert.deepEqual(
    related.map((p) => p.id),
    ["still-listed"],
  );
  assert.deepEqual(visited, ["vayDam"]);
});

test("M3a a cross-tree product still resolves deterministically", async () => {
  // The §4.6 admin boundary cannot produce this, but a fixture or repair query can, and
  // findCategoryMembershipViolations() is what reports it. What matters here is that the read path
  // does not depend on row order: the first assigned key in declared order decides the tree.
  const first = await harness({
    categoryKeys: ["setVay", "aoDaiTet"],
    byCategory: { aoDaiTet: [ranked("a", null)], setVay: [ranked("s", null)] },
  }).run();

  const reversed = await harness({
    categoryKeys: ["aoDaiTet", "setVay"],
    byCategory: { aoDaiTet: [ranked("a", null)], setVay: [ranked("s", null)] },
  }).run();

  assert.deepEqual(
    first.map((p) => p.id),
    reversed.map((p) => p.id),
    "input order must not change the result",
  );
  // "aoDaiTet" precedes "setVay" in the declared order, so the Áo dài tree wins both times.
  assert.deepEqual(
    first.map((p) => p.id),
    ["a", "s"],
  );
});

test("M3a a non-positive or malformed limit yields no related products", async () => {
  for (const limit of [0, -1, 1.5, Number.NaN]) {
    const { run, visited } = harness({
      categoryKeys: ["vayDam"],
      overrides: [product("pinned")],
      byCategory: { vayDam: [ranked("auto", null)] },
      limit,
    });

    assert.deepEqual(await run(), [], `limit ${limit} must fail closed`);
    assert.deepEqual(visited, []);
  }
});
