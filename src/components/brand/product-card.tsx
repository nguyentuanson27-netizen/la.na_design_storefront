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
  const { price, primaryImage, hoverImage, flashSale, marketingBadge, availabilityLabel } = model;

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
          {marketingBadge ? (
            <span
              className={`product-badge product-badge--${marketingBadge.type} absolute top-3 right-3 z-10 px-2 py-1 text-[0.65rem] font-semibold uppercase tracking-wider ${
                marketingBadge.type === "sale"
                  ? "bg-[#3B2219] text-[#FAF7F2]"
                  : marketingBadge.type === "new"
                    ? "bg-[#70584B] text-[#FAF7F2]"
                    : "bg-[#2A1810] text-[#FAF7F2]"
              }`}
            >
              {marketingBadge.label}
            </span>
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
        <div className="product-meta mt-2.5">
          <h2 className="product-title font-serif text-sm md:text-base font-normal leading-snug text-[#2A1810] line-clamp-2">
            {model.name}
          </h2>
          {flashSale ? (
            <>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[0.68rem] font-semibold uppercase tracking-[0.12em]">
                <span className="bg-[#2A1810] px-2 py-0.5 text-[#FAF7F2]">FLASH SALE</span>
                {flashSale.countdownText ? (
                  <span className="text-[#70584B]">{flashSale.countdownText}</span>
                ) : null}
              </div>
              <p className="product-price font-sans mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[15px] sm:text-sm">
                <span className="sr-only">Giá gốc</span>
                <del className="text-[#70584B] line-through">{price.compareAtText}</del>
                <span className="sr-only">Giá Flash Sale</span>
                <strong className="font-semibold text-[#2A1810]">{price.displayText}</strong>
              </p>
            </>
          ) : price.compareAtText ? (
            <p className="product-price font-sans mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[15px] sm:text-sm">
              <span className="sr-only">Giá gốc</span>
              <del className="font-normal text-[#70584B] line-through">{price.compareAtText}</del>
              <span className="sr-only">Giá khuyến mãi</span>
              <strong className="font-semibold text-[#2A1810]">{price.displayText}</strong>
            </p>
          ) : (
            <p className="product-price font-sans mt-1 text-[15px] font-semibold text-[#3B2219] sm:text-sm sm:font-medium">
              {price.displayText}
            </p>
          )}
          {/* F8a — availability, from the canonical projection. F5 reserved this slot and forbade
              deducing it from raw stock, which is why the model resolves it through
              `resolveVariantSellability()`. It is a separate element from the marketing badge
              above on purpose: §30 forbids the marketing badge priority hiding the preorder state,
              so both can render at once. Text, not colour, carries the state. */}
          {availabilityLabel ? (
            <p className="product-availability font-sans mt-1 text-xs font-semibold uppercase tracking-[0.12em] text-[#3B2219]">
              {availabilityLabel}
            </p>
          ) : null}
        </div>
      </ProductSelectLink>
    </article>
  );
}
