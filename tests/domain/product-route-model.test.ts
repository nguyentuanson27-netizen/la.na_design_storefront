import assert from "node:assert/strict";
import test from "node:test";

import type { StorefrontProductMedia } from "../../src/commerce/product-media.ts";
import type { StorefrontProjectionOption } from "../../src/commerce/storefront-projection.ts";
import {
  buildProductViewModel,
  resolveInitialGalleryIndex,
  type ProductViewModelInput,
} from "../../src/routes/product-model.ts";
import type { TrackingEvent } from "../../src/tracking/commerce-events.ts";

/**
 * The product route's own decisions, held to the behaviour the page had before it was migrated,
 * plus the editorial fields Phase E adds.
 */

const image = (n: number) => ({ url: `https://content.pancake.vn/1/2/3/4/photo-${n}.jpg`, alt: "" });

const media: StorefrontProductMedia = {
  primary: image(1),
  gallery: [image(1), image(2), image(3)],
};

function input(overrides: Partial<ProductViewModelInput> = {}): ProductViewModelInput {
  return {
    slug: "ao-so-mi",
    name: "Áo sơ mi",
    media,
    collections: [],
    editorialDescription: null,
    material: null,
    craftDetails: [],
    sizeGuide: null,
    careInstructions: null,
    options: [] as readonly StorefrontProjectionOption[],
    productLevelOptions: [] as readonly StorefrontProjectionOption[],
    deepLinkedSelection: null,
    galleryIndexByVariantId: {},
    relatedProducts: [],
    relatedSelectEventBySlug: new Map<string, TrackingEvent>(),
    ...overrides,
  };
}

/* ------------------------------------------------------------- deep-linked gallery */

test("no deep link opens the gallery on the first image", () => {
  assert.equal(resolveInitialGalleryIndex(null, { "variant-a": 2 }), 0);
});

test("a deep-linked variant opens the gallery on that variant's image", () => {
  const selection = { variantId: "variant-a" } as never;

  assert.equal(resolveInitialGalleryIndex(selection, { "variant-a": 2 }), 2);
});

test("a deep-linked variant the map does not cover opens on the first image, not on nothing", () => {
  // The link still addressed a real variant and the panel preselects it either way; refusing to
  // open the gallery would be a worse answer than opening it where it always opens.
  const selection = { variantId: "variant-unmapped" } as never;

  assert.equal(resolveInitialGalleryIndex(selection, { "variant-a": 2 }), 0);
});

test("the view model carries the resolved index and the map, so the gallery can follow selection", () => {
  const model = buildProductViewModel(
    input({
      deepLinkedSelection: { variantId: "variant-a" } as never,
      galleryIndexByVariantId: { "variant-a": 1, "variant-b": 2 },
    }),
  );

  assert.equal(model.initialGalleryIndex, 1);
  assert.deepEqual(model.galleryIndexByVariantId, { "variant-a": 1, "variant-b": 2 });
});

/* --------------------------------------------------------------------- editorial */

test("a product with nothing written up reports no notes section", () => {
  // An empty bordered block reads as a rendering fault; no block at all reads as nothing to say.
  const model = buildProductViewModel(input());

  assert.equal(model.editorial.hasNotes, false);
});

test("any one editorial field is enough to open the notes section", () => {
  const cases: Partial<ProductViewModelInput>[] = [
    { material: "100% cotton" },
    { craftDetails: ["May tay"] },
    { sizeGuide: "Chọn size lớn hơn nếu..." },
    { careInstructions: "Giặt tay" },
  ];

  for (const only of cases) {
    assert.equal(
      buildProductViewModel(input(only)).editorial.hasNotes,
      true,
      `${Object.keys(only)[0]} alone must open the notes`,
    );
  }
});

test("the editorial description alone does not open the notes section", () => {
  // It renders above the purchase panel, not inside the notes block.
  const model = buildProductViewModel(input({ editorialDescription: "Phom rộng." }));

  assert.equal(model.editorial.hasNotes, false);
  assert.equal(model.editorial.description, "Phom rộng.");
});

test("blank craft details are dropped rather than rendered as empty bullets", () => {
  const model = buildProductViewModel(input({ craftDetails: ["May tay", "   ", "", "Cúc trai"] }));

  assert.deepEqual(model.editorial.craftDetails, ["May tay", "Cúc trai"]);
});

test("craft details that are all blank leave the notes section closed", () => {
  const model = buildProductViewModel(input({ craftDetails: ["  ", ""] }));

  assert.deepEqual(model.editorial.craftDetails, []);
  assert.equal(model.editorial.hasNotes, false);
});

test("material and craft details survive onto the model as written", () => {
  const model = buildProductViewModel(
    input({ material: "100% cotton dệt kim", craftDetails: ["May tay", "Cúc trai"] }),
  );

  assert.equal(model.editorial.material, "100% cotton dệt kim");
  assert.deepEqual(model.editorial.craftDetails, ["May tay", "Cúc trai"]);
});

/* ---------------------------------------------------------------- related grid */

test("related products become cards carrying their prebuilt select events", () => {
  const selectEvent = { name: "select_item", payload: {} } as unknown as TrackingEvent;
  const model = buildProductViewModel(
    input({
      relatedProducts: [
        { id: "r1", slug: "related-1", name: "Liên quan 1", media, variants: [] },
        { id: "r2", slug: "related-2", name: "Liên quan 2", media, variants: [] },
      ],
      relatedSelectEventBySlug: new Map([["related-1", selectEvent]]),
    }),
  );

  assert.deepEqual(model.relatedCards.map((card) => card.id), ["r1", "r2"]);
  assert.equal(model.relatedCards[0]?.model.selectEvent, selectEvent);
  assert.equal(model.relatedCards[1]?.model.selectEvent, null);
});

test("a product with nothing related produces no cards, not an empty grid decision", () => {
  assert.deepEqual(buildProductViewModel(input()).relatedCards, []);
});

test("the view model is frozen so markup cannot mutate a decision it was handed", () => {
  const model = buildProductViewModel(input({ material: "cotton" }));

  assert.equal(Object.isFrozen(model), true);
  assert.equal(Object.isFrozen(model.editorial), true);
});
