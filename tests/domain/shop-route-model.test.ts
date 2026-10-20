import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStorefrontDiscoveryHref,
  STOREFRONT_DISCOVERY_LIMITS,
  type StorefrontDiscoveryQuery,
} from "../../src/commerce/storefront-discovery.ts";
import type { StorefrontVariantFacts } from "../../src/commerce/storefront-product.ts";
import {
  buildShopViewModel,
  hasActiveShopDiscovery,
  resolveSelectedFacet,
  shopCollectionLabel,
  type ShopProduct,
  type ShopViewModelInput,
} from "../../src/routes/shop-model.ts";
import type { TrackingEvent } from "../../src/tracking/commerce-events.ts";

/**
 * The shop route's own decisions, held to the behaviour the page had before it was migrated.
 *
 * Pricing belongs to `buildProductCardModel` and is not retested here. What is tested is what the
 * route decides: whether the shopper actually filtered, how facet slugs read, where the pagination
 * links point, and the tone offset -- which has to survive paging or the grid visibly repeats.
 */

const image = (n: number) => ({ url: `https://content.pancake.vn/1/2/3/4/photo-${n}.jpg`, alt: "" });

function variant(n: number): StorefrontVariantFacts {
  return {
    id: `variant-${n}`,
    pancakeVariationId: `pancake-${n}`,
    color: null,
    size: "S",
    sellableStock: 3,
    retailPrice: 100_000,
    retailPriceAfterDiscount: 100_000,
  };
}

function product(n: number): ShopProduct {
  return {
    id: `product-${n}`,
    slug: `product-${n}`,
    name: `Sản phẩm ${n}`,
    media: { primary: image(n), gallery: [image(n)] },
    variants: [variant(n)],
  };
}

function discovery(overrides: Partial<StorefrontDiscoveryQuery> = {}): StorefrontDiscoveryQuery {
  return {
    query: null,
    color: null,
    size: null,
    availability: null,
    minPriceVnd: null,
    maxPriceVnd: null,
    collection: null,
    sort: "name-asc",
    page: 1,
    ...overrides,
  };
}

function input(overrides: Partial<ShopViewModelInput> = {}): ShopViewModelInput {
  return {
    discovery: discovery(),
    products: [],
    facets: { collections: [], colors: [], sizes: [] },
    totalCount: 0,
    totalPages: 1,
    page: 1,
    hasPrevious: false,
    hasNext: false,
    pageSize: 24,
    selectEventBySlug: new Map<string, TrackingEvent>(),
    ...overrides,
  };
}

/* ------------------------------------------------------------------ filtered state */

test("arriving at the shop with no query is not a filtered state", () => {
  // The empty page says "no products are on sale yet" rather than "nothing matches your filters",
  // and that turns on this one boolean.
  assert.equal(hasActiveShopDiscovery(discovery()), false);
});

test("every narrowing control counts as filtering", () => {
  const narrowings: Partial<StorefrontDiscoveryQuery>[] = [
    { query: "áo" },
    { color: "Đen" },
    { size: "M" },
    { availability: "in-stock" },
    { minPriceVnd: 100_000 },
    { maxPriceVnd: 500_000 },
    { collection: "ao-so-mi" },
    // A link can filter by Sale even though /shop has no Sale control.
    { sale: true },
    { sort: "price-asc" },
  ];

  for (const narrowing of narrowings) {
    assert.equal(
      hasActiveShopDiscovery(discovery(narrowing)),
      true,
      `${Object.keys(narrowing)[0]} must count as filtering`,
    );
  }
});

test("sale=false is not a narrowing filter", () => {
  assert.equal(hasActiveShopDiscovery(discovery({ sale: false })), false);
  assert.equal(hasActiveShopDiscovery(discovery({ sale: null })), false);
});

test("paging alone is not filtering", () => {
  assert.equal(hasActiveShopDiscovery(discovery({ page: 3 })), false);
});

/* ------------------------------------------------------------------ facet labels */

test("a facet slug reads as a heading", () => {
  assert.equal(shopCollectionLabel("ao-so-mi"), "Ao So Mi");
  assert.equal(shopCollectionLabel("quan"), "Quan");
});

test("a slug with empty parts does not lose them or crash", () => {
  assert.equal(shopCollectionLabel("ao--mi"), "Ao  Mi");
  assert.equal(shopCollectionLabel(""), "");
});

test("collection facets carry both the value the form submits and the label it shows", () => {
  const model = buildShopViewModel(
    input({ facets: { collections: ["ao-so-mi"], colors: ["Đen"], sizes: ["M"] } }),
  );

  assert.deepEqual(model.collectionFacets, [{ value: "ao-so-mi", label: "Ao So Mi" }]);
  assert.deepEqual(model.colorFacets, ["Đen"]);
  assert.deepEqual(model.sizeFacets, ["M"]);
});

test("a size or colour from an older URL is shown in the facet's spelling, not dropped to 'all'", () => {
  // `/shop?size=Xl` was a real URL when catalog data mixed `XL` and `Xl`. The facets now offer `XL`;
  // the select must still show it chosen, or the next submit sends `size=""` and drops the filter.
  const model = buildShopViewModel(
    input({
      discovery: discovery({ size: "Xl", color: "đen" }),
      facets: { collections: [], colors: ["Đen"], sizes: ["M", "XL"] },
    }),
  );

  assert.equal(model.selectedSize, "XL");
  assert.deepEqual(model.sizeFacets, ["M", "XL"]);
  // Colour compares without case too (`đ` and `Đ` are one letter to the SQL filter).
  assert.equal(model.selectedColor, "Đen");

  const none = buildShopViewModel(input({ facets: { collections: [], colors: ["Đen"], sizes: ["M"] } }));
  assert.equal(none.selectedSize, "");
  assert.equal(none.selectedColor, "");
});

test("a chosen value no facet carries is kept as an option instead of being cleared", () => {
  const resolved = resolveSelectedFacet(["S", "M"], "XXL");
  assert.equal(resolved.value, "XXL");
  assert.deepEqual(resolved.options, ["S", "M", "XXL"]);

  // Already present: the options are not duplicated.
  assert.deepEqual(resolveSelectedFacet(["S", "M"], "m").options, ["S", "M"]);
  assert.equal(resolveSelectedFacet(["S", "M"], " m ").value, "M");
  assert.deepEqual(resolveSelectedFacet([], null), { value: "", options: [] });
});

test("a collection in the URL that is no longer published stays selected, marked as unavailable", () => {
  // `/shop?collection=retired-collection` is a link that was shared while the collection was
  // published. The facets no longer list it; without a kept option the select shows "Tất cả" and the
  // next submit (a sort change) sends `collection=""`, silently dropping the filter.
  const model = buildShopViewModel(
    input({
      discovery: discovery({ collection: "retired-collection" }),
      facets: { collections: ["ao-so-mi"], colors: [], sizes: [] },
    }),
  );

  assert.equal(model.selectedCollection, "retired-collection");
  assert.deepEqual(model.collectionFacets, [
    { value: "ao-so-mi", label: "Ao So Mi" },
    { value: "retired-collection", label: "Retired Collection (không còn khả dụng)" },
  ]);

  // A published collection is not duplicated or relabelled, and none selected stays "all".
  const published = buildShopViewModel(
    input({
      discovery: discovery({ collection: "ao-so-mi" }),
      facets: { collections: ["ao-so-mi"], colors: [], sizes: [] },
    }),
  );
  assert.equal(published.selectedCollection, "ao-so-mi");
  assert.deepEqual(published.collectionFacets, [{ value: "ao-so-mi", label: "Ao So Mi" }]);

  const none = buildShopViewModel(
    input({ facets: { collections: ["ao-so-mi"], colors: [], sizes: [] } }),
  );
  assert.equal(none.selectedCollection, "");
  assert.equal(none.collectionFacets.length, 1);
});

test("the shop's own links keep Sale when another filter is cleared", () => {
  const withSale = discovery({ sale: true, size: "M" });
  assert.equal(
    buildStorefrontDiscoveryHref({ ...withSale, size: null, page: 1 }),
    "/shop?sale=true",
  );
  assert.equal(
    buildStorefrontDiscoveryHref({ ...withSale, sale: null, page: 1 }),
    "/shop?size=M",
  );
  assert.equal(buildStorefrontDiscoveryHref({ ...withSale, sort: "price-asc" }), "/shop?size=M&sale=true&sort=price-asc");
});

/* -------------------------------------------------------------------- pagination */

test("pagination links are built only for the directions that exist", () => {
  const middle = buildShopViewModel(
    input({ page: 2, totalPages: 3, hasPrevious: true, hasNext: true }),
  );
  // Page one drops the `page` param entirely, so the first page has one canonical URL rather than
  // two spellings of it.
  assert.equal(middle.previousHref, "/shop");
  assert.equal(middle.nextHref, "/shop?page=3");

  const only = buildShopViewModel(input({ page: 1, totalPages: 1 }));
  assert.equal(only.previousHref, null);
  assert.equal(only.nextHref, null);
});

test("pagination links carry the filters forward, so paging does not silently widen the results", () => {
  const model = buildShopViewModel(
    input({
      discovery: discovery({ collection: "ao-so-mi", sort: "price-asc", page: 2 }),
      page: 2,
      totalPages: 3,
      hasNext: true,
    }),
  );

  assert.match(model.nextHref ?? "", /collection=ao-so-mi/);
  assert.match(model.nextHref ?? "", /sort=price-asc/);
  assert.match(model.nextHref ?? "", /page=3/);
});

/* ------------------------------------------------------------------ tone offset */

test("the tone cycle continues across pages instead of restarting", () => {
  // Restarting it makes page two open with the same colour run as page one, which reads as the grid
  // repeating itself.
  assert.equal(buildShopViewModel(input({ page: 1, pageSize: 24 })).toneOffset, 0);
  assert.equal(buildShopViewModel(input({ page: 2, pageSize: 24 })).toneOffset, 24);
  assert.equal(buildShopViewModel(input({ page: 3, pageSize: 24 })).toneOffset, 48);
});

/* ---------------------------------------------------------------------- cards */

test("every product becomes a card in catalog order, carrying its prebuilt select event", () => {
  const selectEvent = { name: "select_item", payload: {} } as unknown as TrackingEvent;
  const model = buildShopViewModel(
    input({
      products: [product(1), product(2)],
      selectEventBySlug: new Map([["product-2", selectEvent]]),
      totalCount: 2,
    }),
  );

  assert.deepEqual(model.cards.map((card) => card.id), ["product-1", "product-2"]);
  assert.equal(model.cards[0]?.model.selectEvent, null);
  assert.equal(model.cards[1]?.model.selectEvent, selectEvent);
});

test("the view model is frozen so markup cannot mutate a decision it was handed", () => {
  const model = buildShopViewModel(input({ products: [product(1)] }));

  assert.equal(Object.isFrozen(model), true);
  assert.equal(Object.isFrozen(model.cards), true);
});

/* --------------------------------------------------------------------- limits */

test("the form's bounds are the ones the loader enforces, not a copy", () => {
  // Retyping these in markup is how a field lets a shopper enter something the route then refuses.
  const model = buildShopViewModel(input());

  assert.deepEqual(model.limits, {
    query: STOREFRONT_DISCOVERY_LIMITS.query,
    priceVnd: STOREFRONT_DISCOVERY_LIMITS.priceVnd,
  });
});
