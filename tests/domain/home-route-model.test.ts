import assert from "node:assert/strict";
import test from "node:test";

import type { StorefrontVariantFacts } from "../../src/commerce/storefront-product.ts";
import { buildHomeViewModel, type HomeProduct } from "../../src/routes/home-model.ts";
import type { TrackingEvent } from "../../src/tracking/commerce-events.ts";

/**
 * The home route's own decisions.
 *
 * Pricing is not retested here -- it belongs to `buildProductCardModel` and has its own suite. What
 * is tested is what the route decides: that the two product grids stay separate all the way
 * through, which photograph fills the brand story, and that every product still gets a card
 * carrying its prebuilt select event.
 */

const image = (n: number) => ({ url: `https://content.pancake.vn/1/2/3/4/photo-${n}.jpg`, alt: "" });

function variant(overrides: Partial<StorefrontVariantFacts> = {}): StorefrontVariantFacts {
  return {
    id: "variant-1",
    pancakeVariationId: "pancake-1",
    color: null,
    size: "S",
    sellableStock: 4,
    retailPrice: 100_000,
    retailPriceAfterDiscount: 100_000,
    ...overrides,
  };
}

function product(n: number, withPhoto: boolean): HomeProduct {
  return {
    id: `product-${n}`,
    slug: `product-${n}`,
    name: `Sản phẩm ${n}`,
    media: withPhoto ? { primary: image(n), gallery: [image(n)] } : null,
    variants: [variant({ id: `variant-${n}`, pancakeVariationId: `pancake-${n}` })],
  };
}

const noEvents = new Map<string, TrackingEvent>();

const grid = (products: readonly HomeProduct[]) => ({ products, selectEventBySlug: noEvents });

const build = (
  newArrivals: readonly HomeProduct[],
  featured: readonly HomeProduct[] = [],
  collections: readonly { slug: string; title: string }[] = [],
) =>
  buildHomeViewModel({
    newArrivals: grid(newArrivals),
    featured: grid(featured),
    collections,
  });

/* ------------------------------------------------------- the two grids stay separate */

test("new arrivals and featured are built independently, never merged", () => {
  const model = build([product(1, true), product(2, true)], [product(3, true)]);

  assert.deepEqual(
    model.newArrivals.map((card) => card.id),
    ["product-1", "product-2"],
  );
  assert.deepEqual(
    model.featured.map((card) => card.id),
    ["product-3"],
  );
});

test("an empty Featured selection stays empty rather than inheriting new arrivals", () => {
  // Master spec §20: an empty manual selection must never fall back to newest/bestseller logic.
  const model = build([product(1, true), product(2, true)], []);

  assert.equal(model.newArrivals.length, 2);
  assert.deepEqual(model.featured, []);
});

test("an empty new-arrivals read does not empty a populated Featured section", () => {
  const model = build([], [product(1, true)]);

  assert.deepEqual(model.newArrivals, []);
  assert.equal(model.featured.length, 1);
});

test("each grid keeps the order its own read returned", () => {
  const model = build([product(3, true), product(1, true)], [product(2, true), product(3, true)]);

  assert.deepEqual(
    model.newArrivals.map((card) => card.model.href),
    ["/shop/product-3", "/shop/product-1"],
  );
  assert.deepEqual(
    model.featured.map((card) => card.model.href),
    ["/shop/product-2", "/shop/product-3"],
  );
});

test("each grid carries its own select events, so a click is attributed to the grid it came from", () => {
  const newArrivalEvent = {
    name: "select_item",
    payload: { list: "new" },
  } as unknown as TrackingEvent;
  const featuredEvent = {
    name: "select_item",
    payload: { list: "featured" },
  } as unknown as TrackingEvent;

  const model = buildHomeViewModel({
    newArrivals: {
      products: [product(1, true)],
      selectEventBySlug: new Map([["product-1", newArrivalEvent]]),
    },
    featured: {
      products: [product(1, true)],
      selectEventBySlug: new Map([["product-1", featuredEvent]]),
    },
    collections: [],
  });

  assert.equal(model.newArrivals[0]?.model.selectEvent, newArrivalEvent);
  assert.equal(model.featured[0]?.model.selectEvent, featuredEvent);
});

test("a card with no prebuilt event reports none rather than a guessed one", () => {
  const model = build([product(1, true)]);

  assert.equal(model.newArrivals[0]?.model.selectEvent, null);
});

/* ------------------------------------------------------------------ the story panel */

test("the brand story takes the first photographed product", () => {
  const model = build([product(1, true), product(2, true)]);

  assert.equal(model.storyPanel?.image.url, image(1).url);
});

test("an unphotographed product is passed over for the story panel but still gets a card", () => {
  const model = build([product(1, false), product(2, true)]);

  assert.equal(model.storyPanel?.image.url, image(2).url);
  assert.equal(model.newArrivals.length, 2, "every product is still merchandised");
});

test("no photography at all reports no story panel rather than an empty image", () => {
  assert.equal(build([product(1, false)]).storyPanel, null);
});

test("the story panel carries the product name, so markup can caption a photo with no alt text", () => {
  assert.equal(build([product(1, true)]).storyPanel?.productName, "Sản phẩm 1");
});

test("an empty catalog produces no cards and no panel, not a crash", () => {
  const model = build([]);

  assert.deepEqual(model.newArrivals, []);
  assert.deepEqual(model.featured, []);
  assert.equal(model.storyPanel, null);
});

/* ------------------------------------------------------------------- collections */

test("published collections pass through in the order the repository ordered them", () => {
  const model = build(
    [],
    [],
    [
      { slug: "ao", title: "Áo" },
      { slug: "quan", title: "Quần" },
    ],
  );

  assert.deepEqual(model.collections, [
    { slug: "ao", title: "Áo" },
    { slug: "quan", title: "Quần" },
  ]);
});

test("the view model is frozen so markup cannot mutate a decision it was handed", () => {
  const model = build([product(1, true)]);

  assert.equal(Object.isFrozen(model), true);
  assert.equal(Object.isFrozen(model.newArrivals), true);
  assert.equal(Object.isFrozen(model.featured), true);
});
