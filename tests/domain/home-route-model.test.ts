import assert from "node:assert/strict";
import test from "node:test";

import type { StorefrontVariantFacts } from "../../src/commerce/storefront-product.ts";
import { buildHomeViewModel, type HomeProduct } from "../../src/routes/home-model.ts";
import type { TrackingEvent } from "../../src/tracking/commerce-events.ts";

/**
 * The home route's own decisions, held to the behaviour the page had before it was migrated.
 *
 * Pricing is not retested here -- it belongs to `buildProductCardModel` and has its own suite. What
 * is tested is what the route decides: which product fills each editorial panel, and that every
 * product still gets a card carrying its prebuilt select event.
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

const build = (products: readonly HomeProduct[]) =>
  buildHomeViewModel({ products, collections: [], selectEventBySlug: noEvents });

/* ------------------------------------------------------------------ editorial panels */

test("the three editorial panels take the first three photographed products in order", () => {
  const model = build([product(1, true), product(2, true), product(3, true)]);

  assert.equal(model.hero?.image.url, image(1).url);
  assert.equal(model.lookbookLarge?.image.url, image(2).url);
  assert.equal(model.lookbookSmall?.image.url, image(3).url);
});

test("each panel falls back to the one above it rather than going blank", () => {
  // A full-bleed panel with no photo is a blank wall, so one photographed product fills all three.
  const one = build([product(1, true)]);
  assert.equal(one.hero?.image.url, image(1).url);
  assert.equal(one.lookbookLarge?.image.url, image(1).url);
  assert.equal(one.lookbookSmall?.image.url, image(1).url);

  const two = build([product(1, true), product(2, true)]);
  assert.equal(two.lookbookLarge?.image.url, image(2).url);
  assert.equal(two.lookbookSmall?.image.url, image(2).url, "the small panel falls back to the large");
});

test("products without trusted photography are skipped for panels but still get cards", () => {
  const model = build([product(1, false), product(2, true), product(3, false)]);

  assert.equal(model.hero?.image.url, image(2).url, "the unphotographed first product is passed over");
  assert.equal(model.cards.length, 3, "every product is still merchandised");
});

test("a page with no photography at all reports no panels rather than an empty image", () => {
  const model = build([product(1, false)]);

  assert.equal(model.hero, null);
  assert.equal(model.lookbookLarge, null);
  assert.equal(model.lookbookSmall, null);
});

test("a panel carries the product name, so markup can caption a photo with no alt text", () => {
  const model = build([product(1, true)]);

  assert.equal(model.hero?.productName, "Sản phẩm 1");
});

/* ----------------------------------------------------------------------- the cards */

test("every product becomes one card, in the order the catalog returned them", () => {
  const model = build([product(3, true), product(1, true), product(2, true)]);

  assert.deepEqual(
    model.cards.map((card) => card.id),
    ["product-3", "product-1", "product-2"],
  );
  assert.deepEqual(
    model.cards.map((card) => card.model.href),
    ["/shop/product-3", "/shop/product-1", "/shop/product-2"],
  );
});

test("a card carries the select event the server prebuilt for its slug, and null otherwise", () => {
  const selectEvent = { name: "select_item", payload: {} } as unknown as TrackingEvent;
  const model = buildHomeViewModel({
    products: [product(1, true), product(2, true)],
    collections: [],
    selectEventBySlug: new Map([["product-1", selectEvent]]),
  });

  assert.equal(model.cards[0]?.model.selectEvent, selectEvent);
  assert.equal(model.cards[1]?.model.selectEvent, null, "no event is better than a guessed one");
});

test("an empty catalog produces no cards and no panels, not a crash", () => {
  const model = build([]);

  assert.deepEqual(model.cards, []);
  assert.equal(model.hero, null);
});

/* ------------------------------------------------------------------- collections */

test("published collections pass through in the order the repository ordered them", () => {
  const model = buildHomeViewModel({
    products: [],
    collections: [
      { slug: "ao", title: "Áo" },
      { slug: "quan", title: "Quần" },
    ],
    selectEventBySlug: noEvents,
  });

  assert.deepEqual(model.collections, [
    { slug: "ao", title: "Áo" },
    { slug: "quan", title: "Quần" },
  ]);
});

test("the view model is frozen so markup cannot mutate a decision it was handed", () => {
  const model = build([product(1, true)]);

  assert.equal(Object.isFrozen(model), true);
  assert.equal(Object.isFrozen(model.cards), true);
});
