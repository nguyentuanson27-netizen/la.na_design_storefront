import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDesktopProductGallerySlides,
  gallerySlideIndexForImage,
  stepGallerySlide,
} from "../../src/components/brand/product-gallery-layout.ts";

test("desktop gallery keeps the first image alone then pairs the remainder", () => {
  assert.deepEqual(buildDesktopProductGallerySlides(0), []);
  assert.deepEqual(buildDesktopProductGallerySlides(1), [[0]]);
  assert.deepEqual(buildDesktopProductGallerySlides(2), [[0], [1]]);
  assert.deepEqual(buildDesktopProductGallerySlides(3), [[0], [1, 2]]);
  assert.deepEqual(buildDesktopProductGallerySlides(6), [[0], [1, 2], [3, 4], [5]]);
});

test("variant/deep-link image resolves to the slide that contains it", () => {
  const slides = buildDesktopProductGallerySlides(6);
  assert.equal(gallerySlideIndexForImage(slides, 0), 0);
  assert.equal(gallerySlideIndexForImage(slides, 1), 1);
  assert.equal(gallerySlideIndexForImage(slides, 2), 1);
  assert.equal(gallerySlideIndexForImage(slides, 4), 2);
  assert.equal(gallerySlideIndexForImage(slides, 5), 3);
});

test("desktop gallery navigation clamps at both ends instead of looping", () => {
  assert.equal(stepGallerySlide(0, -1, 4), 0);
  assert.equal(stepGallerySlide(0, 1, 4), 1);
  assert.equal(stepGallerySlide(2, 1, 4), 3);
  assert.equal(stepGallerySlide(3, 1, 4), 3);
  assert.equal(stepGallerySlide(3, -1, 4), 2);
});
