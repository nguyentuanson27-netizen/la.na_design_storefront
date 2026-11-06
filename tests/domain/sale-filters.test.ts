import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildCategoryDiscoveryHref,
  parseSaleDiscoverySearchParams,
} from "../../src/commerce/category-discovery-url.ts";
import { buildFlashSaleViewModel } from "../../src/routes/flash-sale-model.ts";
import type { PlpFilterState } from "../../src/components/headless/plp-filter-model.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (relativePath: string) => readFileSync(path.join(REPO_ROOT, relativePath), "utf8");

const NO_FILTERS: PlpFilterState = {
  size: null,
  color: null,
  availability: null,
  minPriceVnd: null,
  maxPriceVnd: null,
  sale: null,
  sort: "default",
};

test("the sale parser reads size, colour, price band, sort and page, and defaults to the cheapest-first order", () => {
  assert.deepEqual(parseSaleDiscoverySearchParams({}), {
    query: null,
    color: null,
    size: null,
    availability: null,
    minPriceVnd: null,
    maxPriceVnd: null,
    sale: null,
    collection: null,
    sort: "default",
    page: 1,
  });
  assert.deepEqual(
    parseSaleDiscoverySearchParams({
      size: " M ",
      color: "white",
      minPrice: "100000",
      maxPrice: "500000",
      sort: "price-desc",
      page: "3",
    }),
    {
      query: null,
      color: "white",
      size: "M",
      availability: null,
      minPriceVnd: 100000,
      maxPriceVnd: 500000,
      sale: null,
      collection: null,
      sort: "price-desc",
      page: 3,
    },
  );
});

test("the sale parser ignores what a sale listing cannot narrow, and rejects malformed values like every listing", () => {
  const parsed = parseSaleDiscoverySearchParams({ availability: "in-stock", sale: "true", q: "ao", collection: "x" });
  assert.equal(parsed.availability, null);
  assert.equal(parsed.sale, null);
  assert.equal(parsed.query, null);
  assert.equal(parsed.collection, null);

  assert.throws(() => parseSaleDiscoverySearchParams({ sort: "newest" }), RangeError);
  assert.throws(() => parseSaleDiscoverySearchParams({ minPrice: "abc" }), RangeError);
  assert.throws(() => parseSaleDiscoverySearchParams({ minPrice: "500", maxPrice: "100" }), RangeError);
  assert.throws(() => parseSaleDiscoverySearchParams({ page: "0" }), RangeError);
  assert.throws(() => parseSaleDiscoverySearchParams({ size: ["M", "L"] }), RangeError);
});

test("a link the filter panel builds is read back as the same choices", () => {
  const state: PlpFilterState = { ...NO_FILTERS, size: "L", minPriceVnd: 200000, sort: "name-asc" };
  const href = buildCategoryDiscoveryHref("/sale/uu-dai", state, 2);
  const params = Object.fromEntries(new URL(href, "https://example.test").searchParams);
  const parsed = parseSaleDiscoverySearchParams(params);
  assert.equal(parsed.size, "L");
  assert.equal(parsed.minPriceVnd, 200000);
  assert.equal(parsed.sort, "name-asc");
  assert.equal(parsed.page, 2);
});

function model(filters: { active: PlpFilterState; availableSizes: readonly string[] } | undefined, page = 2) {
  return buildFlashSaleViewModel({
    basePath: "/sale",
    products: [],
    totalCount: 90,
    totalPages: 4,
    page,
    pageSize: 24,
    selectEventBySlug: new Map(),
    filters,
  });
}

test("paging links keep the chosen filters and sort", () => {
  const view = model({ active: { ...NO_FILTERS, size: "M", maxPriceVnd: 900000, sort: "price-desc" }, availableSizes: ["S", "M"] });
  assert.equal(view.previousHref, "/sale?size=M&maxPrice=900000&sort=price-desc");
  assert.equal(view.nextHref, "/sale?size=M&maxPrice=900000&sort=price-desc&page=3");
});

test("with no filters chosen the paging links are the bare ones, and a listing without filters is unchanged", () => {
  const plain = model({ active: NO_FILTERS, availableSizes: [] });
  assert.equal(plain.previousHref, "/sale");
  assert.equal(plain.nextHref, "/sale?page=3");
  assert.equal(plain.filters?.filtered, false);

  const withoutFilters = model(undefined);
  assert.equal(withoutFilters.filters, null);
  assert.equal(withoutFilters.previousHref, "/sale?page=1");
  assert.equal(withoutFilters.nextHref, "/sale?page=3");
});

test("the model says whether the shopper chose anything, so an empty result reads as 'no match'", () => {
  assert.equal(model({ active: { ...NO_FILTERS, color: "white" }, availableSizes: [] }).filters?.filtered, true);
  assert.equal(model({ active: { ...NO_FILTERS, sort: "name-asc" }, availableSizes: [] }).filters?.filtered, true);
  assert.equal(model({ active: NO_FILTERS, availableSizes: [] }).filters?.filtered, false);
});

test("every sale listing draws the shared filter bar without the controls that cannot narrow a sale", () => {
  const body = read("src/components/brand/sale-listing.tsx");
  assert.match(body, /<PlpFilterPanel/, "the category filter bar is reused");
  assert.match(body, /offerAvailability=\{false\}/, "no 'Còn hàng': everything on sale is in stock");
  assert.match(body, /saleAvailable=\{false\}/, "no 'Sale' toggle: everything here is on sale");
  assert.match(body, /countLabel=\{countLabel\}/, "the hidden live count keeps the listing's own wording");
  assert.match(body, /categoryPath=\{filters\.basePath\}/, "links are written against the listing's own path");
  assert.match(body, /action=\{filters \? \{ href: filters\.basePath, label: "Xóa bộ lọc" \} : undefined\}/, "a no-match result offers the way out");

  for (const page of ["sale/page.tsx", "sale/uu-dai/page.tsx", "sale/flash-sale/page.tsx", "sale/xa-hang-le-size/page.tsx"]) {
    assert.match(read(`src/app/${page}`), /<SaleListingBody/, `${page} draws the shared body`);
  }

  const loader = read("src/routes/sale.ts");
  assert.match(loader, /parseSaleDiscoverySearchParams/, "the loader reads the sale filters from the URL");
  assert.match(loader, /listConfiguredSaleFacets/, "the loader reads the sizes still selectable");

  const panel = read("src/components/brand/plp-filter-panel.tsx");
  assert.match(panel, /offerAvailability \|\| showSaleToggle/, "the toggles' wrapper disappears when neither is offered");
});
