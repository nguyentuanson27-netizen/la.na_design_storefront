import Image from "next/image";

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

export function ProductCard({
  model,
  tone,
}: {
  model: ProductCardModel;
  tone: ProductCardTone;
}) {
  const { price, primaryImage, hoverImage, flashSale, isClearance, marketingBadge, availabilityLabel } =
    model;

  return (
    <article className="group">
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
          {flashSale || isClearance || marketingBadge ? (
            // One top-left stack that sizes to its tags; the styling lives in `globals.css`.
            <div className="product-tags">
              {flashSale ? (
                <span className="product-tag product-tag--flash">
                  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M13.5 2 4 13.5h6.5L9.5 22 20 9.5h-6.8L13.5 2Z" />
                  </svg>
                  FLASH SALE
                </span>
              ) : null}
              {isClearance ? (
                <span className="product-tag product-tag--clearance">Lẻ size - Chỉ còn ít</span>
              ) : null}
              {marketingBadge ? (
                <span className={`product-tag product-tag--${marketingBadge.type}`}>
                  {marketingBadge.label}
                </span>
              ) : null}
            </div>
          ) : null}
          {primaryImage ? (
            <>
              <Image
                src={primaryImage.url}
                alt={primaryImage.alt || model.name}
                fill
                sizes="(min-width: 1024px) 25vw, 50vw"
                className={`object-cover transition-all duration-500 ${
                  hoverImage
                    ? "group-hover:opacity-0 group-hover:scale-105"
                    : "group-hover:scale-105"
                }`}
              />
              {hoverImage ? (
                <Image
                  src={hoverImage.url}
                  alt=""
                  aria-hidden="true"
                  fill
                  sizes="(min-width: 1024px) 25vw, 50vw"
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
              <span className="sr-only">Giá khuyến mãi</span>
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
    </article>
  );
}
