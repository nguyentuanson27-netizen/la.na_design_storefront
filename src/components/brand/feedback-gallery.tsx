"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

import { useScrollLock } from "@/components/headless/use-scroll-lock";
import type { HomeFeedbackSection } from "@/routes/home-model";

type FeedbackImage = HomeFeedbackSection["images"][number];

/**
 * Customer feedback photographs (spec §7.6): the homepage rail and the `/feedback` gallery.
 *
 * Images only. No customer name, product name, quote or caption is rendered, and no photograph is a
 * link -- each carries only the alt decision its config entry made. The rail crops to a fixed 3:4
 * box; `/feedback` is an uncropped masonry that reserves each photograph's natural ratio. Images are
 * lazy -- except `/feedback`'s first row, which is its above-the-fold content -- so a long gallery
 * neither eager-loads nor shifts the page as it arrives.
 *
 * Pressing a photograph opens it enlarged in `FeedbackViewer` (owner request 2026-09-24): each
 * photograph is a button, never a link.
 */

function FeedbackPhoto({
  image,
  sizes,
  eager = false,
  uncropped = false,
}: Readonly<{
  image: FeedbackImage;
  sizes: string;
  eager?: boolean;
  uncropped?: boolean;
}>) {
  if (uncropped) {
    return (
      <span className="feedback-photo-uncropped">
        <Image
          src={image.src}
          alt={image.alt}
          width={image.width}
          height={image.height}
          sizes={sizes}
          loading={eager ? "eager" : "lazy"}
          className="feedback-photo-uncropped__img"
        />
      </span>
    );
  }

  return (
    <span className="feedback-photo">
      <Image
        src={image.src}
        alt={image.alt}
        fill
        sizes={sizes}
        loading={eager ? "eager" : "lazy"}
        className="object-cover"
      />
    </span>
  );
}

/** The button's name: the photograph's own alt when it has one, its position when it is decorative. */
function zoomLabel(image: FeedbackImage, index: number, total: number) {
  return image.alt ? `Phóng to ảnh: ${image.alt}` : `Phóng to ảnh ${index + 1} trên ${total}`;
}

/** Which photograph, if any, is open in the viewer. */
function useFeedbackViewer(total: number) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const open = useCallback((index: number) => setOpenIndex(index), []);
  const close = useCallback(() => setOpenIndex(null), []);
  const step = useCallback(
    (delta: number) =>
      setOpenIndex((current) => (current === null ? current : (current + delta + total) % total)),
    [total],
  );
  return { openIndex, open, close, step };
}

/**
 * The enlarged photograph, uncropped, in a native modal `<dialog>`: `showModal()` makes the page
 * behind it inert, `Escape` closes it, and closing returns focus to the photograph that opened it.
 * Arrow keys and the previous/next buttons move through the same configured order; a press on the
 * backdrop closes it. The image is only mounted while the viewer is open, so a closed viewer loads
 * nothing.
 */
function FeedbackViewer({
  images,
  openIndex,
  onClose,
  onStep,
}: Readonly<{
  images: readonly FeedbackImage[];
  openIndex: number | null;
  onClose: () => void;
  onStep: (delta: number) => void;
}>) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const isOpen = openIndex !== null;
  useScrollLock(isOpen);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen && !dialog.open) dialog.showModal();
    if (!isOpen && dialog.open) dialog.close();
  }, [isOpen]);

  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      onStep(1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      onStep(-1);
    }
  };

  // The dialog box is the whole viewport; a press that lands on it rather than on a control or the
  // photograph is a press on the backdrop.
  const onBackdrop = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  const image = openIndex === null ? null : images[openIndex];
  const many = images.length > 1;

  return (
    <dialog
      ref={dialogRef}
      className="feedback-viewer"
      aria-label="Xem ảnh feedback"
      onClose={onClose}
      onKeyDown={onKeyDown}
      onClick={onBackdrop}
    >
      {image && openIndex !== null ? (
        <>
          <button type="button" className="feedback-viewer__close" onClick={onClose} aria-label="Đóng">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
          <figure className="feedback-viewer__figure">
            <Image
              key={image.src}
              src={image.src}
              alt={image.alt}
              width={image.width}
              height={image.height}
              sizes="100vw"
              className="feedback-viewer__img"
            />
          </figure>
          {many ? (
            <>
              <button
                type="button"
                className="feedback-viewer__nav feedback-viewer__nav--prev"
                onClick={() => onStep(-1)}
                aria-label="Ảnh trước"
              >
                <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                  <polyline points="15 6 9 12 15 18" />
                </svg>
              </button>
              <button
                type="button"
                className="feedback-viewer__nav feedback-viewer__nav--next"
                onClick={() => onStep(1)}
                aria-label="Ảnh sau"
              >
                <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                  <polyline points="9 6 15 12 9 18" />
                </svg>
              </button>
              <p className="feedback-viewer__count" aria-live="polite">
                {openIndex + 1} / {images.length}
              </p>
            </>
          ) : null}
        </>
      ) : null}
    </dialog>
  );
}

/** `/feedback` opens on its gallery: one desktop row is above the fold, everything after it waits. */
const FEEDBACK_PAGE_EAGER_COUNT = 4;

/**
 * The homepage rail: native horizontal scroll with snap points, no carousel dependency and no
 * autoplay. Touch swipes it; a mouse uses its scrollbar or a trackpad; the keyboard focuses the
 * viewport and scrolls it with the arrow keys, or tabs through the photographs. The title is a
 * heading, not a link -- the way to the full gallery is the `Xem thêm` link after the rail.
 */
export function FeedbackRail({
  title,
  ctaLabel,
  href,
  images,
}: Readonly<{ title: string; ctaLabel: string; href: string; images: readonly FeedbackImage[] }>) {
  const viewer = useFeedbackViewer(images.length);

  return (
    <section
      className="feedback-rail"
      aria-labelledby="home-feedback-title"
      data-homepage-region="feedback"
    >
      <div className="section-heading-row">
        <h2 id="home-feedback-title">{title}</h2>
      </div>
      <div className="feedback-rail__viewport" tabIndex={0} role="group" aria-label={title}>
        <ul className="feedback-rail__track">
          {images.map((image, index) => (
            <li className="feedback-rail__item" key={`${index}-${image.src}`}>
              <button
                type="button"
                className="feedback-zoom"
                aria-label={zoomLabel(image, index, images.length)}
                aria-haspopup="dialog"
                onClick={() => viewer.open(index)}
              >
                <FeedbackPhoto image={image} sizes="(min-width: 901px) 20vw, 42vw" />
              </button>
            </li>
          ))}
        </ul>
      </div>
      <p className="home-more">
        <Link href={href}>
          {ctaLabel}
          <span className="sr-only">: {title}</span>
        </Link>
      </p>
      <FeedbackViewer images={images} openIndex={viewer.openIndex} onClose={viewer.close} onStep={viewer.step} />
    </section>
  );
}

/** The `/feedback` page's full gallery, in the configured order. */
export function FeedbackGallery({ images }: Readonly<{ images: readonly FeedbackImage[] }>) {
  const viewer = useFeedbackViewer(images.length);

  return (
    <>
      <ul className="feedback-gallery">
        {images.map((image, index) => (
          <li className="feedback-gallery__item" key={`${index}-${image.src}`}>
            <button
              type="button"
              className="feedback-zoom"
              aria-label={zoomLabel(image, index, images.length)}
              aria-haspopup="dialog"
              onClick={() => viewer.open(index)}
            >
              <FeedbackPhoto
                image={image}
                sizes="(min-width: 901px) 25vw, 50vw"
                eager={index < FEEDBACK_PAGE_EAGER_COUNT}
                uncropped
              />
            </button>
          </li>
        ))}
      </ul>
      <FeedbackViewer images={images} openIndex={viewer.openIndex} onClose={viewer.close} onStep={viewer.step} />
    </>
  );
}
