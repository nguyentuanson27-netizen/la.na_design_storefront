"use client";

import Image from "next/image";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { StorefrontProductMedia } from "@/commerce/product-media";
import { pdpProductImageLoader } from "@/components/headless/pdp-image-loader";
import { useDocumentLoaded } from "@/components/headless/use-document-loaded";
import { useSnapTrack } from "@/components/headless/use-snap-track";
import {
  buildDesktopProductGallerySlides,
  resolveGalleryImageForSelection,
  resolveGallerySlideForSelection,
  stepGallerySlide,
} from "@/components/brand/product-gallery-layout";
import { preloadImageForViewport } from "@/components/brand/viewport-image-preload";

const DRAG_THRESHOLD_PX = 48;
const DIALOG_FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * The `lg` seam the two compositions split on, as the media queries the first photograph's preload
 * hints are scoped by. Each composition's `<img>` stays lazy, because an eager `<img>` is fetched
 * even inside the composition `display: none` hides; the scoped hint is what starts the visible
 * one early, and the hidden one is never requested at all.
 */
const MOBILE_MEDIA = "(max-width: 1023.98px)";
const DESKTOP_MEDIA = "(min-width: 1024px)";
const MOBILE_SIZES = "(max-width: 1023px) 100vw, 1px";
const DESKTOP_SIZES = "(min-width: 1024px) 50vw, 1px";

type BrandProductMediaStageProps = Readonly<{
  media: StorefrontProductMedia;
  productName: string;
  selectedVariantId: string | null;
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

  const [desktopSlide, setDesktopSlide] = useState(0);
  const [syncedVariantId, setSyncedVariantId] = useState(selectedVariantId);
  const mobile = useSnapTrack({ count: images.length });
  const lightbox = useSnapTrack({ count: images.length });
  const documentLoaded = useDocumentLoaded();

  const lightboxRef = useRef<HTMLDialogElement | null>(null);
  const lightboxCloseRef = useRef<HTMLButtonElement | null>(null);
  const lightboxOpenerRef = useRef<HTMLButtonElement | null>(null);
  const desktopDragOriginRef = useRef<{ x: number; y: number } | null>(null);
  const mobileSyncedVariantRef = useRef(selectedVariantId);

  if (selectedVariantId !== syncedVariantId) {
    const nextDesktop = resolveGallerySlideForSelection({
      slides,
      currentSlide: desktopSlide,
      syncedVariantId,
      selectedVariantId,
      galleryIndexByVariantId,
    });

    setSyncedVariantId(selectedVariantId);
    setDesktopSlide(nextDesktop.slide);
  }

  // The phone gallery follows a variant change by moving its track, which is a DOM write, so it
  // happens after commit rather than during render as the desktop slide's state change does.
  const { index: mobileIndex, mount: mountMobile, scrollToIndex: scrollMobileTo } = mobile;
  useEffect(() => {
    const previousVariantId = mobileSyncedVariantRef.current;
    if (previousVariantId === selectedVariantId) return;
    mobileSyncedVariantRef.current = selectedVariantId;
    const next = resolveGalleryImageForSelection({
      imageCount: images.length,
      currentImage: mobileIndex,
      syncedVariantId: previousVariantId,
      selectedVariantId,
      galleryIndexByVariantId,
    });
    if (next.image !== mobileIndex) scrollMobileTo(next.image);
  }, [selectedVariantId, galleryIndexByVariantId, images.length, mobileIndex, scrollMobileTo]);

  // Once the page has loaded, the second photograph is fetched ahead of the first swipe, so the
  // swipe lands on a photograph that is already there rather than on a request just leaving.
  useEffect(() => {
    if (documentLoaded) mountMobile([1]);
  }, [documentLoaded, mountMobile]);

  if (images.length === 0) return null;

  preloadImageForViewport({
    src: images[0]!.url,
    loader: pdpProductImageLoader,
    sizes: MOBILE_SIZES,
    media: MOBILE_MEDIA,
  });
  preloadImageForViewport({
    src: images[0]!.url,
    loader: pdpProductImageLoader,
    sizes: DESKTOP_SIZES,
    media: DESKTOP_MEDIA,
  });

  function openLightbox(index: number, opener: HTMLButtonElement) {
    const dialog = lightboxRef.current;
    if (!dialog || dialog.open) return;
    lightboxOpenerRef.current = opener;
    dialog.showModal();
    // The dialog has a box only once it is open, so the track can be positioned only now.
    lightbox.scrollToIndex(index);
    lightboxCloseRef.current?.focus();
  }

  function closeLightbox() {
    // The phone gallery returns showing the photograph the lightbox was left on.
    mobile.scrollToIndex(lightbox.index);
    const opener = mobile.trackRef.current?.querySelectorAll<HTMLButtonElement>(
      ".pdp-mobile-gallery__image",
    )[lightbox.index];
    (opener ?? lightboxOpenerRef.current)?.focus({ preventScroll: true });
  }

  function onMobileKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const target = Math.min(
      Math.max(mobile.index + (event.key === "ArrowLeft" ? -1 : 1), 0),
      images.length - 1,
    );
    mobile.scrollToIndex(target, "animated");
    mobile.trackRef.current
      ?.querySelectorAll<HTMLButtonElement>(".pdp-mobile-gallery__image")
      [target]?.focus({ preventScroll: true });
  }

  function containLightboxFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      lightbox.scrollToIndex(lightbox.index - 1, "animated");
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      lightbox.scrollToIndex(lightbox.index + 1, "animated");
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

  function handleDesktopSwipeEnd(event: ReactPointerEvent<HTMLElement>) {
    const origin = desktopDragOriginRef.current;
    desktopDragOriginRef.current = null;
    if (!origin) return;
    const horizontal = event.clientX - origin.x;
    const vertical = event.clientY - origin.y;
    if (Math.abs(horizontal) < DRAG_THRESHOLD_PX || Math.abs(horizontal) <= Math.abs(vertical)) return;
    setDesktopSlide((current) =>
      stepGallerySlide(current, horizontal < 0 ? 1 : -1, slides.length),
    );
  }

  const imageAlt = (index: number) =>
    index === 0 ? productName : images[index]!.alt || `${productName} - Ảnh ${index + 1}`;
  const hasMultipleImages = images.length > 1;
  const hasMultipleDesktopSlides = slides.length > 1;

  return (
    <section
      className="product-page-hero pdp-stage"
      aria-label={`Ảnh chính của ${productName}`}
      data-header-overlay-hero=""
    >
      <div className="pdp-mobile-gallery lg:hidden">
        {/*
          One page per photograph on a native scroll-snap track (`useSnapTrack`): the photograph
          follows the finger, and a photograph is mounted only once the shopper is on it or beside
          it. Each page is the button that opens it full screen; only the current one is in the tab
          order, and the arrow keys move between them.
        */}
        <div
          {...mobile.trackProps}
          className="pdp-mobile-gallery__track"
          onKeyDown={onMobileKeyDown}
        >
          {images.map((image, index) => {
            const isCurrent = index === mobile.index;
            return (
              <button
                key={image.url}
                type="button"
                className="pdp-mobile-gallery__image"
                aria-label={`Mở ảnh ${index + 1} / ${images.length} của ${productName}`}
                tabIndex={isCurrent ? undefined : -1}
                data-active={isCurrent ? "true" : "false"}
                onClick={(event) => openLightbox(index, event.currentTarget)}
              >
                {mobile.mounted.has(index) ? (
                  <Image
                    loader={pdpProductImageLoader}
                    src={image.url}
                    alt={imageAlt(index)}
                    fill
                    sizes={MOBILE_SIZES}
                    /*
                      An `<img>` is draggable by default, and a native image drag would take over
                      the mouse drag the track turns into scrolling. Touch never hits this.
                    */
                    draggable={false}
                    className="object-cover"
                  />
                ) : null}
              </button>
            );
          })}
        </div>

        <p className="pdp-mobile-gallery__counter" role="status" aria-live="polite">
          {mobile.index + 1}/{images.length}
        </p>
      </div>

      <div className="pdp-stage__track hidden lg:block">
        {slides.map((slideImages, slideIndex) => (
          <div
            key={slideImages.join("-")}
            className="pdp-stage__slide"
            data-active={slideIndex === desktopSlide ? "true" : "false"}
          >
            {/*
              The width each photograph leaves in its half is filled with its own colours: the same
              photographs, heavily blurred, one layer each across the whole stage, the second fading
              in over the middle so the two fields blend with no seam between the halves. Decorative
              -- empty alt, hidden from assistive technology -- and requested with the same `sizes` as
              the photographs in front, so the browser reuses those downloads.
            */}
            <div className="pdp-stage__backdrop" aria-hidden="true">
              {slideImages.map((imageIndex) => (
                <div key={imageIndex} className="pdp-stage__backdrop-layer">
                  <Image
                    loader={pdpProductImageLoader}
                    src={images[imageIndex]!.url}
                    alt=""
                    fill
                    sizes={DESKTOP_SIZES}
                    draggable={false}
                    className="pdp-stage__backdrop-image object-cover"
                  />
                </div>
              ))}
            </div>

            {slideImages.map((imageIndex) => {
              const image = images[imageIndex]!;
              return (
                <div key={image.url} className="pdp-stage__half">
                  <div className="pdp-stage__cell">
                    <Image
                      loader={pdpProductImageLoader}
                      src={image.url}
                      alt={imageAlt(imageIndex)}
                      fill
                      sizes={DESKTOP_SIZES}
                      draggable={false}
                      className="object-cover"
                    />
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {hasMultipleDesktopSlides ? (
        <>
          <div
            className="pdp-stage__nav"
            onPointerDown={(event) => {
              if (event.isPrimary) desktopDragOriginRef.current = { x: event.clientX, y: event.clientY };
            }}
            onPointerUp={handleDesktopSwipeEnd}
            onPointerCancel={() => {
              desktopDragOriginRef.current = null;
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
        onClose={closeLightbox}
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

          {/* The same snap track as the phone gallery, each photograph contained rather than cropped. */}
          <div {...lightbox.trackProps} className="pdp-lightbox__track">
            {images.map((image, index) => (
              <div key={image.url} className="pdp-lightbox__page">
                {lightbox.mounted.has(index) ? (
                  <Image
                    loader={pdpProductImageLoader}
                    src={image.url}
                    alt={image.alt || `${productName} - Ảnh ${index + 1}`}
                    fill
                    sizes="100vw"
                    draggable={false}
                    className="object-contain"
                  />
                ) : null}
              </div>
            ))}
          </div>

          {hasMultipleImages ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-5 z-20 flex justify-center">
              <p className="bg-black/55 px-3 py-1 text-xs font-semibold tracking-[0.12em]">
                {lightbox.index + 1}/{images.length}
              </p>
            </div>
          ) : null}
        </div>
      </dialog>
    </section>
  );
}
