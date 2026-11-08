import {
  MIN_REVIEW_PHOTOS_FOR_STRIP,
  type ProductReviewSection,
} from "../../commerce/product-review.ts";
import { PRODUCT_REVIEW_PHOTOS_ANCHOR } from "./product-review-model.ts";

/**
 * The strip of customer photographs under the price, and what it is allowed to say.
 *
 * Three sources, strongest first, and the words always follow the source -- the strip must never
 * say "mẫu này" about photographs that are not of this product:
 *
 * 1. `review`  -- photographs inside this product's own published reviews;
 * 2. `product` -- this product's own tagged feedback photographs (`ANH-FEEDBACK-<mã>`);
 * 3. `brand`   -- the shop's shared feedback gallery, worded as the brand's, with a different
 *                 selection of thumbnails per product so the same four photographs do not sit under
 *                 every price.
 *
 * Each needs `MIN_REVIEW_PHOTOS_FOR_STRIP` photographs, or the strip looks thin and is left out.
 */

/** The in-page target of the product's own tagged / the brand's feedback rail. */
export const PRODUCT_FEEDBACK_ANCHOR = "pdp-feedback";

export const STRIP_THUMBNAIL_COUNT = 4;

export type CustomerPhotoStripKind = "review" | "product" | "brand";

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

/** FNV-1a, 32 bit: stable across renders and processes, which a per-request random choice is not. */
export function stableHash(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * `count` photographs starting at a position the seed picks, wrapping round the end. With no more
 * photographs than fit, they are all shown in order.
 */
export function rotatePhotos(
  sources: readonly string[],
  seed: string,
  count: number = STRIP_THUMBNAIL_COUNT,
): readonly string[] {
  if (sources.length <= count) return Object.freeze([...sources]);
  const start = stableHash(seed) % sources.length;
  return Object.freeze(Array.from({ length: count }, (_, offset) => sources[(start + offset) % sources.length]!));
}

export function resolveCustomerPhotoStrip({
  reviews,
  feedback,
  slug,
  brandName,
}: Readonly<{
  reviews: ProductReviewSection | null;
  /** The feedback the page actually renders (already `null` when review photographs replace it). */
  feedback: FeedbackForStrip | null;
  slug: string;
  brandName: string;
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

  if (feedback === null || feedback.images.length < MIN_REVIEW_PHOTOS_FOR_STRIP) return null;
  const sources = feedback.images.map((image) => image.src);

  if (feedback.scope === "product") {
    return Object.freeze({
      kind: "product",
      href: `#${PRODUCT_FEEDBACK_ANCHOR}`,
      title: "Ảnh khách diện mẫu này",
      subtitle: `${sources.length} ảnh thật · bấm để xem`,
      photos: Object.freeze(sources.slice(0, STRIP_THUMBNAIL_COUNT)),
    });
  }

  return Object.freeze({
    kind: "brand",
    href: `#${PRODUCT_FEEDBACK_ANCHOR}`,
    title: `Khách hàng ${brandName}`,
    subtitle: `Xem ảnh khách mặc thật · ${sources.length} ảnh`,
    photos: rotatePhotos(sources, slug),
  });
}

/** The link under the purchase buttons repeats a product/brand strip, so it steps aside for one. */
export function stripReplacesFeedbackLink(strip: CustomerPhotoStrip | null): boolean {
  return strip !== null && strip.kind !== "review";
}
