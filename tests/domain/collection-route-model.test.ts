import assert from "node:assert/strict";
import test from "node:test";

import { buildStorefrontProductImpressions } from "../../src/commerce/storefront-impressions.ts";
import type { StorefrontVariantFacts } from "../../src/commerce/storefront-product.ts";
import {
  buildCollectionViewModel,
  orderByFeaturedSlugs,
  resolveCollectionEditorial,
  type CollectionProduct,
  type CollectionViewModelInput,
} from "../../src/routes/collection-model.ts";
import type { TrackingEvent } from "../../src/tracking/commerce-events.ts";

/**
 * The collection route's own decisions: the editorial media its story is told with, the pinned
 * ordering a merchandiser set, and the filter/pagination links.
 */

const photo = (n: number) => `https://content.pancake.vn/1/2/3/4/photo-${n}.jpg`;
const film = "https://content.pancake.vn/1/2/3/4/film.mp4";

function variant(n: number): StorefrontVariantFacts {
  return {
    id: `variant-${n}`,
    pancakeVariationId: `pancake-${n}`,
    color: null,
    size: "S",
    sellableStock: 2,
    retailPrice: 100_000,
    retailPriceAfterDiscount: 100_000,
  };
}

function product(slug: string): CollectionProduct & Readonly<{ pancakeProductId: string }> {
  return {
    id: `id-${slug}`,
    slug,
    // Impressions are keyed by the product's external identity, so the fixture carries one.
    pancakeProductId: `pancake-${slug}`,
    name: slug,
    media: { primary: { url: photo(1), alt: "" }, gallery: [{ url: photo(1), alt: "" }] },
    variants: [variant(1)],
  };
}

function input(overrides: Partial<CollectionViewModelInput> = {}): CollectionViewModelInput {
  return {
    slug: "mua-he",
    title: "Mùa hè",
    description: "Câu chuyện của bộ sưu tập.",
    heroImageUrl: null,
    galleryImageUrls: [],
    videoSrcUrl: null,
    videoPosterUrl: null,
    products: [],
    sizes: [],
    discovery: { size: null, sort: "name-asc" },
    sortChoices: [
      { value: "name-asc", label: "Tên A–Z" },
      { value: "price-asc", label: "Giá thấp → cao" },
    ],
    totalCount: 0,
    totalPages: 1,
    page: 1,
    hasPrevious: false,
    hasNext: false,
    pageSize: 24,
    selectEventBySlug: new Map<string, TrackingEvent>(),
    hrefFor: ({ size, sort, page }) =>
      `/collections/mua-he?size=${size ?? "all"}&sort=${sort}&page=${page}`,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ the story */

test("the collection's story is its description, not a separate field", () => {
  const model = buildCollectionViewModel(input());

  assert.equal(model.editorial.story, "Câu chuyện của bộ sưu tập.");
});

/* --------------------------------------------------------------- editorial media */

test("trusted editorial media survives onto the model", () => {
  const editorial = resolveCollectionEditorial({
    description: "story",
    heroImageUrl: photo(1),
    heroImageMobileUrl: photo(5),
    galleryImageUrls: [photo(2), photo(3)],
    videoSrcUrl: film,
    videoPosterUrl: photo(4),
  });

  assert.equal(editorial.heroImage, photo(1));
  assert.equal(editorial.heroImageMobile, photo(5));
  assert.deepEqual(editorial.gallery, [photo(2), photo(3)]);
  assert.deepEqual(editorial.video, { src: film, poster: photo(4) });
});

test("untrusted media is dropped rather than rendered", () => {
  // A row written before the validator existed, or edited by hand, must not put an untrusted host
  // in front of a shopper just because it came out of the database.
  const editorial = resolveCollectionEditorial({
    description: "story",
    heroImageUrl: "https://evil.example.com/1/2/3/4/photo.jpg",
    heroImageMobileUrl: "https://evil.example.com/1/2/3/4/mobile.jpg",
    galleryImageUrls: [photo(1), "http://content.pancake.vn/1/2/3/4/photo-2.jpg", "not a url"],
    videoSrcUrl: "https://evil.example.com/1/2/3/4/film.mp4",
    videoPosterUrl: null,
  });

  assert.equal(editorial.heroImage, null);
  assert.equal(editorial.heroImageMobile, null);
  assert.deepEqual(editorial.gallery, [photo(1)], "only the trusted gallery entry survives");
  assert.equal(editorial.video, null);
});

test("a video whose poster fails validation still plays", () => {
  // Losing the poster costs the first frame; dropping the video would cost the whole panel.
  const editorial = resolveCollectionEditorial({
    description: "story",
    heroImageUrl: null,
    galleryImageUrls: [],
    videoSrcUrl: film,
    videoPosterUrl: "https://evil.example.com/1/2/3/4/photo.jpg",
  });

  assert.deepEqual(editorial.video, { src: film, poster: null });
});

test("a poster without a video is not a video", () => {
  const editorial = resolveCollectionEditorial({
    description: "story",
    heroImageUrl: null,
    galleryImageUrls: [],
    videoSrcUrl: null,
    videoPosterUrl: photo(1),
  });

  assert.equal(editorial.video, null);
});

/* ------------------------------------------------------------- featured ordering */

test("pinned slugs lead the grid, in the order the merchandiser set them", () => {
  const ordered = orderByFeaturedSlugs(
    [product("a"), product("b"), product("c")],
    ["c", "a"],
  );

  assert.deepEqual(ordered.map((p) => p.slug), ["c", "a", "b"]);
});

test("pinning reorders this page and never reaches for a product the query excluded", () => {
  // Surfacing a pinned product the shopper filtered out would put an item in front of someone who
  // asked not to see it.
  const ordered = orderByFeaturedSlugs([product("a"), product("b")], ["z", "b"]);

  assert.deepEqual(ordered.map((p) => p.slug), ["b", "a"]);
});

test("no pinned slugs leaves the catalog's own order untouched", () => {
  const products = [product("a"), product("b")];

  assert.equal(orderByFeaturedSlugs(products, []), products);
});

test("a slug pinned twice keeps its first position rather than being ranked twice", () => {
  const ordered = orderByFeaturedSlugs([product("a"), product("b")], ["b", "a", "b"]);

  assert.deepEqual(ordered.map((p) => p.slug), ["b", "a"]);
});

test("the grid renders exactly the order it was handed, without reordering again", () => {
  // The loader applies `orderByFeaturedSlugs` once, before building the grid's tracking. Reordering
  // a second time here is what would put the cards and the analytics indices out of step.
  const ordered = orderByFeaturedSlugs([product("a"), product("b")], ["b"]);
  const model = buildCollectionViewModel(input({ products: ordered, totalCount: 2 }));

  assert.deepEqual(model.cards.map((card) => card.id), ["id-b", "id-a"]);
});

test("the rendered cards and the tracking impressions agree on every index", () => {
  // The regression this guards: tracking built from the repository order while the cards were
  // reordered afterwards, so a pinned product reported the index it would have had rather than the
  // position it is shown in. One ordered array feeds both, so position i means the same thing.
  const products = [product("a"), product("b"), product("c")];
  const ordered = orderByFeaturedSlugs(products, ["c", "b"]);

  const model = buildCollectionViewModel(input({ products: ordered, totalCount: ordered.length }));
  const impressions = buildStorefrontProductImpressions({ products: ordered });

  assert.deepEqual(model.cards.map((card) => card.id), ["id-c", "id-b", "id-a"]);
  assert.deepEqual(
    impressions.map((impression) => impression.index),
    [0, 1, 2],
    "impressions are indexed by the order they were given",
  );
  assert.deepEqual(
    impressions.map((impression) => impression.productExternalId),
    ordered.map((entry) => entry.pancakeProductId),
    "impression i describes the product rendered at card i",
  );
});

/* ----------------------------------------------------------------- filter links */

test("the size filter offers an all-sizes entry first, marked active when nothing is filtered", () => {
  const model = buildCollectionViewModel(input({ sizes: ["S", "M"] }));

  assert.deepEqual(model.sizeOptions.map((option) => option.value), [null, "S", "M"]);
  assert.equal(model.sizeOptions[0]?.active, true);
  assert.equal(model.filtered, false);
});

test("choosing a size marks it active and marks the page filtered", () => {
  const model = buildCollectionViewModel(
    input({ sizes: ["S", "M"], discovery: { size: "M", sort: "name-asc" } }),
  );

  assert.equal(model.filtered, true);
  assert.equal(model.sizeOptions.find((option) => option.value === "M")?.active, true);
  assert.equal(model.sizeOptions[0]?.active, false);
});

test("changing sort keeps the size filter, and changing size keeps the sort", () => {
  const model = buildCollectionViewModel(
    input({ sizes: ["M"], discovery: { size: "M", sort: "price-asc" } }),
  );

  assert.match(model.sortOptions[0]?.href ?? "", /size=M/, "sort links keep the size");
  assert.match(model.sizeOptions[1]?.href ?? "", /sort=price-asc/, "size links keep the sort");
});

test("every filter link returns to page one, so a narrower result cannot land past its last page", () => {
  const model = buildCollectionViewModel(
    input({ sizes: ["M"], page: 3, discovery: { size: null, sort: "name-asc" } }),
  );

  for (const href of [...model.sortOptions, ...model.sizeOptions].map((option) => option.href)) {
    assert.match(href, /page=1/);
  }
});

/* ------------------------------------------------------------------ pagination */

test("pagination links exist only for the directions that do, and keep the filters", () => {
  const model = buildCollectionViewModel(
    input({ page: 2, totalPages: 3, hasPrevious: true, hasNext: true, discovery: { size: "M", sort: "name-asc" } }),
  );

  assert.match(model.previousHref ?? "", /size=M&sort=name-asc&page=1/);
  assert.match(model.nextHref ?? "", /size=M&sort=name-asc&page=3/);

  const single = buildCollectionViewModel(input());
  assert.equal(single.previousHref, null);
  assert.equal(single.nextHref, null);
});

test("the tone cycle continues across pages", () => {
  assert.equal(buildCollectionViewModel(input({ page: 2, pageSize: 24 })).toneOffset, 24);
});

test("the view model is frozen so markup cannot mutate a decision it was handed", () => {
  const model = buildCollectionViewModel(input());

  assert.equal(Object.isFrozen(model), true);
  assert.equal(Object.isFrozen(model.editorial), true);
});
