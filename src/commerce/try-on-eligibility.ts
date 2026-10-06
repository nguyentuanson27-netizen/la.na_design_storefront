import { categoryByKey } from "./category-taxonomy.ts";
import type { StorefrontProductMedia, TrustedProductImage } from "./product-media.ts";

/**
 * Which products may offer virtual try-on (spec §4).
 *
 * This module only *composes* the existing authorities: category identity comes from
 * `category-taxonomy.ts`, the first trusted image from `product-media.ts`. It does not parse media
 * URLs and does not look at product names, SKUs or collections.
 */

/** Apparel worn on the body. `phuKien` is deliberately absent. */
export const TRY_ON_ELIGIBLE_TOP_LEVEL_CATEGORY_KEYS: readonly string[] = Object.freeze([
  "aoDai",
  "setDo",
  "vayDam",
]);

/** The try-on providers accept JPEG and PNG only; WebP is not converted for MVP. */
const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set([".jpg", ".jpeg", ".png"]);

export type TryOnIneligibleReason =
  | "CATEGORY_NOT_ELIGIBLE"
  | "NO_TRUSTED_IMAGE"
  | "UNSUPPORTED_IMAGE_FORMAT";

export type TryOnEligibility =
  | Readonly<{ eligible: true; productImage: TrustedProductImage }>
  | Readonly<{ eligible: false; reason: TryOnIneligibleReason }>;

function hasEligibleCategories(categoryKeys: readonly string[]): boolean {
  if (categoryKeys.length === 0) return false;
  // Every key must be a known category inside an eligible tree. A key from another tree, or one the
  // taxonomy no longer knows, fails the product closed rather than being ignored.
  return categoryKeys.every((key) => {
    const node = categoryByKey(key);
    return node !== null && TRY_ON_ELIGIBLE_TOP_LEVEL_CATEGORY_KEYS.includes(node.topLevelKey);
  });
}

/**
 * The media authority has already restricted `url` to a lowercase reviewed extension, so reading it
 * back is a format check on trusted input, not a second parser.
 */
function hasSupportedImageExtension(url: string): boolean {
  const pathname = new URL(url).pathname;
  const dot = pathname.lastIndexOf(".");
  return dot >= 0 && SUPPORTED_EXTENSIONS.has(pathname.slice(dot));
}

export function resolveTryOnEligibility({
  categoryKeys,
  media,
}: Readonly<{
  categoryKeys: readonly string[];
  media: StorefrontProductMedia;
}>): TryOnEligibility {
  if (!hasEligibleCategories(categoryKeys)) {
    return { eligible: false, reason: "CATEGORY_NOT_ELIGIBLE" };
  }
  // The exact first trusted image. Never the second one when the first is unusable.
  if (media.primary === null) return { eligible: false, reason: "NO_TRUSTED_IMAGE" };
  if (!hasSupportedImageExtension(media.primary.url)) {
    return { eligible: false, reason: "UNSUPPORTED_IMAGE_FORMAT" };
  }
  return { eligible: true, productImage: media.primary };
}
