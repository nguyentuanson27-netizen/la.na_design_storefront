import assert from "node:assert/strict";
import test from "node:test";

import type { StorefrontVariantFacts } from "../../src/commerce/storefront-product.ts";
import {
  buildFlashSaleViewModel,
  type FlashSaleProduct,
  type FlashSaleViewModelInput,
} from "../../src/routes/flash-sale-model.ts";
import type { TrackingEvent } from "../../src/tracking/commerce-events.ts";

/** The Flash Sale route's own decisions. Flash pricing belongs to the card model, not here. */

const photo = { url: "https://content.pancake.vn/1/2/3/4/photo-1.jpg", alt: "" };

function variant(): StorefrontVariantFacts {
  return {
    id: "variant-1",
    pancakeVariationId: "pancake-1",
    color: null,
    size: "S",
    sellableStock: 2,
    retailPrice: 100_000,
    retailPriceAfterDiscount: 80_000,
  };
}

function product(slug: string): FlashSaleProduct {
  return {
    id: `id-${slug}`,
    slug,
    name: slug,
    media: { primary: photo, gallery: [photo] },
    variants: [variant()],
  };
}

function input(overrides: Partial<FlashSaleViewModelInput> = {}): FlashSaleViewModelInput {
  return {
    products: [],
    totalCount: 0,
    totalPages: 1,
    page: 1,
    pageSize: 24,
    selectEventBySlug: new Map<string, TrackingEvent>(),
    ...overrides,
  };
}

test("every product becomes a card in catalog order", () => {
  const model = buildFlashSaleViewModel(
    input({ products: [product("a"), product("b")], totalCount: 2 }),
  );

  assert.deepEqual(model.cards.map((card) => card.id), ["id-a", "id-b"]);
});

test("a card carries its prebuilt select event, and null where none was built", () => {
  const selectEvent = { name: "select_item", payload: {} } as unknown as TrackingEvent;
  const model = buildFlashSaleViewModel(
    input({
      products: [product("a"), product("b")],
      selectEventBySlug: new Map([["a", selectEvent]]),
    }),
  );

  assert.equal(model.cards[0]?.model.selectEvent, selectEvent);
  assert.equal(model.cards[1]?.model.selectEvent, null);
});

test("an empty Flash window produces no cards rather than a broken grid", () => {
  const model = buildFlashSaleViewModel(input());

  assert.deepEqual(model.cards, []);
  assert.equal(model.totalCount, 0);
});

test("the tone cycle continues across pages", () => {
  assert.equal(buildFlashSaleViewModel(input({ page: 1 })).toneOffset, 0);
  assert.equal(buildFlashSaleViewModel(input({ page: 3, pageSize: 24 })).toneOffset, 48);
});

test("pagination links exist only for the directions that do", () => {
  const middle = buildFlashSaleViewModel(input({ page: 2, totalPages: 3 }));
  assert.equal(middle.previousHref, "/flash-sale?page=1");
  assert.equal(middle.nextHref, "/flash-sale?page=3");

  const only = buildFlashSaleViewModel(input({ page: 1, totalPages: 1 }));
  assert.equal(only.previousHref, null);
  assert.equal(only.nextHref, null);
});

test("page one keeps its `?page=1` spelling, preserved from before the migration", () => {
  // Unlike the shop listing, whose href builder drops the param, this route emits `?page=1` when
  // paging back. Characterized rather than canonicalised: a migration is not the place to change a
  // URL search engines already have.
  assert.equal(buildFlashSaleViewModel(input({ page: 2, totalPages: 2 })).previousHref, "/flash-sale?page=1");
});

test("the view model is frozen so markup cannot mutate a decision it was handed", () => {
  assert.equal(Object.isFrozen(buildFlashSaleViewModel(input())), true);
});
