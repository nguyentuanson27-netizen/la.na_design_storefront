import type { StorefrontProductMedia, TrustedProductImage } from "../../commerce/product-media.ts";

/**
 * Everything the product gallery needs to render, decided here so a brand redrawing it never has
 * to reimplement which image is on screen.
 *
 * The rules are the ones `ProductGallery` carried inline: no photography falls back rather than
 * rendering a blank frame, one photo gets no carousel controls, an index from outside the gallery
 * is clamped rather than trusted, and alt text falls back to the product name and position.
 *
 * It also carries the seam the purchase panel and the gallery share. The panel knows which variant
 * is selected; `galleryIndexByVariantId` -- the same server-resolved mapping `?variant=` deep links
 * use -- says which photo that is. Passing both makes the frame follow the shopper's colour choice.
 * A caller that passes neither gets exactly today's behaviour, which is why the product route did
 * not have to change for this.
 */

export type GalleryManualSelection = Readonly<{
  /**
   * The variant that was selected when the shopper clicked a thumbnail, or `null` on a gallery
   * with no variant awareness. A pick made for one colour must not pin the frame once the shopper
   * moves to another.
   */
  variantId: string | null;
  index: number;
}>;

export type GalleryThumbnail = Readonly<{
  index: number;
  url: string;
  alt: string;
  label: string;
  isSelected: boolean;
}>;

export type GalleryModel = Readonly<{
  /** `empty` has no photography, `single` needs no controls, `carousel` gets thumbnails. */
  mode: "empty" | "single" | "carousel";
  images: readonly TrustedProductImage[];
  activeIndex: number;
  /** Alt text already resolved, so a brand renders it rather than deciding a fallback. */
  activeImage: TrustedProductImage | null;
  preloadsActiveImage: boolean;
  thumbnails: readonly GalleryThumbnail[];
  regionLabel: string;
  thumbnailsLabel: string;
}>;

export type GalleryModelInput = Readonly<{
  media: StorefrontProductMedia;
  productName: string;
  /** Which image to open on, resolved on the server from a `?variant=` deep link. */
  initialIndex?: number;
  /** The purchase panel's current selection, where the gallery is wired to one. */
  selectedVariantId?: string | null;
  /** Product-level variant-to-gallery mapping, where the caller has one. */
  galleryIndexByVariantId?: Readonly<Record<string, number>>;
  manualSelection?: GalleryManualSelection | null;
}>;

function clamp(index: number | undefined, imageCount: number): number | null {
  if (index === undefined) return null;
  return Number.isSafeInteger(index) && index >= 0 && index < imageCount ? index : null;
}

export function resolveGalleryModel({
  media,
  productName,
  initialIndex = 0,
  selectedVariantId = null,
  galleryIndexByVariantId,
  manualSelection = null,
}: GalleryModelInput): GalleryModel {
  const images = media.gallery;
  const regionLabel = `Bộ sưu tập hình ảnh ${productName}`;
  const thumbnailsLabel = `Danh sách ảnh chi tiết của ${productName}`;

  if (images.length === 0) {
    return Object.freeze({
      mode: "empty" as const,
      images: Object.freeze([]),
      activeIndex: 0,
      activeImage: null,
      preloadsActiveImage: false,
      thumbnails: Object.freeze([]),
      regionLabel,
      thumbnailsLabel,
    });
  }

  const variantIndex =
    selectedVariantId === null ? null : clamp(galleryIndexByVariantId?.[selectedVariantId], images.length);

  // The shopper's own pick wins, but only for the variant it was made on: once the selection moves,
  // a stale pick would leave the frame showing the previous colour.
  const manualIndex =
    manualSelection !== null && manualSelection.variantId === selectedVariantId
      ? clamp(manualSelection.index, images.length)
      : null;

  const activeIndex = manualIndex ?? variantIndex ?? clamp(initialIndex, images.length) ?? 0;
  const rawActive = images[activeIndex]!;
  const single = images.length === 1;

  return Object.freeze({
    mode: single ? ("single" as const) : ("carousel" as const),
    images,
    activeIndex,
    activeImage: Object.freeze({
      url: rawActive.url,
      alt: rawActive.alt || (single ? productName : `${productName} - Ảnh ${activeIndex + 1}`),
    }),
    preloadsActiveImage: single || activeIndex === 0,
    thumbnails: Object.freeze(
      single
        ? []
        : images.map((image, index) =>
            Object.freeze({
              index,
              url: image.url,
              alt: image.alt || `Thumbnail ${index + 1}`,
              label: `Xem ảnh ${index + 1} của ${productName}`,
              isSelected: index === activeIndex,
            }),
          ),
    ),
    regionLabel,
    thumbnailsLabel,
  });
}
