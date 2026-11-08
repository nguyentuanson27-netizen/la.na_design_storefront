"use client";

import Image from "next/image";

import type { CustomerPhotoStrip as CustomerPhotoStripModel } from "@/components/headless/customer-photo-strip-model";
import {
  PRODUCT_REVIEWS_ANCHOR,
  formatReviewAverage,
  ratingLinkText,
  starFillPercent,
} from "@/components/headless/product-review-model";
import type { ProductReviewSection } from "@/commerce/product-review";
import { useT } from "@/i18n/client";

/**
 * The pieces of the review UI that need no script: the stars, the rating line under the product
 * name, and the customer-photograph strip under the price. Markup only; every number arrives decided.
 *
 * Star colour is the brand's caramel at 5.5:1 on cream. The glyphs are decoration: the row is one
 * image whose label says the value in words.
 */

function spokenRating(value: number): string {
  return `${Number.isInteger(value) ? String(value) : formatReviewAverage(value)} trên 5 sao`;
}

export function ReviewStars({
  value,
  className = "",
}: Readonly<{ value: number; className?: string }>) {
  const t = useT();
  return (
    <span
      role="img"
      aria-label={t(spokenRating(value))}
      className={`relative inline-block whitespace-nowrap leading-none tracking-[0.06em] ${className}`}
    >
      <span aria-hidden="true" className="text-[#3B2219]/20">
        ★★★★★
      </span>
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 overflow-hidden text-[#8A5A2B]"
        style={{ width: `${starFillPercent(value)}%` }}
      >
        ★★★★★
      </span>
    </span>
  );
}

/** Under the product name: stars and the average once there are enough reviews, else just the count. */
export function ProductRatingLink({ section }: Readonly<{ section: ProductReviewSection }>) {
  const t = useT();
  const { summary } = section;
  return (
    <a
      href={`#${PRODUCT_REVIEWS_ANCHOR}`}
      data-pdp-rating=""
      className="mt-3 inline-flex min-h-11 flex-wrap items-center gap-x-2 text-sm text-[#3B2219] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#3B2219] lg:mt-1"
    >
      {summary === null ? null : (
        <>
          <ReviewStars value={summary.average} className="text-base" />
          <span className="font-semibold">{formatReviewAverage(summary.average)}</span>
        </>
      )}
      <span className="underline decoration-[#3B2219]/30 underline-offset-[5px]">
        {t(ratingLinkText(section))}
      </span>
      {summary !== null && summary.photoReviewCount > 0 ? (
        <span className="text-[#70584B]">· {t("{count} có ảnh", { count: summary.photoReviewCount })}</span>
      ) : null}
    </a>
  );
}

/**
 * Under the price: a few customer photographs and one tap to the rail they come from. What it says
 * follows its source (`resolveCustomerPhotoStrip`): this product's review photographs, its own tagged
 * photographs, or the shop's shared gallery.
 */
export function CustomerPhotoStrip({ strip }: Readonly<{ strip: CustomerPhotoStripModel }>) {
  return (
    <a
      href={strip.href}
      data-pdp-photo-strip=""
      data-strip-kind={strip.kind}
      className="mt-4 flex items-center gap-3 rounded-lg border border-[#3B2219]/15 bg-[#FFFDFA] px-2.5 py-2 text-[#3B2219] transition-colors hover:border-[#3B2219]/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3B2219]"
    >
      <span className="flex shrink-0" aria-hidden="true">
        {strip.photos.map((src, index) => (
          <span
            key={`${index}-${src}`}
            className={`relative block h-12 w-9 overflow-hidden rounded-[5px] border-2 border-[#FFFDFA] bg-[#D4C7B8] ${index > 0 ? "-ml-2.5" : ""}`}
          >
            <Image src={src} alt="" fill sizes="36px" className="object-cover" />
          </span>
        ))}
      </span>
      <span className="min-w-0 flex-1 text-[13px] leading-snug">
        <span className="block font-semibold">{strip.title}</span>
        <span className="text-xs text-[#70584B]">{strip.subtitle}</span>
      </span>
      <span aria-hidden="true" className="text-lg text-[#70584B]">
        ›
      </span>
    </a>
  );
}
