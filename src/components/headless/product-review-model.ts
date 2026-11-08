import {
  MIN_REVIEWS_FOR_SUMMARY,
  MIN_REVIEW_PHOTOS_FOR_STRIP,
  formatReviewAverage,
  type ProductReviewSection,
  type ProductReviewView,
} from "../../commerce/product-review.ts";

/**
 * What the product page's review UI decides from a review section, kept out of the markup so a
 * brand can redraw the stars and cards without re-deciding any of it.
 */

export { formatReviewAverage };

/** The id the rating link and the photo strip scroll to. */
export const PRODUCT_REVIEWS_ANCHOR = "pdp-reviews";
/** The id of the product's own review-photo rail. */
export const PRODUCT_REVIEW_PHOTOS_ANCHOR = "pdp-review-photos";

export type ReviewFilterKey = "all" | "photos" | "five" | "four" | "three-or-less";

export type ReviewFilter = Readonly<{
  key: ReviewFilterKey;
  label: string;
  count: number;
}>;

export function matchesReviewFilter(review: ProductReviewView, key: ReviewFilterKey): boolean {
  switch (key) {
    case "all":
      return true;
    case "photos":
      return review.images.length > 0;
    case "five":
      return review.rating === 5;
    case "four":
      return review.rating === 4;
    case "three-or-less":
      return review.rating <= 3;
  }
}

export function filterReviews(
  reviews: readonly ProductReviewView[],
  key: ReviewFilterKey,
): readonly ProductReviewView[] {
  return key === "all" ? reviews : reviews.filter((review) => matchesReviewFilter(review, key));
}

/**
 * The filter chips. A filter that would show nothing is not offered, and below the summary's own
 * minimum there are too few reviews for any filter to help.
 */
export function buildReviewFilters(reviews: readonly ProductReviewView[]): readonly ReviewFilter[] {
  if (reviews.length < MIN_REVIEWS_FOR_SUMMARY) return Object.freeze([]);
  const definitions: readonly (readonly [ReviewFilterKey, string])[] = [
    ["all", "Tất cả"],
    ["photos", "Có ảnh"],
    ["five", "5 sao"],
    ["four", "4 sao"],
    ["three-or-less", "3 sao trở xuống"],
  ];
  return Object.freeze(
    definitions
      .map(([key, label]) => ({ key, label, count: filterReviews(reviews, key).length }))
      .filter((filter) => filter.key === "all" || filter.count > 0),
  );
}

/** Width of the filled part of a five-star row, from the average, to one star's resolution. */
export function starFillPercent(rating: number): number {
  const clamped = Math.min(5, Math.max(0, rating));
  return Math.round((clamped / 5) * 1000) / 10;
}

/** Share of one star level in the histogram, 0..100. */
export function distributionPercent(count: number, total: number): number {
  return total <= 0 ? 0 : Math.round((count / total) * 100);
}

/** The words next to the stars under the product name. */
export function ratingLinkText(section: ProductReviewSection): string {
  return `${section.count} đánh giá`;
}

/** Whether the strip under the price has enough of this product's own photographs to be shown. */
export function showsReviewPhotoStrip(section: ProductReviewSection | null): boolean {
  return section !== null && section.photoCount >= MIN_REVIEW_PHOTOS_FOR_STRIP;
}

/** Share of the fit bar, as rounded whole percents that always add up to 100. */
export function fitShares(fit: NonNullable<NonNullable<ProductReviewSection["summary"]>["fit"]>) {
  const small = Math.round((fit.small / fit.count) * 100);
  const large = Math.round((fit.large / fit.count) * 100);
  return Object.freeze({ small, large, trueToSize: Math.max(0, 100 - small - large) });
}
