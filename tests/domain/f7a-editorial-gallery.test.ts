import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { resolveStorefrontProductMedia } from "../../src/commerce/product-media.ts";
import { resolveGalleryModel } from "../../src/components/headless/resolve-gallery-model.ts";

const trusted = (name: string) => `https://content.pancake.vn/images/1/2/3/${name}.jpg`;

test("F7a multiple trusted images remain deduped and available to the editorial gallery", () => {
  const media = resolveStorefrontProductMedia({
    productName: "Áo dài Nguyệt",
    primaryImageUrl: trusted("front"),
    variantImageUrls: [[trusted("front"), trusted("back")], [trusted("detail")]],
  });

  assert.deepEqual(
    media.gallery.map(({ url }) => url),
    [trusted("front"), trusted("back"), trusted("detail")],
  );
});

test("F7a one-image and missing-media states preserve canonical fallback behavior", () => {
  const one = resolveStorefrontProductMedia({
    productName: "Váy An",
    primaryImageUrl: trusted("single"),
  });
  assert.equal(resolveGalleryModel({ media: one, productName: "Váy An" }).mode, "single");

  const missing = resolveStorefrontProductMedia({
    productName: "Váy An",
    primaryImageUrl: "https://evil.example/image.jpg",
    variantImageUrls: [["http://content.pancake.vn/images/1/2/3/nope.jpg"]],
  });
  const model = resolveGalleryModel({ media: missing, productName: "Váy An" });
  assert.equal(model.mode, "empty");
  assert.equal(model.images.length, 0);
});

test("F7a canonical media supplies meaningful product-based alt text", () => {
  const media = resolveStorefrontProductMedia({
    productName: "Set Lụa",
    primaryImageUrl: trusted("front-alt"),
    variantImageUrls: [[trusted("detail-alt")]],
  });

  assert.equal(media.gallery[0]?.alt, "Set Lụa - Ảnh 1");
  assert.equal(media.gallery[1]?.alt, "Set Lụa - Ảnh 2");
});

test("F7a brand gallery removes carousel controls for the editorial presentation", async () => {
  const source = await readFile(
    new URL("../../src/components/brand/product-gallery.tsx", import.meta.url),
    "utf8",
  );

  assert.equal(source.includes('aria-roledescription="carousel"'), false);
  assert.equal(source.includes("<button"), false, "editorial grid must not render thumbnail controls");
});

test("F7a presentation continues to consume the canonical gallery model instead of raw Pancake media", async () => {
  const source = await readFile(
    new URL("../../src/components/brand/product-gallery.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /resolveGalleryModel/);
  assert.equal(source.includes("parseTrustedProductImageUrl"), false);
  assert.equal(source.includes("resolveStorefrontProductMedia"), false);
  assert.equal(source.includes("pancakeImageUrls"), false);
});


test("owner PDP contract promotes the canonical first gallery image and removes it from the remaining gallery", async () => {
  const [pageSource, detailSource, stageSource] = await Promise.all([
    readFile(new URL("../../src/app/shop/[slug]/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/brand/product-detail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/brand/product-media-stage.tsx", import.meta.url), "utf8"),
  ]);

  // The first trusted image is still the PDP's full-bleed first surface with the header over it.
  // The refinement moved who renders it -- the stage owns every image now, because from `lg` up
  // the first surface and the gallery are the same thing -- so the contract is asserted there.
  assert.match(stageSource, /product-page-hero/);
  assert.match(stageSource, /data-header-overlay-hero/);
  assert.doesNotMatch(
    pageSource,
    /MUA NGAY/,
    "PDP hero must not receive the landing-page CTA",
  );

  /*
   * ...and it is still rendered once.
   *
   * The desktop refinement kept image 1 out of a second, below-`lg` editorial grid. The mobile
   * spec removed that grid entirely: the stage now carries both compositions itself, each gated to
   * one side of the `lg` seam, so only one of them has a box at any width. That mutual exclusion
   * is what replaces the old de-duplication, and it is what the runtime single-download gate in
   * `storefront-media.spec.ts` proves end to end.
   */
  assert.match(stageSource, /className="pdp-mobile-gallery lg:hidden"/);
  assert.match(stageSource, /className="pdp-stage__track hidden lg:block"/);
  assert.equal(
    detailSource.includes("media.gallery.slice(1)"),
    false,
    "no second gallery may re-derive a subset of the product's media",
  );

  // The one place the detail still draws media itself is the truthful missing-media fallback.
  assert.match(detailSource, /media\.gallery\.length > 0 \? null : \(/);
  assert.match(detailSource, /preloadFirstImage=\{false\}/);
});

test("the desktop media stage contains the garment and never takes the page's vertical scroll", async () => {
  const [stageSource, cssSource] = await Promise.all([
    readFile(new URL("../../src/components/brand/product-media-stage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/app/globals.css", import.meta.url), "utf8"),
  ]);

  // Refinement spec §1: the desktop stage frames the whole silhouette rather than cropping it.
  // The framing class moved off a responsive prefix when the mobile spec gated the whole desktop
  // subtree behind `hidden lg:block`, so the gate and the framing are asserted together.
  assert.match(stageSource, /className="pdp-stage__track hidden lg:block"/);
  assert.match(stageSource, /className="object-contain"/);

  // §2's hard rule. A wheel listener is how a gallery steals a scroll down the page, so the
  // absence of one is worth pinning rather than trusting to review.
  for (const forbidden of ["onWheel", "onScroll", "addEventListener"]) {
    assert.equal(
      stageSource.includes(forbidden),
      false,
      `the media stage must not intercept the page with ${forbidden}`,
    );
  }
  // And the pointer surface leaves vertical panning to the browser.
  assert.match(cssSource, /\.pdp-stage__nav \{[^}]*touch-action: pan-y;/);
  // The mobile gallery's swipe surface owes the page the same thing.
  assert.match(cssSource, /\.pdp-mobile-gallery__image \{[^}]*touch-action: pan-y;/);
});
