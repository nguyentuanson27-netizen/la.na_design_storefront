import assert from "node:assert/strict";
import test from "node:test";

import {
  PRODUCT_FEEDBACK_ANCHOR,
  STRIP_THUMBNAIL_COUNT,
  resolveCustomerPhotoStrip,
  stripReplacesFeedbackLink,
} from "../../src/components/headless/customer-photo-strip-model.ts";
import {
  buildProductReviewSection,
  type ProductReviewRow,
} from "../../src/commerce/product-review.ts";

const src = (n: number) => `https://content.pancake.vn/1/2/3/4/photo-${n}.jpg`;
const images = (count: number, from = 0) => Array.from({ length: count }, (_, index) => ({ src: src(from + index) }));

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
  resolveCustomerPhotoStrip({ reviews: null, feedback: null, ...overrides });

test("review photographs of the product itself come first, and are titled 'Đánh giá sản phẩm'", () => {
  const strip = resolve({
    reviews: buildProductReviewSection([review(4)]),
    feedback: { scope: "brand", images: images(8) },
  });
  assert.equal(strip?.kind, "review");
  assert.equal(strip?.href, "#pdp-review-photos");
  assert.equal(strip?.title, "Đánh giá sản phẩm");
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

test("a product's own tagged photographs are titled 'Đánh giá sản phẩm' and keep their order", () => {
  const strip = resolve({ feedback: { scope: "product", images: images(6) } });
  assert.equal(strip?.kind, "product");
  assert.equal(strip?.href, `#${PRODUCT_FEEDBACK_ANCHOR}`);
  assert.equal(strip?.title, "Đánh giá sản phẩm");
  assert.equal(strip?.subtitle, "6 ảnh thật · bấm để xem");
  assert.deepEqual([...(strip?.photos ?? [])], [src(0), src(1), src(2), src(3)]);
});

test("the shared brand gallery never becomes a strip under the price", () => {
  assert.equal(resolve({ feedback: { scope: "brand", images: images(12) } }), null);
  assert.equal(resolve({ feedback: { scope: "brand", images: images(3) } }), null);
});

test("a product's own tagged photographs win over the brand gallery, and review photographs over both", () => {
  const reviews = buildProductReviewSection([review(4)]);
  assert.equal(resolve({ reviews, feedback: { scope: "brand", images: images(8) } })?.kind, "review");
  assert.equal(resolve({ reviews: buildProductReviewSection([review(2)]), feedback: { scope: "brand", images: images(8) } }), null);
});

test("each source needs at least three photographs", () => {
  assert.equal(resolve({ feedback: { scope: "product", images: images(2) } }), null);
  assert.equal(resolve({ reviews: buildProductReviewSection([review(2)]) }), null);
  assert.equal(resolve({ feedback: { scope: "product", images: images(3) } })?.photos.length, 3);
  assert.equal(resolve(), null);
});

test("the link under the buy buttons steps aside for a product strip, not for review photographs", () => {
  assert.equal(stripReplacesFeedbackLink(null), false);
  assert.equal(stripReplacesFeedbackLink(resolve({ reviews: buildProductReviewSection([review(4)]) })), false);
  assert.equal(stripReplacesFeedbackLink(resolve({ feedback: { scope: "product", images: images(4) } })), true);
});
