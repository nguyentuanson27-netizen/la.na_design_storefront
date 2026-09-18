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
