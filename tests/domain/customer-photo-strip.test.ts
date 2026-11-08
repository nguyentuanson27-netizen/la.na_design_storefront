import assert from "node:assert/strict";
import test from "node:test";

import {
  PRODUCT_FEEDBACK_ANCHOR,
  STRIP_THUMBNAIL_COUNT,
  resolveCustomerPhotoStrip,
  rotatePhotos,
  stableHash,
  stripReplacesFeedbackLink,
} from "../../src/components/headless/customer-photo-strip-model.ts";
import {
  buildProductReviewSection,
  type ProductReviewRow,
} from "../../src/commerce/product-review.ts";

const src = (n: number) => `https://content.pancake.vn/1/2/3/4/photo-${n}.jpg`;
const images = (count: number, from = 0) => Array.from({ length: count }, (_, index) => ({ src: src(from + index) }));
const BRAND = "La.na Design";

function review(photoCount: number, id = "r"): ProductReviewRow {
  return {
    id,
    rating: 5,
    authorName: "Lan A.",
    body: "Đẹp",
    source: "ZALO",
    fit: null,
    sizeLabel: null,
    colorLabel: null,
    heightCm: null,
    weightKg: null,
    imageUrls: Array.from({ length: photoCount }, (_, index) => src(100 + index)),
    orderPublicCode: null,
    shopReply: null,
    reviewedAt: new Date("2026-11-05T05:00:00.000Z"),
  };
}

const resolve = (overrides: Partial<Parameters<typeof resolveCustomerPhotoStrip>[0]> = {}) =>
  resolveCustomerPhotoStrip({ reviews: null, feedback: null, slug: "vay-lua", brandName: BRAND, ...overrides });

test("review photographs of the product itself come first, and say 'mẫu này'", () => {
  const strip = resolve({
    reviews: buildProductReviewSection([review(4)]),
    feedback: { scope: "brand", images: images(8) },
  });
  assert.equal(strip?.kind, "review");
  assert.equal(strip?.href, "#pdp-review-photos");
  assert.equal(strip?.title, "Ảnh khách diện mẫu này");
  assert.equal(strip?.subtitle, "4 ảnh thật · bấm để xem");
  assert.equal(strip?.photos.length, STRIP_THUMBNAIL_COUNT);
});

test("fewer than three review photographs leave the strip to the next source", () => {
  const strip = resolve({
    reviews: buildProductReviewSection([review(2)]),
    feedback: { scope: "product", images: images(5) },
  });
  assert.equal(strip?.kind, "product");
});

test("a product's own tagged photographs say 'mẫu này' and keep their order", () => {
  const strip = resolve({ feedback: { scope: "product", images: images(6) } });
  assert.equal(strip?.kind, "product");
  assert.equal(strip?.href, `#${PRODUCT_FEEDBACK_ANCHOR}`);
  assert.equal(strip?.title, "Ảnh khách diện mẫu này");
  assert.equal(strip?.subtitle, "6 ảnh thật · bấm để xem");
  assert.deepEqual([...(strip?.photos ?? [])], [src(0), src(1), src(2), src(3)]);
});

test("the shared brand gallery is worded as the brand's, never as this product's", () => {
  const strip = resolve({ feedback: { scope: "brand", images: images(12) } });
  assert.equal(strip?.kind, "brand");
  assert.equal(strip?.title, "Khách hàng La.na Design");
  assert.equal(strip?.subtitle, "Xem ảnh khách mặc thật · 12 ảnh");
  assert.equal(strip?.href, "#pdp-feedback");
  assert.doesNotMatch(`${strip?.title} ${strip?.subtitle}`, /mẫu này/);
});

test("each source needs at least three photographs", () => {
  assert.equal(resolve({ feedback: { scope: "brand", images: images(2) } }), null);
  assert.equal(resolve({ feedback: { scope: "product", images: images(2) } }), null);
  assert.equal(resolve({ reviews: buildProductReviewSection([review(2)]) }), null);
  assert.equal(resolve({ feedback: { scope: "brand", images: images(3) } })?.photos.length, 3);
  assert.equal(resolve(), null);
});

test("brand thumbnails are stable for a product and differ between products", () => {
  const feedback = { scope: "brand" as const, images: images(12) };
  const first = resolve({ feedback, slug: "vay-lua-hoa-nhi" })!.photos;
  assert.deepEqual([...resolve({ feedback, slug: "vay-lua-hoa-nhi" })!.photos], [...first], "the same slug, the same photographs");

  const slugs = ["vay-lua-hoa-nhi", "set-ao-dai-cach-tan", "dam-xoe-linen", "ao-dai-tet-do", "set-vay-form-rong", "vay-denim"];
  const sets = new Set(slugs.map((slug) => resolve({ feedback, slug })!.photos.join("|")));
  assert.ok(sets.size >= 4, `expected varied selections across products, got ${sets.size}`);
});

test("rotation wraps around the end and never repeats a photograph within a strip", () => {
  const sources = Array.from({ length: 5 }, (_, index) => src(index));
  for (let seed = 0; seed < 40; seed += 1) {
    const picked = rotatePhotos(sources, `slug-${seed}`);
    assert.equal(picked.length, STRIP_THUMBNAIL_COUNT);
    assert.equal(new Set(picked).size, STRIP_THUMBNAIL_COUNT);
    for (const photo of picked) assert.ok(sources.includes(photo));
  }
  assert.deepEqual([...rotatePhotos(sources.slice(0, 3), "x")], sources.slice(0, 3), "fewer than fit are all shown, in order");
});

test("the hash is deterministic", () => {
  assert.equal(stableHash("vay-lua"), stableHash("vay-lua"));
  assert.notEqual(stableHash("vay-lua"), stableHash("vay-lua-2"));
});

test("the link under the buy buttons steps aside for a product or brand strip, not for review photographs", () => {
  assert.equal(stripReplacesFeedbackLink(null), false);
  assert.equal(stripReplacesFeedbackLink(resolve({ reviews: buildProductReviewSection([review(4)]) })), false);
  assert.equal(stripReplacesFeedbackLink(resolve({ feedback: { scope: "product", images: images(4) } })), true);
  assert.equal(stripReplacesFeedbackLink(resolve({ feedback: { scope: "brand", images: images(4) } })), true);
});
