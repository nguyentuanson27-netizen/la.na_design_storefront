import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_CATEGORY_PRODUCT_ORDER,
  MAX_HOMEPAGE_FEATURED_PRODUCTS,
  MAX_RELATED_PRODUCT_OVERRIDES,
  MerchandisingError,
  parseCategoryEditorialMedia,
  parseCategoryProductOrder,
  parseHomepageFeaturedSelection,
  parseOrderedProductSelection,
  parseRelatedProductOverrides,
} from "../../src/commerce/merchandising-input.ts";

function reasonOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof MerchandisingError, `expected MerchandisingError, got ${error}`);
    return error.reason;
  }
  throw new assert.AssertionError({ message: "expected a MerchandisingError, but none was thrown" });
}

test("M2 an ordered selection keeps the admin's order and rejects nonsense", () => {
  assert.deepEqual(parseOrderedProductSelection(["b", "a", "c"], { max: 5 }), ["b", "a", "c"]);

  assert.equal(reasonOf(() => parseOrderedProductSelection("not-an-array", { max: 5 })), "merchandising-shape");
  assert.equal(reasonOf(() => parseOrderedProductSelection(["a", "b"], { max: 1 })), "merchandising-too-many");
  assert.equal(reasonOf(() => parseOrderedProductSelection(["a", "a"], { max: 5 })), "merchandising-duplicate-product");
  assert.equal(reasonOf(() => parseOrderedProductSelection([""], { max: 5 })), "merchandising-invalid-product");
  assert.equal(reasonOf(() => parseOrderedProductSelection(["   "], { max: 5 })), "merchandising-invalid-product");
  assert.equal(reasonOf(() => parseOrderedProductSelection([7], { max: 5 })), "merchandising-invalid-product");
  assert.equal(reasonOf(() => parseOrderedProductSelection([null], { max: 5 })), "merchandising-invalid-product");
  assert.equal(
    reasonOf(() => parseOrderedProductSelection(["x".repeat(65)], { max: 5 })),
    "merchandising-invalid-product",
  );
});

test("M2 a duplicate is refused rather than silently collapsed", () => {
  // Collapsing would shorten the list without telling the admin, so the surface would quietly
  // render fewer slots than they filled in.
  assert.equal(
    reasonOf(() => parseHomepageFeaturedSelection(["p1", "p2", "p1"])),
    "merchandising-duplicate-product",
  );
});

test("M2 an empty Featured selection is valid and means an empty section", () => {
  // Master spec §20 forbids falling back to newest/bestseller logic, so "clear the section" has to
  // be expressible. A parser that rejected [] would make the only way to empty it a manual DB edit.
  assert.deepEqual(parseHomepageFeaturedSelection([]).productIds, []);
});

test("M2 the Featured selection is bounded", () => {
  const tooMany = Array.from({ length: MAX_HOMEPAGE_FEATURED_PRODUCTS + 1 }, (_, i) => `p${i}`);
  assert.equal(reasonOf(() => parseHomepageFeaturedSelection(tooMany)), "merchandising-too-many");

  const atLimit = Array.from({ length: MAX_HOMEPAGE_FEATURED_PRODUCTS }, (_, i) => `p${i}`);
  assert.equal(parseHomepageFeaturedSelection(atLimit).productIds.length, MAX_HOMEPAGE_FEATURED_PRODUCTS);
});

test("M3b a category ranking resolves its category against the taxonomy", () => {
  const parsed = parseCategoryProductOrder({ categoryKey: "aoDaiTet", productIds: ["p2", "p1"] });
  assert.equal(parsed.categoryKey, "aoDaiTet");
  assert.deepEqual(parsed.productIds, ["p2", "p1"]);

  assert.equal(
    reasonOf(() => parseCategoryProductOrder({ categoryKey: "notACategory", productIds: [] })),
    "merchandising-unknown-category",
  );
  assert.equal(
    reasonOf(() => parseCategoryProductOrder({ categoryKey: 42, productIds: [] })),
    "merchandising-unknown-category",
  );
  assert.equal(reasonOf(() => parseCategoryProductOrder(null)), "merchandising-shape");
  assert.equal(reasonOf(() => parseCategoryProductOrder("aoDaiTet")), "merchandising-shape");
});

test("M3b a category key from the prototype chain is not a category", () => {
  // `categoryByKey` is Map-backed precisely so these resolve to nothing rather than to Object.prototype.
  for (const key of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    assert.equal(
      reasonOf(() => parseCategoryProductOrder({ categoryKey: key, productIds: [] })),
      "merchandising-unknown-category",
      `${key} must not resolve to a category`,
    );
  }
});

test("M3b the category ranking is bounded", () => {
  const tooMany = Array.from({ length: MAX_CATEGORY_PRODUCT_ORDER + 1 }, (_, i) => `p${i}`);
  assert.equal(
    reasonOf(() => parseCategoryProductOrder({ categoryKey: "vayDam", productIds: tooMany })),
    "merchandising-too-many",
  );
});

test("M3a a related override rejects self-reference", () => {
  // Refused here *and* by the RelatedProductOverride_no_self_reference CHECK. Two gates, because
  // this predicate is intra-row and therefore one the database genuinely can enforce.
  assert.equal(
    reasonOf(() => parseRelatedProductOverrides({ productId: "p1", relatedProductIds: ["p2", "p1"] })),
    "merchandising-self-reference",
  );
});

test("M3a a related override validates its source product and bound", () => {
  const parsed = parseRelatedProductOverrides({ productId: " p1 ", relatedProductIds: ["p3", "p2"] });
  assert.equal(parsed.productId, "p1");
  assert.deepEqual(parsed.relatedProductIds, ["p3", "p2"]);

  assert.equal(
    reasonOf(() => parseRelatedProductOverrides({ productId: "", relatedProductIds: [] })),
    "merchandising-invalid-product",
  );
  assert.equal(
    reasonOf(() => parseRelatedProductOverrides({ relatedProductIds: [] })),
    "merchandising-invalid-product",
  );

  const tooMany = Array.from({ length: MAX_RELATED_PRODUCT_OVERRIDES + 1 }, (_, i) => `r${i}`);
  assert.equal(
    reasonOf(() => parseRelatedProductOverrides({ productId: "p1", relatedProductIds: tooMany })),
    "merchandising-too-many",
  );
});

test("M2 editorial media accepts absence as absence and refuses an untrusted host", () => {
  const cleared = parseCategoryEditorialMedia({
    categoryKey: "aoDai",
    heroImageUrl: "",
    megaMenuImageUrl: null,
  });
  assert.equal(cleared.heroImageUrl, null);
  assert.equal(cleared.megaMenuImageUrl, null);

  assert.deepEqual(
    parseCategoryEditorialMedia({ categoryKey: "aoDai" }),
    { categoryKey: "aoDai", heroImageUrl: null, megaMenuImageUrl: null },
  );

  // A present-but-untrusted URL is a refusal, not a silent null: nulling it would be
  // indistinguishable from clearing the field and would hide the mistake from the admin.
  for (const url of [
    "http://evil.example.com/a.jpg",
    "javascript:alert(1)",
    "//evil.example.com/a.jpg",
    "data:image/png;base64,AAAA",
  ]) {
    assert.equal(
      reasonOf(() => parseCategoryEditorialMedia({ categoryKey: "aoDai", heroImageUrl: url })),
      "merchandising-invalid-media-url",
      `${url} must be refused`,
    );
  }
});

test("M2 editorial media keeps hero and mega-menu as independent fields", () => {
  // ADR §6: two surfaces with distinct crops. Setting one must not imply or overwrite the other.
  const parsed = parseCategoryEditorialMedia({
    categoryKey: "setDo",
    heroImageUrl: "https://content.pancake.vn/catalog/1/2/3/hero.jpg",
    megaMenuImageUrl: null,
  });

  assert.equal(parsed.categoryKey, "setDo");
  assert.ok(parsed.heroImageUrl?.startsWith("https://"));
  assert.equal(parsed.megaMenuImageUrl, null);
});
