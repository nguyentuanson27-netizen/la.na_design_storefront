import {
  MIN_REVIEW_PHOTOS_FOR_STRIP,
  type ProductReviewSection,
} from "../../commerce/product-review.ts";
import { PRODUCT_REVIEW_PHOTOS_ANCHOR } from "./product-review-model.ts";

/**
 * The strip of customer photographs under the price, and what it is allowed to say.
 *
 * Two sources, strongest first, both about this product itself:
 *
 * 1. `review`  -- photographs inside this product's own published reviews;
 * 2. `product` -- this product's own tagged feedback photographs (`ANH-FEEDBACK-<mã>`).
 *
 * Each needs `MIN_REVIEW_PHOTOS_FOR_STRIP` photographs, or the strip looks thin and is left out.
 * A product with neither gets no strip at all (owner request 2026-11-09): the shop's shared
 * "Khách hàng La.na Design" gallery is not about this product, so it lives only in its rail at the
 * bottom of the page, not under the price.
 */

/** The in-page target of the product's own tagged feedback rail. */
export const PRODUCT_FEEDBACK_ANCHOR = "pdp-feedback";

export const STRIP_THUMBNAIL_COUNT = 4;

export type CustomerPhotoStripKind = "review" | "product";

export type CustomerPhotoStrip = Readonly<{
  kind: CustomerPhotoStripKind;
  /** The rail the strip scrolls to. */
  href: string;
  title: string;
  subtitle: string;
  /** Up to `STRIP_THUMBNAIL_COUNT` photograph sources. */
  photos: readonly string[];
}>;

type FeedbackForStrip = Readonly<{
  scope: "product" | "brand";
  images: readonly Readonly<{ src: string }>[];
}>;

export function resolveCustomerPhotoStrip({
  reviews,
  feedback,
}: Readonly<{
  reviews: ProductReviewSection | null;
  /** The feedback the page actually renders (already `null` when review photographs replace it). */
  feedback: FeedbackForStrip | null;
}>): CustomerPhotoStrip | null {
  if (reviews !== null && reviews.photoCount >= MIN_REVIEW_PHOTOS_FOR_STRIP) {
    return Object.freeze({
      kind: "review",
      href: `#${PRODUCT_REVIEW_PHOTOS_ANCHOR}`,
      title: "Ảnh khách diện mẫu này",
      subtitle: `${reviews.photoCount} ảnh thật · bấm để xem`,
      photos: Object.freeze(reviews.photos.slice(0, STRIP_THUMBNAIL_COUNT).map((photo) => photo.src)),
    });
  }

  // The shared brand gallery never becomes a strip: it is not this product's own.
  if (feedback === null || feedback.scope !== "product" || feedback.images.length < MIN_REVIEW_PHOTOS_FOR_STRIP) {
    return null;
  }
  const sources = feedback.images.map((image) => image.src);

  return Object.freeze({
    kind: "product",
    href: `#${PRODUCT_FEEDBACK_ANCHOR}`,
    title: "Ảnh khách diện mẫu này",
    subtitle: `${sources.length} ảnh thật · bấm để xem`,
    photos: Object.freeze(sources.slice(0, STRIP_THUMBNAIL_COUNT)),
  });
}

/** The link under the purchase buttons repeats a product strip, so it steps aside for one. */
export function stripReplacesFeedbackLink(strip: CustomerPhotoStrip | null): boolean {
  return strip !== null && strip.kind !== "review";
}
