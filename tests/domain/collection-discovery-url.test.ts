import assert from "node:assert/strict";
import test from "node:test";

import { buildCategoryDiscoveryHref } from "../../src/commerce/category-discovery-url.ts";
import {
  collectionListingPath,
  isCollectionDefaultSort,
  parseCollectionDiscoverySearchParams,
  parseCollectionListingSearchParams,
} from "../../src/commerce/collection-discovery-url.ts";

test("the collection listing reads the category vocabulary and keeps the route slug authoritative", () => {
  const listing = parseCollectionListingSearchParams("city-uniform", {
    collection: "forged-collection",
    size: " M ",
    color: "Black",
    availability: "in-stock",
    minPrice: "100000",
    maxPrice: "500000",
    sale: "true",
    sort: "price-desc",
    page: "2",
    q: "ignored",
  });

  assert.deepEqual(listing.discovery, {
    query: null,
    color: "Black",
    size: "M",
    availability: "in-stock",
    minPriceVnd: 100_000,
    maxPriceVnd: 500_000,
    sale: true,
    collection: "city-uniform",
    sort: "price-desc",
    page: 2,
  });
  assert.deepEqual(listing.filters, {
    size: "M",
    color: "Black",
    availability: "in-stock",
    minPriceVnd: 100_000,
    maxPriceVnd: 500_000,
    sale: true,
    sort: "price-desc",
  });
  assert.equal(listing.merchandiserOrder, false);
});

test("no sort is the merchandiser's order: the panel sees `default`, the repository the collection's own order", () => {
  const plain = parseCollectionListingSearchParams("city-uniform", {});
  assert.equal(plain.filters.sort, "default");
  assert.equal(plain.discovery.sort, "name-asc");
  assert.equal(plain.merchandiserOrder, true);

  const priced = parseCollectionListingSearchParams("xa-hang-chao-thu", {});
  assert.equal(priced.discovery.sort, "price-asc", "a collection that defaults to price keeps that order");
  assert.equal(priced.merchandiserOrder, true);

  // A shopper who picks a name order explicitly is no longer in the merchandiser's order: no pins.
  assert.equal(parseCollectionListingSearchParams("city-uniform", { sort: "name-asc" }).merchandiserOrder, false);
});

test("`sale=false` narrows nothing, as on the category listing", () => {
  const listing = parseCollectionListingSearchParams("city-uniform", { sale: "false" });
  assert.equal(listing.discovery.sale, null);
  assert.equal(listing.filters.sale, null);
});

test("the grid's cursor resolves to the page it names", () => {
  const cursor = Buffer.from(JSON.stringify({ p: 3 })).toString("base64url");
  assert.equal(parseCollectionListingSearchParams("city-uniform", { cursor }).discovery.page, 3);
});

test("the collection listing fails closed for malformed state", () => {
  for (const searchParams of [
    { size: ["M", "L"] },
    { sort: "newest" },
    { page: "0" },
    { size: "x".repeat(65) },
    { availability: "all" },
    { minPrice: "abc" },
    { minPrice: "500", maxPrice: "100" },
    { sale: "maybe" },
  ]) {
    assert.throws(
      () => parseCollectionListingSearchParams("city-uniform", searchParams),
      /invalid/i,
      JSON.stringify(searchParams),
    );
  }
  assert.throws(() => parseCollectionListingSearchParams("../forged", {}), /invalid/i);
  assert.throws(() => collectionListingPath("../forged"), /invalid/i);
});

test("the panel's links round-trip through the collection parser", () => {
  const basePath = collectionListingPath("city-uniform");
  assert.equal(basePath, "/collections/city-uniform");

  const { filters } = parseCollectionListingSearchParams("city-uniform", {
    size: "M",
    availability: "in-stock",
    minPrice: "100000",
    sale: "true",
    sort: "price-asc",
  });
  const href = buildCategoryDiscoveryHref(basePath, filters, 2);
  assert.equal(href, "/collections/city-uniform?size=M&minPrice=100000&availability=in-stock&sale=true&sort=price-asc&page=2");

  const query = Object.fromEntries(new URL(href, "https://example.test").searchParams);
  const reparsed = parseCollectionListingSearchParams("city-uniform", query);
  assert.deepEqual(reparsed.filters, filters);
  assert.equal(reparsed.discovery.page, 2);

  // The merchandiser's order writes no sort at all, so the unfiltered URL stays the bare path.
  assert.equal(
    buildCategoryDiscoveryHref(basePath, parseCollectionListingSearchParams("city-uniform", {}).filters),
    "/collections/city-uniform",
  );
});

test("the repository query of a collection URL is the listing's own", () => {
  assert.deepEqual(
    parseCollectionDiscoverySearchParams("city-uniform", { size: "M" }),
    parseCollectionListingSearchParams("city-uniform", { size: "M" }).discovery,
  );
});

test("the repository's fallback treats the collection's own order as its default", () => {
  assert.equal(isCollectionDefaultSort("city-uniform", "name-asc"), true);
  assert.equal(isCollectionDefaultSort("city-uniform", "price-asc"), false);
  assert.equal(isCollectionDefaultSort("xa-hang-chao-thu", "price-asc"), true);
  assert.equal(isCollectionDefaultSort("xa-hang-chao-thu", "name-asc"), false);
});
