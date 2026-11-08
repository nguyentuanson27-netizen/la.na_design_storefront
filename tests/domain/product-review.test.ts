import assert from "node:assert/strict";
import test from "node:test";

import {
  MIN_REVIEWS_FOR_SUMMARY,
  PRODUCT_REVIEW_PAGE_LIMIT,
  PRODUCT_REVIEW_PHOTO_LIMIT,
  buildProductReviewSection,
  buildProductReviewView,
  formatReviewAverage,
  formatReviewDate,
  isSafeReviewAuthorName,
  parseProductReviewInput,
  parseReviewDate,
  summarizeProductReviews,
  type ProductReviewRow,
} from "../../src/commerce/product-review.ts";

const NOW = new Date("2026-11-08T03:00:00.000Z");
const photo = (n: number) => `https://content.pancake.vn/1/2/3/4/review-${n}.jpg`;

const VALID = {
  rating: "5",
  authorName: "Lan A.",
  body: "Vải mềm, lên form đẹp.",
  source: "ZALO",
  fit: "TRUE_TO_SIZE",
  sizeLabel: "M",
  colorLabel: "Hồng phấn",
  heightCm: "160",
  weightKg: "52",
  imageUrls: `${photo(1)}\n${photo(2)}`,
  orderPublicCode: "",
  shopReply: "",
  reviewedAt: "2026-11-05",
  status: "PUBLISHED",
  consent: "on",
} as const;

function parse(overrides: Record<string, unknown> = {}) {
  return parseProductReviewInput({ ...VALID, ...overrides }, NOW);
}

function row(overrides: Partial<ProductReviewRow> = {}): ProductReviewRow {
  return {
    id: "r1",
    rating: 5,
    authorName: "Lan A.",
    body: "Đẹp",
    source: "ZALO",
    fit: null,
    sizeLabel: null,
    colorLabel: null,
    heightCm: null,
    weightKg: null,
    imageUrls: [],
    orderPublicCode: null,
    shopReply: null,
    reviewedAt: new Date("2026-11-05T05:00:00.000Z"),
    ...overrides,
  };
}

/* ----------------------------------------------------------------------- input */

test("a complete review parses and keeps the admin's words, photos in order", () => {
  const result = parse();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.rating, 5);
  assert.equal(result.value.authorName, "Lan A.");
  assert.deepEqual(result.value.imageUrls, [photo(1), photo(2)]);
  assert.equal(result.value.heightCm, 160);
  assert.equal(result.value.orderPublicCode, null, "no order linked means no verified label");
  assert.equal(result.value.reviewedAt.toISOString(), "2026-11-05T05:00:00.000Z");
});

test("nothing is saved without the admin stating the customer agreed to publication", () => {
  for (const consent of ["", undefined, "off", "no"]) {
    assert.deepEqual(parse({ consent }), { ok: false, field: "consent" }, String(consent));
  }
  assert.equal(parse({ consent: "true" }).ok, true);
});

test("the star count is a whole number from one to five", () => {
  for (const rating of ["0", "6", "4.5", "", "abc", "-1"]) {
    assert.deepEqual(parse({ rating }), { ok: false, field: "rating" }, rating);
  }
  for (const rating of ["1", "2", "3", "4", "5"]) assert.equal(parse({ rating }).ok, true);
});

test("a display name that could identify a customer by phone or mail is refused", () => {
  assert.equal(isSafeReviewAuthorName("Lan A."), true);
  assert.equal(isSafeReviewAuthorName("Minh T"), true);
  assert.equal(isSafeReviewAuthorName("Chị Hoa (Q7)"), true);
  assert.equal(isSafeReviewAuthorName("0987654321"), false);
  assert.equal(isSafeReviewAuthorName("Lan 098 765 4321"), false);
  assert.equal(isSafeReviewAuthorName("lan@example.com"), false);
  assert.equal(isSafeReviewAuthorName(""), false);
  assert.equal(isSafeReviewAuthorName("x".repeat(41)), false);
  assert.deepEqual(parse({ authorName: "0987654321" }), { ok: false, field: "authorName" });
});

test("only trusted Pancake CDN photographs are accepted, and an untrusted one is a refusal", () => {
  assert.deepEqual(parse({ imageUrls: "https://evil.example.com/1/2/3/4/a.jpg" }), {
    ok: false,
    field: "imageUrls",
  });
  assert.deepEqual(parse({ imageUrls: `${photo(1)}\nnot a url` }), { ok: false, field: "imageUrls" });
  const duplicate = parse({ imageUrls: `${photo(1)}\n${photo(1)}\n` });
  assert.equal(duplicate.ok && duplicate.value.imageUrls.length, 1, "a repeated link is shown once");
  const seven = Array.from({ length: 7 }, (_, index) => photo(index)).join("\n");
  assert.deepEqual(parse({ imageUrls: seven }), { ok: false, field: "imageUrls" });
});

test("a review needs words or a photograph, not only stars", () => {
  assert.deepEqual(parse({ body: "", imageUrls: "" }), { ok: false, field: "content" });
  assert.equal(parse({ body: "", imageUrls: photo(1) }).ok, true);
  assert.equal(parse({ body: "Đẹp lắm", imageUrls: "" }).ok, true);
});

test("a review date is a real day, not in the future, and printed in Vietnam time", () => {
  assert.equal(parseReviewDate("2026-02-30", NOW), null);
  assert.equal(parseReviewDate("05/11/2026", NOW), null);
  assert.equal(parseReviewDate("2019-12-31", NOW), null);
  assert.equal(parseReviewDate("2026-11-20", NOW), null, "a future date is refused");
  assert.equal(parseReviewDate("2026-11-08", NOW)?.toISOString(), "2026-11-08T05:00:00.000Z", "today is allowed");
  assert.equal(parseReviewDate("2026-11-09", NOW), null, "tomorrow is not");
  assert.equal(formatReviewDate(parseReviewDate("2026-11-05", NOW)!), "05/11/2026");
  assert.deepEqual(parse({ reviewedAt: "" }), { ok: false, field: "reviewedAt" });
});

test("body facts stay inside plausible ranges and may be left empty", () => {
  assert.deepEqual(parse({ heightCm: "90" }), { ok: false, field: "heightCm" });
  assert.deepEqual(parse({ heightCm: "230" }), { ok: false, field: "heightCm" });
  assert.deepEqual(parse({ weightKg: "10" }), { ok: false, field: "weightKg" });
  assert.deepEqual(parse({ heightCm: "1m60" }), { ok: false, field: "heightCm" });
  const empty = parse({ heightCm: "", weightKg: "", fit: "", sizeLabel: "", colorLabel: "" });
  assert.equal(empty.ok && empty.value.heightCm, null);
  assert.equal(empty.ok && empty.value.fit, null);
  assert.deepEqual(parse({ fit: "HUGE" }), { ok: false, field: "fit" });
  assert.deepEqual(parse({ source: "TIKTOK" }), { ok: false, field: "source" });
  assert.deepEqual(parse({ status: "HIDDEN" }), { ok: false, field: "status" });
});

/* --------------------------------------------------------------------- summary */

test("the average and the histogram are computed from the rows", () => {
  const rows = [5, 5, 5, 4, 3].map((rating, index) => row({ id: `r${index}`, rating }));
  const summary = summarizeProductReviews(rows)!;
  assert.equal(summary.count, 5);
  assert.equal(summary.average, 4.4);
  assert.deepEqual([...summary.distribution], [3, 1, 1, 0, 0]);
  assert.equal(formatReviewAverage(summary.average), "4,4");
  assert.equal(formatReviewAverage(5), "5,0");
});

test("the average rounds to one decimal", () => {
  const rows = [5, 5, 4].map((rating, index) => row({ id: `r${index}`, rating }));
  assert.equal(summarizeProductReviews(rows)!.average, 4.7);
  assert.equal(summarizeProductReviews([])?.count, undefined);
});

test("size feedback is summarised only once enough reviewers gave it", () => {
  const four = Array.from({ length: 4 }, (_, index) => row({ id: `a${index}`, fit: "TRUE_TO_SIZE" }));
  assert.equal(summarizeProductReviews(four)!.fit, null);
  const five = [
    ...four,
    row({ id: "a4", fit: "SMALL" }),
    row({ id: "a5", fit: "LARGE" }),
    row({ id: "a6", fit: null }),
  ];
  const fit = summarizeProductReviews(five)!.fit!;
  assert.deepEqual({ ...fit }, { count: 6, small: 1, trueToSize: 4, large: 1 });
});

test("photo reviews are counted", () => {
  const rows = [row({ id: "a", imageUrls: [photo(1)] }), row({ id: "b" })];
  assert.equal(summarizeProductReviews(rows)!.photoReviewCount, 1);
});

/* ------------------------------------------------------------------------ view */

test("a review is worded from what the reviewer shared, with its origin", () => {
  const view = buildProductReviewView(
    row({
      source: "FACEBOOK",
      fit: "SMALL",
      sizeLabel: "M",
      colorLabel: "Hồng phấn",
      heightCm: 160,
      weightKg: 52,
      imageUrls: [photo(1)],
    }),
  );
  assert.equal(view.sourceLabel, "Bình luận trên Facebook");
  assert.equal(view.fitLabel, "Hơi chật");
  assert.equal(view.detailLine, "Size M · Hồng phấn · cao 1m60, 52kg");
  assert.equal(view.dateLabel, "05/11/2026");
  assert.equal(view.images[0]?.alt, "Ảnh trong đánh giá của Lan A.");
});

test("Đã mua hàng is claimed only for a review linked to an order", () => {
  assert.equal(buildProductReviewView(row({ orderPublicCode: null })).verifiedPurchase, false);
  assert.equal(buildProductReviewView(row({ orderPublicCode: "LN24-0183" })).verifiedPurchase, true);
});

test("a height under one metre ten keeps its leading zero", () => {
  assert.equal(buildProductReviewView(row({ heightCm: 105 })).detailLine, "cao 1m05");
  assert.equal(buildProductReviewView(row()).detailLine, null);
});

test("a product with no published review renders no section at all", () => {
  assert.equal(buildProductReviewSection([]), null);
});

test("below the minimum there are reviews but no average", () => {
  const rows = Array.from({ length: MIN_REVIEWS_FOR_SUMMARY - 1 }, (_, index) => row({ id: `r${index}` }));
  const section = buildProductReviewSection(rows)!;
  assert.equal(section.count, MIN_REVIEWS_FOR_SUMMARY - 1);
  assert.equal(section.summary, null);
  assert.equal(section.items.length, MIN_REVIEWS_FOR_SUMMARY - 1);

  const enough = buildProductReviewSection([...rows, row({ id: "last" })])!;
  assert.equal(enough.summary?.count, MIN_REVIEWS_FOR_SUMMARY);
});

test("the page lists a bounded number of reviews, the summary counts them all", () => {
  const rows = Array.from({ length: PRODUCT_REVIEW_PAGE_LIMIT + 5 }, (_, index) =>
    row({ id: `r${index}`, rating: 5 }),
  );
  const section = buildProductReviewSection(rows)!;
  assert.equal(section.items.length, PRODUCT_REVIEW_PAGE_LIMIT);
  assert.equal(section.count, PRODUCT_REVIEW_PAGE_LIMIT + 5);
  assert.equal(section.summary?.count, PRODUCT_REVIEW_PAGE_LIMIT + 5);
});

test("the product's own photographs come newest review first and are capped", () => {
  const rows = [
    row({ id: "new", imageUrls: [photo(1), photo(2)] }),
    row({ id: "none" }),
    row({ id: "old", imageUrls: Array.from({ length: 6 }, (_, index) => photo(10 + index)) }),
    row({ id: "older", imageUrls: Array.from({ length: 6 }, (_, index) => photo(20 + index)) }),
  ];
  const section = buildProductReviewSection(rows)!;
  assert.equal(section.photos[0]?.src, photo(1));
  assert.equal(section.photos[2]?.src, photo(10));
  assert.equal(section.photos.length, PRODUCT_REVIEW_PHOTO_LIMIT);
  assert.equal(section.photoCount, 14, "the count covers every photograph, not only those shown");
});
