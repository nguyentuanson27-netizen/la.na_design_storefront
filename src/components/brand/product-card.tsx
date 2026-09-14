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
  const { price, primaryImage, hoverImage, flashSale } = model;
  const discountPercent = price.discountPercent ?? 0;

  return (
    <article className="group">
      <ProductSelectLink
        ariaLabel={`Xem ${model.name}`}
        className="product-visual-link block"
        href={model.href}
        event={model.selectEvent}
      >
        <div
          className={`product-visual product-visual--${tone} relative aspect-[3/4] overflow-hidden`}
          aria-hidden={primaryImage ? undefined : "true"}
        >
          {discountPercent > 0 ? (
            <span className="product-badge product-badge--sale z-10">-{discountPercent}%</span>
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
        {/* The catalog card carries price only: the photo already identifies the garment, and
            name, editorial copy and stock state are the product page's job. The name stays in
            the document but out of sight so the heading outline, assistive tech and crawlers
            still read the card as this product. */}
        <div className="product-meta">
          <h2 className="sr-only">{model.name}</h2>
          {flashSale ? (
            <>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[0.68rem] font-semibold uppercase tracking-[0.12em]">
                <span className="bg-black px-2 py-1 text-white">FLASH SALE</span>
                {flashSale.countdownText ? (
                  <span className="text-black/70">{flashSale.countdownText}</span>
                ) : null}
              </div>
              <p className="product-price mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="sr-only">Giá gốc</span>
                <del className="text-black/60 line-through">{price.compareAtText}</del>
                <span className="sr-only">Giá Flash Sale</span>
                <strong className="font-semibold text-black">{price.displayText}</strong>
              </p>
            </>
          ) : price.compareAtText ? (
            <p className="product-price flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="sr-only">Giá gốc</span>
              <del className="font-normal text-black/50 line-through">{price.compareAtText}</del>
              <span className="sr-only">Giá khuyến mãi</span>
              <strong className="font-semibold text-black">{price.displayText}</strong>
            </p>
          ) : (
            <p className="product-price">{price.displayText}</p>
          )}
        </div>
      </ProductSelectLink>
    </article>
  );
}
