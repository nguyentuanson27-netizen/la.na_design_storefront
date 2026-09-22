"use client";

import Image from "next/image";
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import type { StorefrontProductMedia } from "@/commerce/product-media";
import {
  buildDesktopProductGallerySlides,
  resolveGallerySlideForSelection,
  stepGallerySlide,
} from "@/components/brand/product-gallery-layout";

/**
 * The PDP's first surface, for every viewport -- and, from `lg` up, the whole gallery.
 *
 * Refinement spec §1/§2. Below `lg` this renders exactly what the page rendered before: the
 * canonical first image, full-bleed and cover-cropped, with the transparent header over it. The
 * later slides are still in the markup but `display: none`, so their lazy images are never
 * fetched and the mobile composition -- which a separate mobile spec owns -- is untouched.
 *
 * From `lg` up the same markup becomes a near-viewport-height media stage: `object-contain` over
 * cream so the whole garment is visible, image 1 alone, then `2+3`, `4+5`, and a lone final image
 * at full width.
 *
 * Navigation is deliberate only. Half-width previous/next buttons give the pointer its click
 * targets and keyboard users the equivalent path, and a horizontal pointer drag moves one slide.
 * There is no wheel handler here and there never should be: `touch-action: pan-y` leaves vertical
 * gestures to the document, which is what keeps a scroll down the page a scroll down the page.
 */

/** How far a pointer must travel horizontally before it counts as a drag rather than a click. */
const DRAG_THRESHOLD_PX = 48;

type BrandProductMediaStageProps = Readonly<{
  media: StorefrontProductMedia;
  productName: string;
  /** The panel's current selection, so a post-load variant change can move the stage. */
  selectedVariantId: string | null;
  /** The server-resolved variant-to-gallery mapping the `?variant=` deep link already uses. */
  galleryIndexByVariantId: Readonly<Record<string, number>>;
}>;

export function BrandProductMediaStage({
  media,
  productName,
  selectedVariantId,
  galleryIndexByVariantId,
}: BrandProductMediaStageProps) {
  const images = media.gallery;
  const slides = buildDesktopProductGallerySlides(images.length);

  const [slide, setSlide] = useState(0);
  /*
   * The variant the stage is currently showing the media for.
   *
   * Seeded with whatever the deep link preselected, which is what makes slide 1 the first visible
   * surface even for a `?variant=` whose photograph is later in the gallery: the variant arrives
   * already accounted for, so there is no change to sync.
   */
  const [syncedVariantId, setSyncedVariantId] = useState(selectedVariantId);

  if (selectedVariantId !== syncedVariantId) {
    const resolved = resolveGallerySlideForSelection({
      slides,
      currentSlide: slide,
      syncedVariantId,
      selectedVariantId,
      galleryIndexByVariantId,
    });
    setSyncedVariantId(resolved.syncedVariantId);
    setSlide(resolved.slide);
  }

  const dragOriginRef = useRef<{ x: number; y: number } | null>(null);
  const draggedRef = useRef(false);

  if (images.length === 0) return null;

  function go(delta: number) {
    setSlide((current) => stepGallerySlide(current, delta, slides.length));
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.isPrimary) return;
    dragOriginRef.current = { x: event.clientX, y: event.clientY };
    draggedRef.current = false;
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const origin = dragOriginRef.current;
    dragOriginRef.current = null;
    if (!origin) return;

    const horizontal = event.clientX - origin.x;
    // A gesture that travelled further down the page than across it was a scroll, not a swipe.
    if (Math.abs(horizontal) < DRAG_THRESHOLD_PX) return;
    if (Math.abs(horizontal) <= Math.abs(event.clientY - origin.y)) return;

    draggedRef.current = true;
    go(horizontal < 0 ? 1 : -1);
  }

  function handlePointerCancel() {
    dragOriginRef.current = null;
  }

  /** A drag that ends over a half also fires its click; the navigation already happened. */
  function navigateFromClick(delta: number) {
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    go(delta);
  }

  const hasMultipleSlides = slides.length > 1;

  return (
    <section
      className="product-page-hero pdp-stage"
      aria-label={`Ảnh chính của ${productName}`}
      data-header-overlay-hero=""
    >
      <div className="pdp-stage__track">
        {slides.map((slideImages, slideIndex) => (
          <div
            key={slideImages.join("-")}
            className="pdp-stage__slide"
            data-active={slideIndex === slide ? "true" : "false"}
          >
            {slideImages.map((imageIndex) => {
              const image = images[imageIndex]!;
              return (
                <div key={image.url} className="pdp-stage__cell">
                  <Image
                    src={image.url}
                    /*
                      The canonical first image keeps the product's plain name, which is the alt
                      the full-bleed first surface has always carried; the rest keep the alt the
                      media resolver gave them. Alt text is media authority, not the stage's to
                      restate.
                    */
                    alt={imageIndex === 0 ? productName : image.alt || `${productName} - Ảnh ${imageIndex + 1}`}
                    fill
                    preload={imageIndex === 0}
                    sizes={slideImages.length > 1 ? "(min-width: 1024px) 50vw, 100vw" : "100vw"}
                    className="object-cover lg:object-contain"
                  />
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {hasMultipleSlides ? (
        <>
          <div
            className="pdp-stage__nav"
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
          >
            <button
              type="button"
              className="pdp-stage__half"
              disabled={slide === 0}
              onClick={() => navigateFromClick(-1)}
            >
              <span className="sr-only">Ảnh trước</span>
            </button>
            <button
              type="button"
              className="pdp-stage__half"
              disabled={slide === slides.length - 1}
              onClick={() => navigateFromClick(1)}
            >
              <span className="sr-only">Ảnh tiếp theo</span>
            </button>
          </div>

          <p className="pdp-stage__counter" role="status" aria-live="polite">
            {`Trang ảnh ${slide + 1} / ${slides.length}`}
          </p>
        </>
      ) : null}
    </section>
  );
}
