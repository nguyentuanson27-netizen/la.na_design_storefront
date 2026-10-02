const TRUSTED_IMAGE_HOSTNAME = "content.pancake.vn";
const MAX_IMAGE_URL_LENGTH = 4096;

const ALLOWED_IMAGE_EXTENSIONS = new Set([".jpg", ".png", ".webp"]);
/**
 * Editorial video, held to exactly the image rules with one extension set swapped.
 *
 * The host is the same reviewed Pancake CDN: this adds a media type, not a place media may come
 * from. Anything else -- another host, a custom port, credentials, a path outside the reviewed
 * shape -- is refused here for the same reasons it is for an image.
 */
const ALLOWED_VIDEO_EXTENSIONS = new Set([".mp4"]);

export type TrustedProductImage = {
  url: string;
  alt: string;
};

export type StorefrontProductMedia = {
  primary: TrustedProductImage | null;
  gallery: readonly TrustedProductImage[];
};

/**
 * Validates and normalizes a candidate product image URL against the
 * strict reviewed HTTPS Pancake CDN media trust contract.
 *
 * Rules:
 * - Scheme must be strictly HTTPS
 * - Host must exactly match `content.pancake.vn` (no wildcards or IP addresses)
 * - Port must be default HTTPS port (no custom ports)
 * - Authority must not contain user credentials
 * - Path must not contain path traversal (`..`)
 * - Path must match exact reviewed shape `/:segment/:id/:id/:id/:file.(jpg|png|webp)`
 * - Length must be bounded (<= 4096 chars)
 */
export function parseTrustedProductImageUrl(rawUrl: unknown): string | null {
  return parseTrustedMediaUrl(rawUrl, ALLOWED_IMAGE_EXTENSIONS);
}

function parseTrustedMediaUrl(
  rawUrl: unknown,
  allowedExtensions: ReadonlySet<string>,
): string | null {
  if (typeof rawUrl !== "string") {
    return null;
  }

  const trimmed = rawUrl.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_IMAGE_URL_LENGTH) {
    return null;
  }

  // Reject path traversal in raw input before WHATWG URL normalization
  if (
    trimmed.includes("/..") ||
    trimmed.includes("../") ||
    trimmed.toLowerCase().includes("%2e%2e")
  ) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") {
    return null;
  }

  if (parsed.hostname.toLowerCase() !== TRUSTED_IMAGE_HOSTNAME) {
    return null;
  }

  // Reject custom ports, explicit default ports, or credentials in authority
  const authority = trimmed.slice(8).split("/")[0] ?? "";
  if (
    authority !== TRUSTED_IMAGE_HOSTNAME ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    return null;
  }

  // Enforce reviewed Pancake CDN path shape: /:segment/:id/:id/:id/:file.(jpg|png|mp4)
  const pathname = parsed.pathname;
  if (!isValidReviewedMediaPath(pathname, allowedExtensions)) {
    return null;
  }

  return parsed.toString();
}

/**
 * The same contract as {@link parseTrustedProductImageUrl}, for editorial video.
 *
 * Shares every rule -- HTTPS, the one reviewed host, no port, no credentials, no traversal, the
 * reviewed path shape -- and differs only in which extension it accepts. Written as a separate
 * entry point rather than by widening the image parser, so nothing that asks for an image can be
 * handed an `.mp4`.
 */
export function parseTrustedProductVideoUrl(rawUrl: unknown): string | null {
  return parseTrustedMediaUrl(rawUrl, ALLOWED_VIDEO_EXTENSIONS);
}

const PANCAKE_MEDIA_PATH_REGEX =
  /^\/[a-zA-Z0-9_-]+\/\d+\/\d+\/\d+\/[a-zA-Z0-9_.-]+\.(jpg|png|webp|mp4)$/;

function isValidReviewedMediaPath(
  pathname: string,
  allowedExtensions: ReadonlySet<string>,
): boolean {
  if (!PANCAKE_MEDIA_PATH_REGEX.test(pathname) || pathname.includes("..")) {
    return false;
  }

  const parts = pathname.split("/");
  // Expected structure: ["", segment, id1, id2, id3, filename]
  if (parts.length !== 6) {
    return false;
  }

  const filename = parts[5]!;
  const lastDotIndex = filename.lastIndexOf(".");
  if (lastDotIndex <= 0) {
    return false;
  }

  const extension = filename.slice(lastDotIndex);
  return allowedExtensions.has(extension);
}

export const MAX_MEDIA_CANDIDATES_SCANNED = 100;
export const MAX_STOREFRONT_GALLERY_IMAGES = 12;

/**
 * Resolves trusted primary photography and gallery media from product-level
 * and variant-level image URLs deterministically with deduplication.
 *
 * Constraints & Bounds:
 * - Scans at most MAX_MEDIA_CANDIDATES_SCANNED (100) raw candidate image URLs
 *   to bound CPU/memory consumption against untrusted external payloads.
 * - Caps returned gallery items at MAX_STOREFRONT_GALLERY_IMAGES (12) unique
 *   trusted images to optimize DOM footprint and downstream rendering.
 *
 * Order of priority:
 * 1. Product primaryImageUrl (if valid and trusted)
 * 2. Variant 0 image URLs (in order)
 * 3. Variant 1 image URLs (in order)
 * ...
 */
export function resolveStorefrontProductMedia({
  productName,
  primaryImageUrl,
  variantImageUrls,
}: {
  productName: string;
  primaryImageUrl?: string | null;
  variantImageUrls?: readonly (readonly (string | null | undefined)[])[];
}): StorefrontProductMedia {
  const cleanProductName = productName.trim() || "Product";
  const uniqueUrls: string[] = [];
  const seenUrls = new Set<string>();
  let scannedCount = 0;

  function tryAdd(candidate: unknown) {
    if (
      scannedCount >= MAX_MEDIA_CANDIDATES_SCANNED ||
      uniqueUrls.length >= MAX_STOREFRONT_GALLERY_IMAGES
    ) {
      return;
    }

    scannedCount++;
    const trusted = parseTrustedProductImageUrl(candidate);
    if (trusted !== null && !seenUrls.has(trusted)) {
      seenUrls.add(trusted);
      uniqueUrls.push(trusted);
    }
  }

  if (primaryImageUrl) {
    tryAdd(primaryImageUrl);
  }

  if (variantImageUrls) {
    for (const list of variantImageUrls) {
      if (
        uniqueUrls.length >= MAX_STOREFRONT_GALLERY_IMAGES ||
        scannedCount >= MAX_MEDIA_CANDIDATES_SCANNED
      ) {
        break;
      }

      if (Array.isArray(list)) {
        for (const item of list) {
          if (
            uniqueUrls.length >= MAX_STOREFRONT_GALLERY_IMAGES ||
            scannedCount >= MAX_MEDIA_CANDIDATES_SCANNED
          ) {
            break;
          }
          tryAdd(item);
        }
      }
    }
  }

  if (uniqueUrls.length === 0) {
    return {
      primary: null,
      gallery: [],
    };
  }

  const isSingle = uniqueUrls.length === 1;
  const gallery: TrustedProductImage[] = uniqueUrls.map((url, index) => ({
    url,
    alt: isSingle ? cleanProductName : `${cleanProductName} - Ảnh ${index + 1}`,
  }));

  const primary: TrustedProductImage = {
    url: uniqueUrls[0]!,
    alt: cleanProductName,
  };

  return {
    primary,
    gallery,
  };
}

/**
 * Which gallery slot a given variant's own photography occupies.
 *
 * The gallery is one deduped list built from the product's primary image followed by each variant's
 * images, so a variant does not carry an index of its own — it has to be located by URL after the
 * list is built. A variant with no trusted image of its own, or whose image was deduped away or
 * dropped past the gallery cap, is simply absent from the map and leaves the gallery on its default.
 */
export function resolveVariantGalleryIndexes({
  gallery,
  variants,
}: Readonly<{
  gallery: readonly TrustedProductImage[];
  variants: readonly Readonly<{ id: string; imageUrls: readonly unknown[] }>[];
}>): Map<string, number> {
  const indexByUrl = new Map<string, number>();
  gallery.forEach((image, index) => {
    if (!indexByUrl.has(image.url)) indexByUrl.set(image.url, index);
  });

  const indexByVariantId = new Map<string, number>();
  for (const variant of variants) {
    for (const candidate of variant.imageUrls) {
      const trusted = parseTrustedProductImageUrl(candidate);
      if (trusted === null) continue;
      const index = indexByUrl.get(trusted);
      if (index === undefined) continue;
      indexByVariantId.set(variant.id, index);
      break;
    }
  }

  return indexByVariantId;
}
