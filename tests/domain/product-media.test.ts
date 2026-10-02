import assert from "node:assert/strict";
import test from "node:test";

import {
  parseTrustedProductImageUrl,
  parseTrustedProductVideoUrl,
  resolveStorefrontProductMedia,
  resolveVariantGalleryIndexes,
  type TrustedProductImage,
} from "../../src/commerce/product-media.ts";

test("parseTrustedProductImageUrl accepts reviewed HTTPS Pancake content URLs (.jpg, .png, and .webp)", () => {
  const validUrls = [
    "https://content.pancake.vn/images/1/2/3/shirt.jpg",
    "https://content.pancake.vn/web_media/12/34/56/shirt.jpg",
    "https://content.pancake.vn/images/999/888/777/product-photo_123.jpg",
    "https://content.pancake.vn/images/1/2/3/shirt.png",
    "https://content.pancake.vn/web_media/12/34/56/shirt.png",
    "https://content.pancake.vn/images/1/2/3/shirt.webp",
    "https://content.pancake.vn/2-2609/2026/9/7/60939f058e4a6add1a156b7d13d6cf1bf2226fbd.png",
    "https://content.pancake.vn/2-2609/2026/9/23/a37fe5e5bf493ae284fa4f8fc22ba9178de76a4f.webp",
  ];

  for (const url of validUrls) {
    const parsed = parseTrustedProductImageUrl(url);
    assert.equal(parsed, url.trim());
  }
});

test("parseTrustedProductImageUrl rejects unreviewed file extensions (.jpeg, .svg, uppercase .JPG/.PNG/.WEBP, etc.)", () => {
  const unreviewedExtensionUrls = [
    "https://content.pancake.vn/images/1/2/3/shirt.jpeg",
    "https://content.pancake.vn/images/1/2/3/shirt.JPG",
    "https://content.pancake.vn/images/1/2/3/SHIRT.JPG",
    "https://content.pancake.vn/images/1/2/3/shirt.PNG",
    "https://content.pancake.vn/images/1/2/3/SHIRT.PNG",
    "https://content.pancake.vn/images/1/2/3/shirt.WEBP",
    "https://content.pancake.vn/images/1/2/3/SHIRT.WEBP",
    "https://content.pancake.vn/images/1/2/3/vector.svg",
    "https://content.pancake.vn/images/1/2/3/script.js",
    "https://content.pancake.vn/images/1/2/3/doc.html",
    "https://content.pancake.vn/images/1/2/3/app.exe",
  ];

  for (const url of unreviewedExtensionUrls) {
    assert.equal(parseTrustedProductImageUrl(url), null);
  }
});

test("parseTrustedProductImageUrl rejects non-HTTPS schemes", () => {
  const insecureUrls = [
    "http://content.pancake.vn/images/1/2/3/shirt.jpg",
    "ftp://content.pancake.vn/images/1/2/3/shirt.jpg",
    "data:image/jpeg;base64,abc",
    "javascript:alert(1)",
    "file:///etc/passwd",
  ];

  for (const url of insecureUrls) {
    assert.equal(parseTrustedProductImageUrl(url), null);
  }
});

test("parseTrustedProductImageUrl rejects unreviewed hosts, subdomains, and IP addresses", () => {
  const invalidHosts = [
    "https://evil.com/images/shirt.jpg",
    "https://content.pancake.vn.evil.com/images/shirt.jpg",
    "https://pancake.vn/images/shirt.jpg",
    "https://api.pancake.vn/images/shirt.jpg",
    "https://pos.pancake.vn/images/shirt.jpg",
    "https://127.0.0.1/images/shirt.jpg",
    "https://localhost/images/shirt.jpg",
  ];

  for (const url of invalidHosts) {
    assert.equal(parseTrustedProductImageUrl(url), null);
  }
});

test("parseTrustedProductImageUrl rejects credentials in URL authority", () => {
  const credentialUrls = [
    "https://user:pass@content.pancake.vn/images/shirt.jpg",
    "https://admin@content.pancake.vn/images/shirt.jpg",
  ];

  for (const url of credentialUrls) {
    assert.equal(parseTrustedProductImageUrl(url), null);
  }
});

test("parseTrustedProductImageUrl rejects custom ports", () => {
  const portUrls = [
    "https://content.pancake.vn:8443/images/shirt.jpg",
    "https://content.pancake.vn:443/images/shirt.jpg",
    "https://content.pancake.vn:80/images/shirt.jpg",
  ];

  for (const url of portUrls) {
    assert.equal(parseTrustedProductImageUrl(url), null);
  }
});

test("parseTrustedProductImageUrl rejects path traversal and unreviewed file extensions", () => {
  const invalidPaths = [
    "https://content.pancake.vn/images/1/2/3/../secret.jpg",
    "https://content.pancake.vn/",
    "https://content.pancake.vn/images/1/2/3/script.js",
    "https://content.pancake.vn/images/1/2/3/doc.html",
    "https://content.pancake.vn/images/1/2/3/vector.svg",
    "https://content.pancake.vn/images/1/2/3/app.exe",
  ];

  for (const url of invalidPaths) {
    assert.equal(parseTrustedProductImageUrl(url), null);
  }
});

test("parseTrustedProductImageUrl rejects unreviewed path shapes on trusted host", () => {
  const unreviewedPathUrls = [
    "https://content.pancake.vn/arbitrary/shirt.jpg",
    "https://content.pancake.vn/images/shirt.jpg",
    "https://content.pancake.vn/images/1/2/shirt.jpg",
    "https://content.pancake.vn/images/a/2/3/shirt.jpg",
    "https://content.pancake.vn/images/1/b/3/shirt.jpg",
    "https://content.pancake.vn/images/1/2/c/shirt.jpg",
    "https://content.pancake.vn/images/1/2/3/extra/shirt.jpg",
    "https://content.pancake.vn/images/1/2/3//shirt.jpg",
    "https://content.pancake.vn/images/1/2/3/.jpg",
  ];

  for (const url of unreviewedPathUrls) {
    assert.equal(parseTrustedProductImageUrl(url), null);
  }
});

test("parseTrustedProductImageUrl rejects malformed, oversized, or non-string inputs", () => {
  assert.equal(parseTrustedProductImageUrl(null), null);
  assert.equal(parseTrustedProductImageUrl(undefined), null);
  assert.equal(parseTrustedProductImageUrl(""), null);
  assert.equal(parseTrustedProductImageUrl("   "), null);
  assert.equal(parseTrustedProductImageUrl("not a url"), null);
  assert.equal(
    parseTrustedProductImageUrl(`https://content.pancake.vn/${"a".repeat(4097)}.jpg`),
    null,
  );
});

test("resolveStorefrontProductMedia returns null primary and empty gallery when all media is missing or untrusted", () => {
  const media = resolveStorefrontProductMedia({
    productName: "Classic Linen Shirt",
    primaryImageUrl: "http://insecure.test/shirt.jpg",
    variantImageUrls: [
      ["https://evil.com/fake.jpg", "invalid-url"],
      [],
    ],
  });

  assert.equal(media.primary, null);
  assert.deepEqual(media.gallery, []);
});

test("resolveStorefrontProductMedia resolves primary and gallery deterministically with deduplication", () => {
  const media = resolveStorefrontProductMedia({
    productName: "Classic Oxford Shirt",
    primaryImageUrl: "https://content.pancake.vn/images/1/2/3/primary.jpg",
    variantImageUrls: [
      // Duplicate of primary
      ["https://content.pancake.vn/images/1/2/3/primary.jpg", "https://content.pancake.vn/images/1/2/3/blue.jpg"],
      // Another variant with blue and an untrusted URL
      ["https://content.pancake.vn/images/1/2/3/blue.jpg", "http://insecure.test/bad.jpg", "https://content.pancake.vn/images/1/2/3/white.jpg"],
    ],
  });

  const expectedGallery: TrustedProductImage[] = [
    {
      url: "https://content.pancake.vn/images/1/2/3/primary.jpg",
      alt: "Classic Oxford Shirt - Ảnh 1",
    },
    {
      url: "https://content.pancake.vn/images/1/2/3/blue.jpg",
      alt: "Classic Oxford Shirt - Ảnh 2",
    },
    {
      url: "https://content.pancake.vn/images/1/2/3/white.jpg",
      alt: "Classic Oxford Shirt - Ảnh 3",
    },
  ];

  assert.deepEqual(media.primary, {
    url: "https://content.pancake.vn/images/1/2/3/primary.jpg",
    alt: "Classic Oxford Shirt",
  });
  assert.deepEqual(media.gallery, expectedGallery);
});

test("resolveStorefrontProductMedia uses first valid variant image when primaryImageUrl is missing", () => {
  const media = resolveStorefrontProductMedia({
    productName: "Minimalist T-Shirt",
    primaryImageUrl: null,
    variantImageUrls: [
      ["https://content.pancake.vn/images/1/2/3/black.jpg"],
      ["https://content.pancake.vn/images/1/2/3/white.jpg"],
    ],
  });

  assert.deepEqual(media.primary, {
    url: "https://content.pancake.vn/images/1/2/3/black.jpg",
    alt: "Minimalist T-Shirt",
  });
  assert.equal(media.gallery.length, 2);
  assert.equal(media.gallery[0]?.url, "https://content.pancake.vn/images/1/2/3/black.jpg");
  assert.equal(media.gallery[0]?.alt, "Minimalist T-Shirt - Ảnh 1");
  assert.equal(media.gallery[1]?.url, "https://content.pancake.vn/images/1/2/3/white.jpg");
  assert.equal(media.gallery[1]?.alt, "Minimalist T-Shirt - Ảnh 2");
});

test("resolveStorefrontProductMedia sets clean single alt text when only one image is available", () => {
  const media = resolveStorefrontProductMedia({
    productName: "Tailored Trousers",
    primaryImageUrl: "https://content.pancake.vn/images/1/2/3/pants.jpg",
    variantImageUrls: [],
  });

  assert.deepEqual(media.primary, {
    url: "https://content.pancake.vn/images/1/2/3/pants.jpg",
    alt: "Tailored Trousers",
  });
  assert.deepEqual(media.gallery, [
    {
      url: "https://content.pancake.vn/images/1/2/3/pants.jpg",
      alt: "Tailored Trousers",
    },
  ]);
});

test("resolveStorefrontProductMedia falls back to default name when productName is blank", () => {
  const media = resolveStorefrontProductMedia({
    productName: "   ",
    primaryImageUrl: "https://content.pancake.vn/images/1/2/3/item.jpg",
  });

  assert.deepEqual(media.primary, {
    url: "https://content.pancake.vn/images/1/2/3/item.jpg",
    alt: "Product",
  });
  assert.deepEqual(media.gallery, [
    {
      url: "https://content.pancake.vn/images/1/2/3/item.jpg",
      alt: "Product",
    },
  ]);
});

test("resolveStorefrontProductMedia gracefully ignores undefined/null elements in variant lists", () => {
  const media = resolveStorefrontProductMedia({
    productName: "Silk Scarf",
    primaryImageUrl: null,
    variantImageUrls: [
      [null, undefined, "   ", "https://content.pancake.vn/images/1/2/3/scarf.jpg"],
    ],
  });

  assert.deepEqual(media.primary, {
    url: "https://content.pancake.vn/images/1/2/3/scarf.jpg",
    alt: "Silk Scarf",
  });
  assert.equal(media.gallery.length, 1);
});

test("resolveStorefrontProductMedia caps returned gallery images at MAX_STOREFRONT_GALLERY_IMAGES (12)", () => {
  const manyValidUrls = Array.from(
    { length: 25 },
    (_, i) => `https://content.pancake.vn/images/1/2/3/img_${i + 1}.jpg`,
  );

  const media = resolveStorefrontProductMedia({
    productName: "Oversized Hoodie",
    primaryImageUrl: "https://content.pancake.vn/images/1/2/3/primary.jpg",
    variantImageUrls: [manyValidUrls],
  });

  assert.equal(media.gallery.length, 12);
  assert.equal(media.primary?.url, "https://content.pancake.vn/images/1/2/3/primary.jpg");
  assert.equal(media.gallery[0]?.url, "https://content.pancake.vn/images/1/2/3/primary.jpg");
  assert.equal(media.gallery[1]?.url, "https://content.pancake.vn/images/1/2/3/img_1.jpg");
  assert.equal(media.gallery[11]?.url, "https://content.pancake.vn/images/1/2/3/img_11.jpg");
});

test("resolveStorefrontProductMedia bounds candidate scan processing at MAX_MEDIA_CANDIDATES_SCANNED (100)", () => {
  // 100 invalid candidate URLs followed by 1 valid URL at index 100 (101st candidate)
  const invalidCandidates = Array.from(
    { length: 100 },
    (_, i) => `https://evil.com/fake_${i}.jpg`,
  );
  const trailingValid = "https://content.pancake.vn/images/1/2/3/late.jpg";

  const media = resolveStorefrontProductMedia({
    productName: "Bound Test Product",
    primaryImageUrl: null,
    variantImageUrls: [[...invalidCandidates, trailingValid]],
  });

  assert.equal(media.primary, null);
  assert.deepEqual(media.gallery, []);
});

test("resolveStorefrontProductMedia provides secondary image at gallery[1] for card hover swaps", () => {
  const media = resolveStorefrontProductMedia({
    productName: "Classic Blazer",
    primaryImageUrl: "https://content.pancake.vn/images/1/2/3/front.jpg",
    variantImageUrls: [["https://content.pancake.vn/images/1/2/3/back.jpg"]],
  });

  assert.equal(media.primary?.url, "https://content.pancake.vn/images/1/2/3/front.jpg");
  assert.equal(media.gallery.length, 2);
  assert.equal(media.gallery[1]?.url, "https://content.pancake.vn/images/1/2/3/back.jpg");
});


test("resolveVariantGalleryIndexes maps each variant to its own gallery slot", () => {
  const gallery = resolveStorefrontProductMedia({
    productName: "Deep Link Product",
    primaryImageUrl: "https://content.pancake.vn/images/1/2/3/primary.jpg",
    variantImageUrls: [
      ["https://content.pancake.vn/images/1/2/3/medium.jpg"],
      ["https://content.pancake.vn/images/1/2/3/large.jpg"],
    ],
  }).gallery;

  const indexes = resolveVariantGalleryIndexes({
    gallery,
    variants: [
      { id: "v-medium", imageUrls: ["https://content.pancake.vn/images/1/2/3/medium.jpg"] },
      { id: "v-large", imageUrls: ["https://content.pancake.vn/images/1/2/3/large.jpg"] },
    ],
  });

  assert.equal(indexes.get("v-medium"), 1);
  assert.equal(indexes.get("v-large"), 2);
});

test("resolveVariantGalleryIndexes leaves out variants with no locatable trusted image", () => {
  const gallery = resolveStorefrontProductMedia({
    productName: "Deep Link Product",
    primaryImageUrl: "https://content.pancake.vn/images/1/2/3/primary.jpg",
    variantImageUrls: [],
  }).gallery;

  const indexes = resolveVariantGalleryIndexes({
    gallery,
    variants: [
      { id: "v-untrusted", imageUrls: ["https://evil.com/spoof.jpg"] },
      { id: "v-empty", imageUrls: [] },
      { id: "v-not-in-gallery", imageUrls: ["https://content.pancake.vn/images/1/2/3/absent.jpg"] },
      { id: "v-primary", imageUrls: ["https://content.pancake.vn/images/1/2/3/primary.jpg"] },
    ],
  });

  assert.equal(indexes.has("v-untrusted"), false);
  assert.equal(indexes.has("v-empty"), false);
  assert.equal(indexes.has("v-not-in-gallery"), false);
  // The product's own primary photo is a legitimate answer when a variant reuses it.
  assert.equal(indexes.get("v-primary"), 0);
});

test("resolveVariantGalleryIndexes skips untrusted candidates and takes the first trusted one", () => {
  const gallery = resolveStorefrontProductMedia({
    productName: "Deep Link Product",
    primaryImageUrl: "https://content.pancake.vn/images/1/2/3/primary.jpg",
    variantImageUrls: [["https://content.pancake.vn/images/1/2/3/second.jpg"]],
  }).gallery;

  const indexes = resolveVariantGalleryIndexes({
    gallery,
    variants: [
      {
        id: "v-mixed",
        imageUrls: [
          null,
          123,
          "https://evil.com/spoof.jpg",
          "https://content.pancake.vn/images/1/2/3/second.jpg",
        ],
      },
    ],
  });

  assert.equal(indexes.get("v-mixed"), 1);
});

/* ------------------------------------------------------- editorial video (Phase E) */

test("an mp4 is video, never an image", () => {
  // Widening the image parser instead of adding an entry point would have let anything asking for a
  // photograph be handed a video file.
  const mp4 = "https://content.pancake.vn/1/2/3/4/film.mp4";

  assert.equal(parseTrustedProductImageUrl(mp4), null);
  assert.equal(parseTrustedProductVideoUrl(mp4), mp4);
});

test("an image is not video either: the two extension sets do not overlap", () => {
  assert.equal(parseTrustedProductVideoUrl("https://content.pancake.vn/1/2/3/4/photo.jpg"), null);
  assert.equal(parseTrustedProductVideoUrl("https://content.pancake.vn/1/2/3/4/photo.png"), null);
});

test("video is held to every rule an image is held to", () => {
  // The same reviewed host and the same reviewed path shape. This adds a media type, not a place
  // media may come from.
  for (const rejected of [
    "http://content.pancake.vn/1/2/3/4/film.mp4",
    "https://evil.example.com/1/2/3/4/film.mp4",
    "https://content.pancake.vn:8443/1/2/3/4/film.mp4",
    "https://user:pass@content.pancake.vn/1/2/3/4/film.mp4",
    "https://content.pancake.vn/1/2/3/../4/film.mp4",
    "https://content.pancake.vn/film.mp4",
    "https://content.pancake.vn/1/2/3/4/film.mp4.exe",
    "",
    null,
    undefined,
    42,
  ]) {
    assert.equal(parseTrustedProductVideoUrl(rejected), null, `must reject ${String(rejected)}`);
  }
});
