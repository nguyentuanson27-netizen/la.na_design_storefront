import assert from "node:assert/strict";
import test from "node:test";

import type { StorefrontProductMedia, TrustedProductImage } from "../../src/commerce/product-media.ts";
import { resolveGalleryModel } from "../../src/components/headless/resolve-gallery-model.ts";

/**
 * Characterization tests for the product gallery's decisions, captured before they moved out of
 * `ProductGallery`.
 *
 * The component itself cannot be unit-tested here -- it is a `.tsx` module and this runner cannot
 * load one -- so the decisions it used to make inline live in a pure model that these tests hold to
 * the baseline: which presentation the image count calls for, which index is active, what each
 * image's alt text reads, and which thumbnail is pressed.
 */

function image(n: number, alt = ""): TrustedProductImage {
  return { url: `https://content.pancake.vn/1/2/3/4/photo-${n}.jpg`, alt };
}

function media(count: number, alt = ""): StorefrontProductMedia {
  const gallery = Array.from({ length: count }, (_, index) => image(index + 1, alt));
  return { primary: gallery[0] ?? null, gallery };
}

/* ------------------------------------------------------------------ presentation */

test("a product with no trusted photography falls back rather than rendering a blank frame", () => {
  const model = resolveGalleryModel({ media: media(0), productName: "Áo sơ mi" });

  assert.equal(model.mode, "empty");
  assert.deepEqual(model.images, []);
  assert.equal(model.activeImage, null);
  assert.deepEqual(model.thumbnails, []);
});

test("a single image gets no carousel controls", () => {
  const model = resolveGalleryModel({ media: media(1), productName: "Áo sơ mi" });

  assert.equal(model.mode, "single");
  assert.equal(model.activeIndex, 0);
  assert.equal(model.activeImage?.url, image(1).url);
  assert.deepEqual(model.thumbnails, [], "one image needs no thumbnail strip");
});

test("two or more images get the carousel with one thumbnail each", () => {
  const model = resolveGalleryModel({ media: media(3), productName: "Áo sơ mi" });

  assert.equal(model.mode, "carousel");
  assert.equal(model.thumbnails.length, 3);
  assert.deepEqual(
    model.thumbnails.map((thumb) => thumb.isSelected),
    [true, false, false],
  );
});

/* ------------------------------------------------------------------- alt text */

test("an image with its own alt text keeps it, on both the frame and the thumbnail", () => {
  const model = resolveGalleryModel({ media: media(2, "Mặt trước"), productName: "Áo sơ mi" });

  assert.equal(model.activeImage?.alt, "Mặt trước");
  assert.equal(model.thumbnails[0]?.alt, "Mặt trước");
});

test("an image with no alt text falls back to the product name and its position", () => {
  const single = resolveGalleryModel({ media: media(1), productName: "Áo sơ mi" });
  assert.equal(single.activeImage?.alt, "Áo sơ mi", "a lone image is just the product");

  const carousel = resolveGalleryModel({
    media: media(3),
    productName: "Áo sơ mi",
    manualSelection: { variantId: null, index: 1 },
  });
  assert.equal(carousel.activeImage?.alt, "Áo sơ mi - Ảnh 2");
  assert.equal(carousel.thumbnails[2]?.alt, "Thumbnail 3");
});

/* -------------------------------------------------------------- active index */

test("a server-resolved deep-link index opens on that image", () => {
  const model = resolveGalleryModel({ media: media(4), productName: "Áo sơ mi", initialIndex: 2 });

  assert.equal(model.activeIndex, 2);
  assert.equal(model.activeImage?.url, image(3).url);
});

test("an index outside the gallery is clamped to the first image, not trusted", () => {
  // The caller resolves this from catalog data, but an index past the end would render a blank
  // frame. The baseline clamps; so does the model.
  for (const initialIndex of [-1, 9, 1.5, Number.NaN]) {
    const model = resolveGalleryModel({ media: media(3), productName: "Áo sơ mi", initialIndex });
    assert.equal(model.activeIndex, 0, `index ${String(initialIndex)} must clamp`);
  }
});

test("clicking a thumbnail moves the frame to it", () => {
  const model = resolveGalleryModel({
    media: media(3),
    productName: "Áo sơ mi",
    manualSelection: { variantId: null, index: 2 },
  });

  assert.equal(model.activeIndex, 2);
  assert.deepEqual(
    model.thumbnails.map((thumb) => thumb.isSelected),
    [false, false, true],
  );
});

test("a manual pick outside the gallery is clamped like any other index", () => {
  const model = resolveGalleryModel({
    media: media(3),
    productName: "Áo sơ mi",
    manualSelection: { variantId: null, index: 7 },
  });

  assert.equal(model.activeIndex, 0);
});

/* ------------------------------------------- selection semantics shared with the panel */

test("the selected variant moves the frame to that variant's image", () => {
  // The seam the purchase panel and the gallery share: the panel reports which variant is
  // selected, and this mapping -- the same one the server uses for `?variant=` deep links --
  // decides which photo that is.
  const model = resolveGalleryModel({
    media: media(4),
    productName: "Áo sơ mi",
    selectedVariantId: "variant-b",
    galleryIndexByVariantId: { "variant-a": 0, "variant-b": 3 },
  });

  assert.equal(model.activeIndex, 3);
});

test("a selected variant the mapping does not cover leaves the frame where it was", () => {
  const model = resolveGalleryModel({
    media: media(4),
    productName: "Áo sơ mi",
    initialIndex: 1,
    selectedVariantId: "variant-unmapped",
    galleryIndexByVariantId: { "variant-a": 0 },
  });

  assert.equal(model.activeIndex, 1);
});

test("a variant mapped outside the gallery is clamped, not rendered blank", () => {
  const model = resolveGalleryModel({
    media: media(2),
    productName: "Áo sơ mi",
    selectedVariantId: "variant-a",
    galleryIndexByVariantId: { "variant-a": 5 },
  });

  assert.equal(model.activeIndex, 0);
});

test("a thumbnail picked for the current variant survives re-renders", () => {
  const model = resolveGalleryModel({
    media: media(4),
    productName: "Áo sơ mi",
    selectedVariantId: "variant-b",
    galleryIndexByVariantId: { "variant-b": 3 },
    manualSelection: { variantId: "variant-b", index: 1 },
  });

  assert.equal(model.activeIndex, 1, "the shopper's own pick wins while the variant is unchanged");
});

test("changing variant overrides a thumbnail picked for the previous one", () => {
  const model = resolveGalleryModel({
    media: media(4),
    productName: "Áo sơ mi",
    selectedVariantId: "variant-b",
    galleryIndexByVariantId: { "variant-a": 0, "variant-b": 3 },
    manualSelection: { variantId: "variant-a", index: 1 },
  });

  assert.equal(model.activeIndex, 3, "a stale pick must not pin the frame to the old colour");
});

/* ------------------------------------------------------------ preload and labels */

test("only the first image preloads, and only while it is the one on screen", () => {
  const first = resolveGalleryModel({ media: media(3), productName: "Áo sơ mi" });
  assert.equal(first.preloadsActiveImage, true);

  const moved = resolveGalleryModel({
    media: media(3),
    productName: "Áo sơ mi",
    manualSelection: { variantId: null, index: 1 },
  });
  assert.equal(moved.preloadsActiveImage, false);
});

test("a single image always preloads, as the baseline does", () => {
  const model = resolveGalleryModel({ media: media(1), productName: "Áo sơ mi" });

  assert.equal(model.preloadsActiveImage, true);
});

test("the carousel and its thumbnail strip are labelled with the product name", () => {
  const model = resolveGalleryModel({ media: media(3), productName: "Áo sơ mi" });

  assert.equal(model.regionLabel, "Bộ sưu tập hình ảnh Áo sơ mi");
  assert.equal(model.thumbnailsLabel, "Danh sách ảnh chi tiết của Áo sơ mi");
  assert.equal(model.thumbnails[1]?.label, "Xem ảnh 2 của Áo sơ mi");
});

test("the model is frozen so a brand cannot mutate a decision it was handed", () => {
  const model = resolveGalleryModel({ media: media(2), productName: "Áo sơ mi" });

  assert.equal(Object.isFrozen(model), true);
  assert.equal(Object.isFrozen(model.thumbnails), true);
});
