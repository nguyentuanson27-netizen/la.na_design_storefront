import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCategoryDiscoveryHref,
  parseSaleDiscoverySearchParams,
} from "../../src/commerce/category-discovery-url.ts";
import {
  buildSaleNextPageInput,
  buildShopNextPageInput,
  saleDiscoveryFromInput,
  salePlpFilters,
  shopDiscoveryFromInput,
  shopPlpFilters,
} from "../../src/commerce/listing-next-page-input.ts";
import {
  buildStorefrontDiscoveryHref,
  parseStorefrontDiscoverySearchParams,
  type StorefrontDiscoverySearchParams,
} from "../../src/commerce/storefront-discovery.ts";

/**
 * The loop an infinite grid runs: the page parses its URL, hands the grid the filters, the grid
 * asks for page N+1, the server action rebuilds a discovery from that request.
 *
 * What the shopper scrolled into must be exactly what `?page=N+1` would have shown, so the rebuilt
 * discovery has to equal the page's own, with only the page advanced. Any field that is dropped or
 * reinterpreted on the way changes the SQL (a different sort flips ORDER BY between page 1 and 2,
 * which duplicates and skips products at the boundary) -- and this is the test that fails when one is.
 */

const SHOP_URLS: readonly Readonly<[string, StorefrontDiscoverySearchParams]>[] = [
  ["bare /shop", {}],
  ["explicit default sort", { sort: "default" }],
  ["explicit default sort, page 2", { sort: "default", page: "2" }],
  ["A-Z written out", { sort: "name-asc" }],
  ["Z-A", { sort: "name-desc" }],
  ["price ascending", { sort: "price-asc" }],
  ["search", { q: "áo dài" }],
  ["search with default sort", { q: "áo dài", sort: "default" }],
  ["collection", { collection: "special-deals" }],
  ["in stock", { availability: "in-stock" }],
  ["sale only", { sale: "true" }],
  [
    "everything at once",
    {
      q: "váy",
      collection: "city-uniform",
      color: "Ink",
      size: "M",
      availability: "in-stock",
      minPrice: "1000000",
      maxPrice: "1300000",
      sale: "true",
      sort: "price-desc",
      page: "3",
    },
  ],
];

for (const [name, params] of SHOP_URLS) {
  test(`/shop: scrolling past "${name}" asks for the discovery ?page=N+1 would`, () => {
    const onPage = parseStorefrontDiscoverySearchParams(params);
    const nextPage = onPage.page + 1;

    const input = buildShopNextPageInput(
      { query: onPage.query, collection: onPage.collection },
      shopPlpFilters(onPage),
      nextPage,
    );
    const rebuilt = shopDiscoveryFromInput(input);

    assert.deepEqual(rebuilt, { ...onPage, page: nextPage });
    // The order the SQL uses is a function of the sort and nothing else on this route.
    assert.equal(rebuilt.sort === "name-asc", onPage.sort === "name-asc", "in-stock-first must agree");
    // The link the action hands back is the one the crawlable page 2 would carry.
    assert.equal(
      buildStorefrontDiscoveryHref(rebuilt, nextPage + 1),
      buildStorefrontDiscoveryHref(onPage, nextPage + 1),
    );
  });
}

test("/shop: sort=default stays default, because it is a different order from the bare URL's A-Z", () => {
  const bare = parseStorefrontDiscoverySearchParams({});
  const explicit = parseStorefrontDiscoverySearchParams({ sort: "default" });
  assert.equal(bare.sort, "name-asc", "an absent sort is A-Z, which leads with what can be bought");
  assert.equal(explicit.sort, "default", "?sort=default is accepted and is not A-Z");

  const next = shopDiscoveryFromInput(
    buildShopNextPageInput({ query: null, collection: null }, shopPlpFilters(explicit), 2),
  );
  assert.equal(next.sort, "default");
  assert.equal(buildStorefrontDiscoveryHref(next, 3), "/shop?sort=default&page=3");
});

const SALE_URLS: readonly Readonly<[string, StorefrontDiscoverySearchParams]>[] = [
  ["bare", {}],
  ["explicit default sort", { sort: "default" }],
  ["cheapest first", { sort: "price-asc" }],
  ["size", { size: "M" }],
  ["colour and price band", { color: "Ink", minPrice: "100000", maxPrice: "900000" }],
  ["everything at once, page 2", { size: "M", color: "Ink", minPrice: "100000", maxPrice: "900000", sort: "price-desc", page: "2" }],
];

for (const kind of [null, "PROMOTION", "FLASH_SALE", "CLEARANCE"] as const) {
  for (const [name, params] of SALE_URLS) {
    test(`/sale (${kind ?? "all"}): scrolling past "${name}" asks for the discovery ?page=N+1 would`, () => {
      const onPage = parseSaleDiscoverySearchParams(params);
      const nextPage = onPage.page + 1;

      const input = buildSaleNextPageInput(kind, salePlpFilters(onPage), nextPage);
      assert.equal(input.kind, kind, "the campaign kind rides along unchanged");
      const rebuilt = saleDiscoveryFromInput(input);

      assert.deepEqual(rebuilt, { ...onPage, page: nextPage });
      const href = (query: typeof onPage, page: number) =>
        buildCategoryDiscoveryHref(
          "/sale",
          {
            color: query.color,
            size: query.size,
            minPriceVnd: query.minPriceVnd,
            maxPriceVnd: query.maxPriceVnd,
            sort: query.sort,
          },
          page,
        );
      assert.equal(href(rebuilt, nextPage + 1), href(onPage, nextPage + 1));
    });
  }
}
