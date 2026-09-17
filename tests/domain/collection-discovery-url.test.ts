import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCollectionDiscoveryHref,
  parseCollectionDiscoverySearchParams,
} from "../../src/commerce/collection-discovery-url.ts";

test("U3 collection parser keeps route slug authoritative and accepts only Sort + Size + page state", () => {
  assert.deepEqual(
    parseCollectionDiscoverySearchParams("city-uniform", {
      collection: "forged-collection",
      size: " M ",
      sort: "price-desc",
      page: "2",
      color: "Black",
      q: "ignored",
    }),
    {
      query: null,
      color: null,
      size: "M",
      availability: null,
      minPriceVnd: null,
      maxPriceVnd: null,
      sale: null,
      collection: "city-uniform",
      sort: "price-desc",
      page: 2,
    },
  );
});

test("U3 collection parser fails closed for malformed supported state", () => {
  assert.throws(
    () => parseCollectionDiscoverySearchParams("city-uniform", { size: ["M", "L"] }),
    /invalid/i,
  );
  assert.throws(
    () => parseCollectionDiscoverySearchParams("city-uniform", { sort: "newest" }),
    /invalid/i,
  );
  assert.throws(
    () => parseCollectionDiscoverySearchParams("city-uniform", { page: "0" }),
    /invalid/i,
  );
  assert.throws(
    () => parseCollectionDiscoverySearchParams("city-uniform", { size: "x".repeat(65) }),
    /invalid/i,
  );
  assert.throws(
    () => parseCollectionDiscoverySearchParams("../forged", {}),
    /invalid/i,
  );
});

test("U3 collection serializer strips defaults and never emits route-owned collection identity", () => {
  assert.equal(
    buildCollectionDiscoveryHref("city-uniform", {
      size: null,
      sort: "name-asc",
      page: 1,
    }),
    "/collections/city-uniform",
  );
  assert.equal(
    buildCollectionDiscoveryHref("city-uniform", {
      size: null,
      sort: "name-asc",
      page: 2,
    }),
    "/collections/city-uniform?page=2",
  );
  assert.equal(
    buildCollectionDiscoveryHref("city-uniform", {
      size: "M",
      sort: "name-asc",
      page: 1,
    }),
    "/collections/city-uniform?size=M",
  );
  assert.equal(
    buildCollectionDiscoveryHref("city-uniform", {
      size: "M",
      sort: "price-desc",
      page: 3,
    }),
    "/collections/city-uniform?size=M&sort=price-desc&page=3",
  );
});

test("U3 control changes reset pagination while preserving the other active control", () => {
  const current = parseCollectionDiscoverySearchParams("city-uniform", {
    size: "M",
    sort: "price-desc",
    page: "7",
  });

  assert.equal(
    buildCollectionDiscoveryHref("city-uniform", {
      size: current.size,
      sort: "name-asc",
      page: 1,
    }),
    "/collections/city-uniform?size=M",
  );
  assert.equal(
    buildCollectionDiscoveryHref("city-uniform", {
      size: "S",
      sort: current.sort,
      page: 1,
    }),
    "/collections/city-uniform?size=S&sort=price-desc",
  );
  assert.equal(
    buildCollectionDiscoveryHref("city-uniform", {
      size: null,
      sort: current.sort,
      page: 1,
    }),
    "/collections/city-uniform?sort=price-desc",
  );
});
