/**
 * U12 / M2 — `/shop/<slug>?variant=<pancakeVariationId>`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_VARIANT_QUERY_LENGTH,
  VARIANT_QUERY_PARAM,
  buildStandaloneVariantDeepLinkPath,
  readVariantQueryValue,
  resolveDeepLinkedVariantSelection,
} from "../../src/commerce/storefront-variant-deep-link.ts";
import type {
  StorefrontProductProjection,
  StorefrontProjectionOption,
} from "../../src/commerce/storefront-projection.ts";

function option(overrides: Partial<StorefrontProjectionOption> = {}): StorefrontProjectionOption {
  return {
    id: "variant-mirror-cuid",
    pancakeVariationId: "pv-1",
    color: "Đen",
    size: "M",
    price: 890_000,
    basePriceVnd: 890_000,
    isDiscounted: false,
    purchasable: true,
    isPreorderSale: false,
    unavailableReason: null,
    kindKey: null,
    kindLabel: null,
    ...overrides,
  };
}

const standalone: StorefrontProductProjection = {
  mode: "standalone",
  options: [
    option({ id: "cuid-a", pancakeVariationId: "pv-a", color: "Đen", size: "M" }),
    option({ id: "cuid-b", pancakeVariationId: "pv-b", color: "Đen", size: "L", price: 910_000 }),
    option({ id: "cuid-c", pancakeVariationId: "pv-c", color: "Kem", size: "M" }),
  ],
};

test("U12 the query parameter is the reviewed one", () => {
  assert.equal(VARIANT_QUERY_PARAM, "variant");
});

test("U12 a valid standalone variation preselects exactly that option", () => {
  assert.deepEqual(
    resolveDeepLinkedVariantSelection({ projection: standalone, variantQuery: "pv-b" }),
    { kindKey: null, color: "Đen", size: "L", variantId: "cuid-b" },
  );
});

test("U12 a different valid variation preselects its own option, not the first", () => {
  assert.deepEqual(
    resolveDeepLinkedVariantSelection({ projection: standalone, variantQuery: "pv-c" }),
    { kindKey: null, color: "Kem", size: "M", variantId: "cuid-c" },
  );
});

test("U12 a forged variation id selects nothing", () => {
  for (const forged of ["pv-does-not-exist", "../../etc/passwd", "%00", "pv-a "]) {
    assert.equal(resolveDeepLinkedVariantSelection({ projection: standalone, variantQuery: forged }), null);
  }
});

test("U12 the internal VariantMirror id is never accepted as the external query identity", () => {
  assert.equal(resolveDeepLinkedVariantSelection({ projection: standalone, variantQuery: "cuid-a" }), null);
});

test("U12 a stale or inactive variation absent from the projection selects nothing", () => {
  const withoutB: StorefrontProductProjection = {
    mode: "standalone",
    options: standalone.options.filter((entry) => entry.pancakeVariationId !== "pv-b"),
  };
  assert.equal(resolveDeepLinkedVariantSelection({ projection: withoutB, variantQuery: "pv-b" }), null);
});

test("U12 a variation belonging to another product selects nothing", () => {
  assert.equal(
    resolveDeepLinkedVariantSelection({ projection: standalone, variantQuery: "pv-other-product" }),
    null,
  );
});

test("U12 a valid current variation that is merely sold out stays addressable", () => {
  const projection: StorefrontProductProjection = {
    mode: "standalone",
    options: [option({ id: "cuid-oos", pancakeVariationId: "pv-oos", purchasable: false, unavailableReason: "OUT_OF_STOCK" })],
  };
  assert.deepEqual(
    resolveDeepLinkedVariantSelection({ projection, variantQuery: "pv-oos" }),
    { kindKey: null, color: "Đen", size: "M", variantId: "cuid-oos" },
  );
});

test("U12 mapping/ambiguity failures are refused as non-addressable", () => {
  for (const unavailableReason of ["MAPPING_REQUIRED", "AMBIGUOUS_OPTION"] as const) {
    const projection: StorefrontProductProjection = {
      mode: "standalone",
      options: [option({ pancakeVariationId: "pv-unresolvable", purchasable: false, unavailableReason })],
    };
    assert.equal(
      resolveDeepLinkedVariantSelection({ projection, variantQuery: "pv-unresolvable" }),
      null,
    );
  }
});

test("U12 a variation whose price cannot be resolved is still addressable", () => {
  const projection: StorefrontProductProjection = {
    mode: "standalone",
    options: [option({ id: "cuid-unpriced", pancakeVariationId: "pv-unpriced", price: null, basePriceVnd: null, purchasable: false, unavailableReason: "PRICE_UNRESOLVED" })],
  };
  assert.equal(
    resolveDeepLinkedVariantSelection({ projection, variantQuery: "pv-unpriced" })?.variantId,
    "cuid-unpriced",
  );
});

test("U12 a composite product rejects the deep link entirely", () => {
  const composite: StorefrontProductProjection = {
    mode: "composite",
    options: [option({ pancakeVariationId: "pv-component", kindKey: "ao-thun", kindLabel: "Áo thun" })],
  };
  assert.equal(
    resolveDeepLinkedVariantSelection({ projection: composite, variantQuery: "pv-component" }),
    null,
  );
});

test("U12 an ambiguous projection never guesses which option was meant", () => {
  const duplicated: StorefrontProductProjection = {
    mode: "standalone",
    options: [
      option({ id: "cuid-x", pancakeVariationId: "pv-dup", size: "M" }),
      option({ id: "cuid-y", pancakeVariationId: "pv-dup", size: "L" }),
    ],
  };
  assert.equal(resolveDeepLinkedVariantSelection({ projection: duplicated, variantQuery: "pv-dup" }), null);
});

test("U12 the query value is bounded before it is matched", () => {
  const atBound = "x".repeat(MAX_VARIANT_QUERY_LENGTH);
  const overBound = "x".repeat(MAX_VARIANT_QUERY_LENGTH + 1);
  assert.equal(readVariantQueryValue(atBound), atBound);
  assert.equal(readVariantQueryValue(overBound), null);
});

test("U12 absent, empty and repeated query values resolve to no preselection", () => {
  assert.equal(readVariantQueryValue(undefined), null);
  assert.equal(readVariantQueryValue(""), null);
  assert.equal(readVariantQueryValue(["pv-a", "pv-b"]), null);
  assert.equal(readVariantQueryValue(["pv-a"]), null);
});

test("U12 a null query resolves to no preselection without touching the projection", () => {
  assert.equal(resolveDeepLinkedVariantSelection({ projection: standalone, variantQuery: null }), null);
});

test("U12 the exact standalone deep-link path is built from the same owned contract", () => {
  assert.equal(
    buildStandaloneVariantDeepLinkPath({ slug: "ao-so-mi-oxford", pancakeVariationId: "pv-a" }),
    "/shop/ao-so-mi-oxford?variant=pv-a",
  );
  assert.equal(
    buildStandaloneVariantDeepLinkPath({ slug: "ao-so-mi-oxford", pancakeVariationId: "pv a" }),
    "/shop/ao-so-mi-oxford?variant=pv%20a",
  );
  assert.equal(
    buildStandaloneVariantDeepLinkPath({
      slug: "ao-so-mi-oxford",
      pancakeVariationId: "a/b?c#d&e",
    }),
    "/shop/ao-so-mi-oxford?variant=a%2Fb%3Fc%23d%26e",
  );
});

test("U12 an unsafe slug or variation identity cannot produce a deep-link path", () => {
  const rejectedSlugs = [
    "",
    " ",
    "Ao-So-Mi",
    "ao so mi",
    "ao/so/mi",
    "../admin",
    "ao-so-mi/",
    "-ao",
    "ao-",
    "ao--mi",
    "a".repeat(161),
  ];
  for (const slug of rejectedSlugs) {
    assert.equal(
      buildStandaloneVariantDeepLinkPath({ slug, pancakeVariationId: "pv-a" }),
      null,
      `expected slug ${JSON.stringify(slug)} to be refused`,
    );
  }

  assert.equal(
    buildStandaloneVariantDeepLinkPath({ slug: "ao-so-mi", pancakeVariationId: "" }),
    null,
  );
  assert.equal(
    buildStandaloneVariantDeepLinkPath({
      slug: "ao-so-mi",
      pancakeVariationId: "x".repeat(MAX_VARIANT_QUERY_LENGTH + 1),
    }),
    null,
  );
});

test("U12 a built deep-link path round-trips through the resolver it was built for", () => {
  const path = buildStandaloneVariantDeepLinkPath({
    slug: "ao-so-mi-oxford",
    pancakeVariationId: "pv-b",
  });
  assert.ok(path !== null);

  const url = new URL(path, "https://example.test");
  assert.deepEqual(
    resolveDeepLinkedVariantSelection({
      projection: standalone,
      variantQuery: readVariantQueryValue(url.searchParams.get(VARIANT_QUERY_PARAM)),
    }),
    { kindKey: null, color: "Đen", size: "L", variantId: "cuid-b" },
  );
});
