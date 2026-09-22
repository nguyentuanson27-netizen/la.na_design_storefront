import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDesktopProductGallerySlides,
  gallerySlideIndexForImage,
  resolveGallerySlideForSelection,
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

/* ------------------------------------------------- canonical first surface / variant media seam */

const SLIDES = buildDesktopProductGallerySlides(6);
const GALLERY_INDEX_BY_VARIANT = { "variant-a": 0, "variant-d": 4, "variant-f": 5 } as const;

test("a deep-linked variant preselects without replacing slide 1 on initial load", () => {
  // The component opens on slide 0 and treats the server-resolved deep-link variant as already
  // consumed. Asking the seam for the same variant it opened with must leave the canonical first
  // surface alone even though that variant maps to image 4 / slide 2.
  const opened = resolveGallerySlideForSelection({
    slides: SLIDES,
    currentSlide: 0,
    syncedVariantId: "variant-d",
    selectedVariantId: "variant-d",
    galleryIndexByVariantId: GALLERY_INDEX_BY_VARIANT,
  });

  assert.deepEqual(opened, { slide: 0, syncedVariantId: "variant-d" });
});

test("a post-load variant change syncs the gallery to the slide holding its mapped image", () => {
  const changed = resolveGallerySlideForSelection({
    slides: SLIDES,
    currentSlide: 0,
    syncedVariantId: "variant-d",
    selectedVariantId: "variant-f",
    galleryIndexByVariantId: GALLERY_INDEX_BY_VARIANT,
  });

  assert.deepEqual(changed, { slide: 3, syncedVariantId: "variant-f" });
});

test("a variant with no mapped image leaves the shopper where they are", () => {
  const unmapped = resolveGallerySlideForSelection({
    slides: SLIDES,
    currentSlide: 2,
    syncedVariantId: "variant-a",
    selectedVariantId: "variant-unmapped",
    galleryIndexByVariantId: GALLERY_INDEX_BY_VARIANT,
  });

  assert.deepEqual(unmapped, { slide: 2, syncedVariantId: "variant-unmapped" });
});

test("a manual gallery choice survives every render until the selection itself changes", () => {
  // The shopper dragged to slide 3 while `variant-a` -- whose mapped image is slide 0 -- stayed
  // selected. Re-resolving must not drag them back to the variant's photograph.
  const manual = resolveGallerySlideForSelection({
    slides: SLIDES,
    currentSlide: 3,
    syncedVariantId: "variant-a",
    selectedVariantId: "variant-a",
    galleryIndexByVariantId: GALLERY_INDEX_BY_VARIANT,
  });

  assert.deepEqual(manual, { slide: 3, syncedVariantId: "variant-a" });

  // ...and clearing the selection is a change like any other, but has no mapped image to move to.
  const cleared = resolveGallerySlideForSelection({
    slides: SLIDES,
    currentSlide: 3,
    syncedVariantId: "variant-a",
    selectedVariantId: null,
    galleryIndexByVariantId: GALLERY_INDEX_BY_VARIANT,
  });

  assert.deepEqual(cleared, { slide: 3, syncedVariantId: null });
});

test("an out-of-range mapped index is clamped away rather than trusted", () => {
  const forged = resolveGallerySlideForSelection({
    slides: SLIDES,
    currentSlide: 1,
    syncedVariantId: null,
    selectedVariantId: "variant-forged",
    galleryIndexByVariantId: { "variant-forged": 99 },
  });

  assert.deepEqual(forged, { slide: 1, syncedVariantId: "variant-forged" });
});
