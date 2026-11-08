"use client";

import Image from "next/image";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { BRAND } from "@/brand";
import type { ProductReviewSection, ProductReviewView } from "@/commerce/product-review";
import {
  PRODUCT_REVIEWS_ANCHOR,
  buildReviewFilters,
  distributionPercent,
  filterReviews,
  fitShares,
  formatReviewAverage,
  type ReviewFilterKey,
} from "@/components/headless/product-review-model";
import { useScrollLock } from "@/components/headless/use-scroll-lock";

import { ReviewStars } from "./product-review-summary";

/**
 * The product page's review section: the summary, the product's own photographs, then the reviews
 * with a filter and "Xem thêm".
 *
 * Every figure is decided before it gets here. What this file adds is interaction only: which filter
 * is on, how many cards are open, and which photograph is enlarged. The photograph rail is passed in
 * as `photoRail`, so it keeps the page-wide gutters it was drawn for instead of sitting inside this
 * section's own.
 */

const FIRST_PAGE = 5;
const PAGE_STEP = 10;
const COLUMN = "mx-auto max-w-3xl px-6";

function SummaryBlock({ summary }: Readonly<{ summary: NonNullable<ProductReviewSection["summary"]> }>) {
  const fit = summary.fit === null ? null : fitShares(summary.fit);
  return (
    <div className="mt-3 text-center" data-review-summary="">
      {/* One line: the average, the stars, how many. The star breakdown folds away. */}
      <p className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
        <span className="font-display text-2xl leading-none text-[#2A1810]">{formatReviewAverage(summary.average)}</span>
        <ReviewStars value={summary.average} className="text-sm" />
        <span className="text-xs text-[#70584B]">{summary.count} đánh giá</span>
      </p>

      {fit === null ? null : (
        <p className="mt-2 text-xs text-[#70584B]" data-review-fit="">
          <span className="font-semibold text-[#3B2219]">Về size:</span> Vừa vặn {fit.trueToSize}% · Hơi chật{" "}
          {fit.small}% · Hơi rộng {fit.large}%
        </p>
      )}

      <details className="mx-auto mt-2 max-w-xs text-left" data-review-breakdown="">
        <summary className="cursor-pointer list-none text-center text-xs text-[#70584B] underline underline-offset-4 [&::-webkit-details-marker]:hidden">
          Xem theo từng mức sao
        </summary>
        <ul className="mt-3 space-y-1.5" aria-label="Số đánh giá theo từng mức sao">
          {summary.distribution.map((count, index) => (
            <li key={index} className="flex items-center gap-2 text-xs text-[#3B2219]">
              <span className="w-11 shrink-0">{5 - index} sao</span>
              <span aria-hidden="true" className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#3B2219]/12">
                <span
                  className="block h-full rounded-full bg-[#8A5A2B]"
                  style={{ width: `${distributionPercent(count, summary.count)}%` }}
                />
              </span>
              <span className="w-8 shrink-0 text-right text-[#70584B]">{count}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function ReviewPhotoViewer({
  images,
  index,
  onClose,
  onStep,
}: Readonly<{
  images: readonly ProductReviewView["images"][number][];
  index: number | null;
  onClose: () => void;
  onStep: (delta: number) => void;
}>) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useScrollLock(index !== null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (index !== null && !dialog.open) dialog.showModal();
    if (index === null && dialog.open) dialog.close();
  }, [index]);

  const photo = index === null ? null : images[index] ?? null;

  function handleKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onStep(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      onStep(1);
    }
  }

  const button =
    "absolute grid h-11 w-11 place-items-center rounded-full bg-black/55 text-xl text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white";

  return (
    <dialog
      ref={dialogRef}
      aria-label="Ảnh trong đánh giá"
      onClose={onClose}
      onKeyDown={handleKeyDown}
      className="m-auto h-[min(90vh,46rem)] w-[min(94vw,32rem)] max-w-none bg-transparent p-0 text-white backdrop:bg-black/85"
    >
      {photo === null ? null : (
        <div className="relative h-full w-full">
          <Image src={photo.src} alt={photo.alt} fill sizes="(min-width: 640px) 32rem, 94vw" className="object-contain" />
          <button type="button" onClick={onClose} aria-label="Đóng ảnh" className={`${button} right-2 top-2`}>
            ✕
          </button>
          {images.length > 1 ? (
            <>
              <button type="button" onClick={() => onStep(-1)} aria-label="Ảnh trước" className={`${button} left-2 top-1/2 -translate-y-1/2`}>
                ‹
              </button>
              <button type="button" onClick={() => onStep(1)} aria-label="Ảnh sau" className={`${button} right-2 top-1/2 -translate-y-1/2`}>
                ›
              </button>
              <p className="absolute inset-x-0 bottom-2 text-center text-xs" aria-live="polite">
                {(index ?? 0) + 1} / {images.length}
              </p>
            </>
          ) : null}
        </div>
      )}
    </dialog>
  );
}

function ReviewCard({
  review,
  onOpenPhoto,
}: Readonly<{ review: ProductReviewView; onOpenPhoto: (images: ProductReviewView["images"], index: number) => void }>) {
  return (
    <article className="border-t border-[#3B2219]/15 py-5" data-review-id={review.id}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-[#2A1810]">{review.authorName}</h3>
        <time dateTime={review.reviewedAtIso} className="shrink-0 text-xs text-[#70584B]">
          {review.dateLabel}
        </time>
      </div>
      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
        <ReviewStars value={review.rating} className="text-sm" />
        {review.verifiedPurchase ? (
          <span className="font-semibold text-[#2F5D3A]">✓ Đã mua hàng</span>
        ) : null}
        <span className="text-[#70584B]">{review.sourceLabel}</span>
      </p>
      {review.detailLine === null && review.fitLabel === null ? null : (
        <p className="mt-1 text-xs text-[#70584B]">
          {[review.detailLine, review.fitLabel].filter(Boolean).join(" · ")}
        </p>
      )}
      {review.body === null ? null : (
        <p className="mt-3 whitespace-pre-line text-sm leading-6 text-[#3B2219]">{review.body}</p>
      )}
      {review.images.length === 0 ? null : (
        <ul className="mt-3 flex flex-wrap gap-2" aria-label={`Ảnh của ${review.authorName}`}>
          {review.images.map((image, index) => (
            <li key={`${index}-${image.src}`}>
              <button
                type="button"
                onClick={() => onOpenPhoto(review.images, index)}
                aria-haspopup="dialog"
                aria-label={`Phóng to ảnh ${index + 1} trong ${review.images.length} của ${review.authorName}`}
                className="relative block h-[5.25rem] w-16 overflow-hidden rounded bg-[#D4C7B8] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3B2219]"
              >
                <Image src={image.src} alt="" fill sizes="64px" className="object-cover" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {review.shopReply === null ? null : (
        <div className="mt-3 rounded-md bg-[#F0E9DE] px-3 py-2.5 text-xs leading-5 text-[#3B2219]">
          <p className="font-semibold uppercase tracking-[0.08em] text-[#70584B]">{BRAND.identity.name} trả lời</p>
          <p className="mt-0.5 whitespace-pre-line">{review.shopReply}</p>
        </div>
      )}
    </article>
  );
}

export function ProductReviews({
  section,
  photoRail = null,
}: Readonly<{ section: ProductReviewSection; photoRail?: ReactNode }>) {
  const [filter, setFilter] = useState<ReviewFilterKey>("all");
  const [shown, setShown] = useState(FIRST_PAGE);
  const [viewer, setViewer] = useState<{
    images: ProductReviewView["images"];
    index: number;
  } | null>(null);

  const filters = buildReviewFilters(section.items);
  const matching = filterReviews(section.items, filter);
  const visible = matching.slice(0, shown);

  function chooseFilter(next: ReviewFilterKey) {
    setFilter(next);
    setShown(FIRST_PAGE);
  }

  const chip = (active: boolean) =>
    `relative inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-md border px-3 text-xs font-medium transition after:absolute after:-inset-[6px] after:content-[''] ${
      active
        ? "border-[#3B2219] bg-[#3B2219] text-[#FAF7F2]"
        : "border-[#3B2219]/25 bg-[#FFFDFA] text-[#3B2219] hover:border-[#3B2219]"
    }`;

  return (
    <section
      id={PRODUCT_REVIEWS_ANCHOR}
      aria-labelledby="pdp-reviews-title"
      className="collection-products-anchor border-t border-black/20 pt-10"
      data-pdp-region="reviews"
    >
      <div className={COLUMN}>
        <h2 id="pdp-reviews-title" className="text-center font-display text-[1.0625rem] font-normal uppercase tracking-[0.3em]">
          Đánh giá của khách
        </h2>
        {section.summary === null ? (
          <p className="mt-3 text-center text-xs text-[#70584B]">{section.count} đánh giá</p>
        ) : (
          <SummaryBlock summary={section.summary} />
        )}
      </div>

      {photoRail === null ? null : <div className="pdp-review-photos">{photoRail}</div>}

      <div className={`${COLUMN} pb-14 pt-2`}>
        {filters.length === 0 ? null : (
          <div className="-mx-6 overflow-x-auto px-6 py-2" role="group" aria-label="Lọc đánh giá">
            <div className="flex items-center gap-3.5">
              {filters.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  aria-pressed={filter === item.key}
                  onClick={() => chooseFilter(item.key)}
                  className={chip(filter === item.key)}
                >
                  {item.label} ({item.count})
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mt-2" data-review-list="">
          {visible.map((review) => (
            <ReviewCard
              key={review.id}
              review={review}
              onOpenPhoto={(images, index) => setViewer({ images, index })}
            />
          ))}
        </div>

        <p role="status" className="sr-only">
          Đang hiển thị {visible.length} trên {matching.length} đánh giá
        </p>
        {matching.length > shown ? (
          <button
            type="button"
            onClick={() => setShown((current) => current + PAGE_STEP)}
            className="btn btn--outline mt-2 w-full"
          >
            Xem thêm đánh giá ({matching.length - shown})
          </button>
        ) : null}
        {section.count > section.items.length ? (
          <p className="mt-4 text-center text-xs text-[#70584B]">
            Đang hiển thị {section.items.length} đánh giá mới nhất trong {section.count}.
          </p>
        ) : null}
      </div>

      <ReviewPhotoViewer
        images={viewer?.images ?? []}
        index={viewer?.index ?? null}
        onClose={() => setViewer(null)}
        onStep={(delta) =>
          setViewer((current) =>
            current === null
              ? null
              : { ...current, index: (current.index + delta + current.images.length) % current.images.length },
          )
        }
      />
    </section>
  );
}
