/**
 * The desktop PDP media stage's arithmetic, as pure functions.
 *
 * Refinement spec §1/§2 describe the stage in terms the gallery component cannot assert about
 * itself: image 1 stands alone, the rest pair up, the ends do not loop, and the canonical first
 * visible surface survives a `?variant=` deep link. Those are decisions, not markup, so they live
 * here where the domain suite can pin them and the component is left rendering.
 *
 * Nothing here knows about stock, price or purchasability. The variant-to-image mapping is the
 * server-resolved one the deep link already uses; this module only reads it.
 */

/** Indices into the trusted gallery, in source order, for one slide. */
export type ProductGallerySlide = readonly number[];

/**
 * Slide 1 is image 1 alone at full width; everything after it pairs `2+3`, `4+5`, `6+7`, and a
 * final unpaired image keeps the full width rather than being padded with a blank half.
 */
export function buildDesktopProductGallerySlides(imageCount: number): ProductGallerySlide[] {
  if (!Number.isSafeInteger(imageCount) || imageCount <= 0) return [];

  const slides: ProductGallerySlide[] = [[0]];
  for (let index = 1; index < imageCount; index += 2) {
    slides.push(index + 1 < imageCount ? [index, index + 1] : [index]);
  }
  return slides;
}

/** Which slide holds an image, or slide 1 for an index this gallery does not contain. */
export function gallerySlideIndexForImage(
  slides: readonly ProductGallerySlide[],
  imageIndex: number,
): number {
  const found = slides.findIndex((slide) => slide.includes(imageIndex));
  return found === -1 ? 0 : found;
}

/**
 * One step in either direction, clamped at both ends.
 *
 * Clamping rather than wrapping is the contract: §2 says the first slide cannot move backward and
 * the last does not loop to the beginning.
 */
export function stepGallerySlide(current: number, delta: number, slideCount: number): number {
  if (slideCount <= 0) return 0;
  return Math.min(Math.max(current + delta, 0), slideCount - 1);
}

export type GallerySlideSelectionInput = Readonly<{
  slides: readonly ProductGallerySlide[];
  /** Where the shopper is now -- their own navigation, or the last variant sync. */
  currentSlide: number;
  /** The variant the current slide was last synced to; the deep-linked one counts as synced. */
  syncedVariantId: string | null;
  selectedVariantId: string | null;
  galleryIndexByVariantId: Readonly<Record<string, number>>;
}>;

/**
 * The selection-to-gallery seam, with the priority §2 settles.
 *
 * The gallery mounts on slide 0 with the deep-linked variant already recorded as synced, so the
 * canonical first surface is what a `?variant=` link opens on even when that variant's photograph
 * is four slides away. Only a *change* of selection afterwards moves the stage, which is also what
 * leaves a shopper's own drag/click where they left it: an unchanged selection resolves to the
 * slide they are already on.
 */
export function resolveGallerySlideForSelection({
  slides,
  currentSlide,
  syncedVariantId,
  selectedVariantId,
  galleryIndexByVariantId,
}: GallerySlideSelectionInput): { slide: number; syncedVariantId: string | null } {
  if (selectedVariantId === syncedVariantId) {
    return { slide: currentSlide, syncedVariantId };
  }

  const mappedImage = selectedVariantId === null ? undefined : galleryIndexByVariantId[selectedVariantId];
  const imageCount = slides.reduce((total, slide) => total + slide.length, 0);
  const isAddressable =
    mappedImage !== undefined && Number.isSafeInteger(mappedImage) && mappedImage >= 0 && mappedImage < imageCount;

  return {
    slide: isAddressable ? gallerySlideIndexForImage(slides, mappedImage) : currentSlide,
    syncedVariantId: selectedVariantId,
  };
}


export type GalleryImageSelectionInput = Readonly<{
  imageCount: number;
  currentImage: number;
  syncedVariantId: string | null;
  selectedVariantId: string | null;
  galleryIndexByVariantId: Readonly<Record<string, number>>;
}>;

/**
 * Below-lg equivalent of resolveGallerySlideForSelection: preserve the trusted source order,
 * start on image 1 even for a deep link, and only move when the selected variant itself changes.
 */
export function resolveGalleryImageForSelection({
  imageCount,
  currentImage,
  syncedVariantId,
  selectedVariantId,
  galleryIndexByVariantId,
}: GalleryImageSelectionInput): { image: number; syncedVariantId: string | null } {
  if (selectedVariantId === syncedVariantId) {
    return { image: currentImage, syncedVariantId };
  }

  const mappedImage =
    selectedVariantId === null ? undefined : galleryIndexByVariantId[selectedVariantId];
  const isAddressable =
    mappedImage !== undefined
    && Number.isSafeInteger(mappedImage)
    && mappedImage >= 0
    && mappedImage < imageCount;

  return {
    image: isAddressable ? mappedImage : currentImage,
    syncedVariantId: selectedVariantId,
  };
}
