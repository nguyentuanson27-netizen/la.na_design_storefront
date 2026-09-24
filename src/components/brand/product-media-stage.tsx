"use client";

import Image from "next/image";
import {
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { StorefrontProductMedia } from "@/commerce/product-media";
import {
  buildDesktopProductGallerySlides,
  gallerySlidePeek,
  resolveGalleryImageForSelection,
  resolveGallerySlideForSelection,
  stepGallerySlide,
} from "@/components/brand/product-gallery-layout";

const DRAG_THRESHOLD_PX = 48;
const DIALOG_FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

type BrandProductMediaStageProps = Readonly<{
  media: StorefrontProductMedia;
  productName: string;
  selectedVariantId: string | null;
  galleryIndexByVariantId: Readonly<Record<string, number>>;
}>;

function clampedImageStep(current: number, delta: number, imageCount: number) {
  if (imageCount <= 0) return 0;
  return Math.min(Math.max(current + delta, 0), imageCount - 1);
}

export function BrandProductMediaStage({
  media,
  productName,
  selectedVariantId,
  galleryIndexByVariantId,
}: BrandProductMediaStageProps) {
  const images = media.gallery;
  const slides = buildDesktopProductGallerySlides(images.length);

  const [desktopSlide, setDesktopSlide] = useState(0);
  const [mobileImage, setMobileImage] = useState(0);
  const [syncedVariantId, setSyncedVariantId] = useState(selectedVariantId);
  const [lightboxImage, setLightboxImage] = useState(0);

  const mobileTriggerRef = useRef<HTMLButtonElement | null>(null);
  const lightboxRef = useRef<HTMLDialogElement | null>(null);
  const lightboxCloseRef = useRef<HTMLButtonElement | null>(null);
  const mobileDragOriginRef = useRef<{ x: number; y: number } | null>(null);
  const mobileDraggedRef = useRef(false);
  const lightboxDragOriginRef = useRef<{ x: number; y: number } | null>(null);

  if (selectedVariantId !== syncedVariantId) {
    const nextDesktop = resolveGallerySlideForSelection({
      slides,
      currentSlide: desktopSlide,
      syncedVariantId,
      selectedVariantId,
      galleryIndexByVariantId,
    });
    const nextMobile = resolveGalleryImageForSelection({
      imageCount: images.length,
      currentImage: mobileImage,
      syncedVariantId,
      selectedVariantId,
      galleryIndexByVariantId,
    });

    setSyncedVariantId(selectedVariantId);
    setDesktopSlide(nextDesktop.slide);
    setMobileImage(nextMobile.image);
  }

  if (images.length === 0) return null;

  function stepMobile(delta: number) {
    setMobileImage((current) => clampedImageStep(current, delta, images.length));
  }

  function stepLightbox(delta: number) {
    setLightboxImage((current) => clampedImageStep(current, delta, images.length));
  }

  function handleSwipeStart(
    event: ReactPointerEvent<HTMLElement>,
    target: "mobile" | "lightbox",
  ) {
    if (!event.isPrimary) return;
    const next = { x: event.clientX, y: event.clientY };
    if (target === "mobile") {
      mobileDragOriginRef.current = next;
      mobileDraggedRef.current = false;
    } else {
      lightboxDragOriginRef.current = next;
    }
  }

  function handleSwipeEnd(
    event: ReactPointerEvent<HTMLElement>,
    target: "mobile" | "lightbox",
  ) {
    const ref = target === "mobile" ? mobileDragOriginRef : lightboxDragOriginRef;
    const origin = ref.current;
    ref.current = null;
    if (!origin) return;

    const horizontal = event.clientX - origin.x;
    const vertical = event.clientY - origin.y;
    if (Math.abs(horizontal) < DRAG_THRESHOLD_PX || Math.abs(horizontal) <= Math.abs(vertical)) {
      return;
    }

    if (target === "mobile") {
      mobileDraggedRef.current = true;
      stepMobile(horizontal < 0 ? 1 : -1);
    } else {
      stepLightbox(horizontal < 0 ? 1 : -1);
    }
  }

  function openLightbox() {
    if (mobileDraggedRef.current) {
      mobileDraggedRef.current = false;
      return;
    }

    setLightboxImage(mobileImage);
    const dialog = lightboxRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    lightboxCloseRef.current?.focus();
  }

  function containLightboxFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      stepLightbox(-1);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      stepLightbox(1);
      return;
    }
    if (event.key !== "Tab") return;

    const dialog = lightboxRef.current;
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR),
    ).filter((element) => element.getClientRects().length > 0);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const currentMobileImage = images[mobileImage]!;
  const currentLightboxImage = images[lightboxImage]!;
  const hasMultipleImages = images.length > 1;
  const hasMultipleDesktopSlides = slides.length > 1;

  return (
    <section
      className="product-page-hero pdp-stage"
      aria-label={`Ảnh chính của ${productName}`}
      data-header-overlay-hero=""
    >
      <div className="pdp-mobile-gallery lg:hidden">
        <button
          ref={mobileTriggerRef}
          type="button"
          className="pdp-mobile-gallery__image"
          aria-label={`Mở ảnh ${mobileImage + 1} / ${images.length} của ${productName}`}
          onClick={openLightbox}
          onPointerDown={(event) => handleSwipeStart(event, "mobile")}
          onPointerUp={(event) => handleSwipeEnd(event, "mobile")}
          onPointerCancel={() => {
            mobileDragOriginRef.current = null;
          }}
        >
          <Image
            src={currentMobileImage.url}
            alt={mobileImage === 0 ? productName : currentMobileImage.alt || `${productName} - Ảnh ${mobileImage + 1}`}
            fill
            preload={mobileImage === 0}
            sizes="(max-width: 1023px) 100vw, 1px"
            /*
              An `<img>` is draggable by default, and starting a native image drag fires
              `pointercancel`, which throws away the swipe mid-gesture. Touch never hits this,
              a mouse or trackpad always does.
            */
            draggable={false}
            className="object-cover"
          />
        </button>

        <p className="pdp-mobile-gallery__counter" role="status" aria-live="polite">
          {mobileImage + 1}/{images.length}
        </p>
      </div>

      <div className="pdp-stage__track hidden lg:block">
        {slides.map((slideImages, slideIndex) => {
          const peek = gallerySlidePeek(slides, slideIndex, images.length);
          /*
            The neighbour is a teaser, not a photograph of its own: the same image is shown in full
            on the adjacent page, so here it is decorative -- empty alt, hidden from assistive
            technology -- and requested with the same `sizes`, so the browser reuses the download.
          */
          const peekCell = peek === null ? null : (
            <div
              key={`peek-${peek.image}`}
              className="pdp-stage__cell pdp-stage__cell--peek"
              data-peek={peek.side}
              aria-hidden="true"
            >
              <Image
                src={images[peek.image]!.url}
                alt=""
                fill
                sizes="(min-width: 1024px) 50vw, 1px"
                draggable={false}
                className={`object-cover ${peek.side === "after" ? "object-left" : "object-right"}`}
              />
            </div>
          );

          return (
            <div
              key={slideImages.join("-")}
              className="pdp-stage__slide"
              data-active={slideIndex === desktopSlide ? "true" : "false"}
            >
              {peek?.side === "before" ? peekCell : null}
              {slideImages.map((imageIndex) => {
                const image = images[imageIndex]!;
                return (
                  <div key={image.url} className="pdp-stage__cell">
                    <Image
                      src={image.url}
                      alt={imageIndex === 0 ? productName : image.alt || `${productName} - Ảnh ${imageIndex + 1}`}
                      fill
                      preload={imageIndex === 0}
                      sizes="(min-width: 1024px) 50vw, 1px"
                      draggable={false}
                      className="object-cover"
                    />
                  </div>
                );
              })}
              {peek?.side === "after" ? peekCell : null}
            </div>
          );
        })}
      </div>

      {hasMultipleDesktopSlides ? (
        <>
          <div
            className="pdp-stage__nav"
            onPointerDown={(event) => handleSwipeStart(event, "lightbox")}
            onPointerUp={(event) => {
              const origin = lightboxDragOriginRef.current;
              lightboxDragOriginRef.current = null;
              if (!origin) return;
              const horizontal = event.clientX - origin.x;
              const vertical = event.clientY - origin.y;
              if (Math.abs(horizontal) < DRAG_THRESHOLD_PX || Math.abs(horizontal) <= Math.abs(vertical)) return;
              setDesktopSlide((current) =>
                stepGallerySlide(current, horizontal < 0 ? 1 : -1, slides.length),
              );
            }}
            onPointerCancel={() => {
              lightboxDragOriginRef.current = null;
            }}
          >
            <button
              type="button"
              className="pdp-stage__half"
              disabled={desktopSlide === 0}
              onClick={() =>
                setDesktopSlide((current) => stepGallerySlide(current, -1, slides.length))
              }
            >
              <span className="sr-only">Ảnh trước</span>
            </button>
            <button
              type="button"
              className="pdp-stage__half"
              disabled={desktopSlide === slides.length - 1}
              onClick={() =>
                setDesktopSlide((current) => stepGallerySlide(current, 1, slides.length))
              }
            >
              <span className="sr-only">Ảnh tiếp theo</span>
            </button>
          </div>

          {/* The desktop wording is PR #51's approved copy; only the mobile counter above is this
              spec's to define. */}
          <p className="pdp-stage__counter" role="status" aria-live="polite">
            {`Trang ảnh ${desktopSlide + 1} / ${slides.length}`}
          </p>
        </>
      ) : null}

      <dialog
        ref={lightboxRef}
        aria-label={`Xem ảnh ${productName}`}
        className="m-0 h-dvh max-h-none w-screen max-w-none overflow-hidden border-0 bg-black/95 p-0 text-white backdrop:bg-black/95"
        onClose={() => mobileTriggerRef.current?.focus()}
        onKeyDown={containLightboxFocus}
      >
        <div className="relative flex h-dvh w-screen items-center justify-center">
          <button
            ref={lightboxCloseRef}
            type="button"
            aria-label="Đóng thư viện ảnh"
            className="absolute right-4 top-4 z-20 inline-flex h-11 w-11 items-center justify-center border border-white/50 bg-black/30 text-2xl text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            onClick={() => lightboxRef.current?.close()}
          >
            ×
          </button>

          <div
            className="relative h-full w-full touch-pan-y"
            onPointerDown={(event) => handleSwipeStart(event, "lightbox")}
            onPointerUp={(event) => handleSwipeEnd(event, "lightbox")}
            onPointerCancel={() => {
              lightboxDragOriginRef.current = null;
            }}
          >
            <Image
              src={currentLightboxImage.url}
              alt={currentLightboxImage.alt || `${productName} - Ảnh ${lightboxImage + 1}`}
              fill
              sizes="100vw"
              draggable={false}
              className="object-contain"
            />
          </div>

          {hasMultipleImages ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-5 z-20 flex justify-center">
              <p className="bg-black/55 px-3 py-1 text-xs font-semibold tracking-[0.12em]">
                {lightboxImage + 1}/{images.length}
              </p>
            </div>
          ) : null}
        </div>
      </dialog>
    </section>
  );
}
