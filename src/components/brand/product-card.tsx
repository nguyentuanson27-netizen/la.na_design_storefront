import Link from "next/link";

import { ListingCardImage } from "@/components/brand/listing-view";
import { ProductSelectLink } from "@/components/analytics/product-select-link";
import type { ProductCardModel } from "@/components/headless/build-product-card-model";

/**
 * Markup only. Every brand throws this file away and writes its own.
 *
 * It decides how things look and nothing about what is true: no price is computed here, no discount
 * is decided here, and no commerce module is imported. Deleting this file and writing different
 * markup must not turn any test in `tests/domain/` red -- that is the property the split exists to
 * create, and it is what lets a brand redraw the card without touching money logic.
 */

export type ProductCardTone = "stone" | "olive" | "ink" | "sand";

/**
 * How many cards at the head of a listing load their photograph eagerly: the first row of the
 * two-column phone grid, which is what a phone paints first and usually its LCP. Everything after
 * it stays lazy. No `fetchPriority`: on a collection with a cover photograph that is the LCP, and
 * the cards must not outbid it.
 */
export const PRODUCT_CARD_EAGER_COUNT = 2;

export function ProductCard({
  model,
  tone,
  eager = false,
}: {
  model: ProductCardModel;
  tone: ProductCardTone;
  /** The card sits in a listing's first row; see `PRODUCT_CARD_EAGER_COUNT`. */
  eager?: boolean;
}) {
  const {
    price,
    primaryImage,
    hoverImage,
    flashSale,
    lastSizesLeft,
    marketingBadge,
    availabilityLabel,
    lowStockLabel,
  } = model;

  return (
    <article className="group relative">
      <ProductSelectLink
        ariaLabel={`Xem ${model.name}`}
        className="product-visual-link block"
        href={model.href}
        event={model.selectEvent}
      >
        <div
          className={`product-visual product-visual--${tone} relative aspect-[2/3] overflow-hidden`}
          aria-hidden={primaryImage ? undefined : "true"}
        >
          {flashSale || lastSizesLeft || marketingBadge || lowStockLabel ? (
            // One top-right stack that sizes to its tags; the styling lives in `globals.css`.
            <div className="product-tags">
              {flashSale ? (
                <span className="product-tag product-tag--flash">
                  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M13.5 2 4 13.5h6.5L9.5 22 20 9.5h-6.8L13.5 2Z" />
                  </svg>
                  FLASH SALE
                </span>
              ) : null}
              {lastSizesLeft ? (
                <span className="product-tag product-tag--clearance">Lẻ size - Chỉ còn ít</span>
              ) : null}
              {marketingBadge ? (
                <span className={`product-tag product-tag--${marketingBadge.type}`}>
                  {marketingBadge.label}
                </span>
              ) : null}
              {lowStockLabel ? (
                <span className="product-tag product-tag--low-stock">{lowStockLabel}</span>
              ) : null}
            </div>
          ) : null}
          {primaryImage ? (
            <>
              <ListingCardImage
                src={primaryImage.url}
                alt={primaryImage.alt || model.name}
                fill
                loading={eager ? "eager" : undefined}
                className={`object-cover transition-all duration-500 ${
                  hoverImage
                    ? "group-hover:opacity-0 group-hover:scale-105"
                    : "group-hover:scale-105"
                }`}
              />
              {hoverImage ? (
                <ListingCardImage
                  src={hoverImage.url}
                  alt=""
                  aria-hidden="true"
                  fill
                  className="object-cover opacity-0 transition-all duration-500 group-hover:opacity-100 group-hover:scale-105"
                />
              ) : null}
            </>
          ) : (
            <span className="garment-silhouette" />
          )}
        </div>
        <div className="product-meta">
          <h2 className="product-title font-display text-[15px] font-normal leading-snug text-[#2A1810] line-clamp-2 md:text-[17px]">
            {model.name}
          </h2>
          {flashSale ? (
            <>
              {/* The FLASH SALE tag rides on the photograph; only the time left stays here. */}
              {flashSale.countdownText ? (
                <p className="product-countdown">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <circle cx="12" cy="13" r="8" />
                    <path d="M12 9v4l2.5 2.5M9 2h6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {flashSale.countdownText}
                </p>
              ) : null}
              <p className="product-price font-display flex flex-wrap items-baseline justify-center gap-x-2 gap-y-1 text-[15px] md:text-base">
                <span className="sr-only">Giá gốc</span>
                <del className="font-normal text-[#70584B] line-through">{price.compareAtText}</del>
                <span className="sr-only">Giá Flash Sale</span>
                <strong className="font-semibold text-[#9A3324]">{price.displayText}</strong>
              </p>
            </>
          ) : price.compareAtText ? (
            <p className="product-price font-display flex flex-wrap items-baseline justify-center gap-x-2 gap-y-1 text-[15px] md:text-base">
              <span className="sr-only">Giá gốc</span>
              <del className="font-normal text-[#70584B] line-through">{price.compareAtText}</del>
              <span className="sr-only">{price.isListReference ? "Giá giảm" : "Giá khuyến mãi"}</span>
              <strong className="font-semibold text-[#9A3324]">{price.displayText}</strong>
            </p>
          ) : (
            <p className="product-price font-display text-[15px] font-semibold text-[#3B2219] md:text-base">
              {price.displayText}
            </p>
          )}
          {/* F8a — availability, from the canonical projection. F5 reserved this slot and forbade
              deducing it from raw stock, which is why the model resolves it through
              `resolveVariantSellability()`. It is a separate element from the marketing badge
              above on purpose: §30 forbids the marketing badge priority hiding the preorder state,
              so both can render at once. Text, not colour, carries the state. */}
          {availabilityLabel ? (
            <p className="product-availability font-sans text-xs font-semibold uppercase tracking-[0.12em] text-[#70584B]">
              {availabilityLabel}
            </p>
          ) : null}
        </div>
      </ProductSelectLink>
      {model.tryOnHref ? (
        // Beside the card's own link, never inside it: a link inside a link is invalid, and the card
        // must still open the product on a plain tap. The box is the photograph's frame (2:3), so the
        // mark sits on its bottom right whatever the card's text below does.
        <div className="pointer-events-none absolute inset-x-0 top-0 aspect-[2/3]">
          <Link
            href={model.tryOnHref}
            className="product-tryon-mark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3B2219]"
            aria-label={`Thử đồ AI với ${model.name}`}
            title="Thử đồ AI"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.25"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="7.5" r="3.5" />
              <path d="M5 20.5c.6-3.8 3.4-6 7-6s6.4 2.2 7 6" />
            </svg>
          </Link>
        </div>
      ) : null}
    </article>
  );
}
