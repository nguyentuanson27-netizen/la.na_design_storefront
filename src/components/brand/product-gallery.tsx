"use client";

import Image from "next/image";
import { useState } from "react";

import {
  resolveGalleryModel,
  type GalleryManualSelection,
  type GalleryModelInput,
} from "@/components/headless/resolve-gallery-model";

/**
 * Markup only. Every brand throws this file away and writes its own.
 *
 * Which image is on screen, what its alt text reads, whether a thumbnail strip is warranted and
 * which thumbnail is pressed all come from `resolveGalleryModel`. The only state here is the
 * thumbnail the shopper last clicked, tagged with the variant it was clicked for so the model can
 * retire it when the selection moves.
 */

type BrandProductGalleryProps = Omit<GalleryModelInput, "manualSelection">;

export function BrandProductGallery(props: BrandProductGalleryProps) {
  const [manualSelection, setManualSelection] = useState<GalleryManualSelection | null>(null);
  const model = resolveGalleryModel({ ...props, manualSelection });
  const selectedVariantId = props.selectedVariantId ?? null;

  // Fallback state when no trusted photography is present
  if (model.mode === "empty") {
    return (
      <div className="min-w-0 lg:sticky lg:top-28 lg:self-start">
        <div
          className="product-visual product-visual--stone relative aspect-[3/4] overflow-hidden md:min-h-[44rem]"
          aria-hidden="true"
        >
          <span className="garment-silhouette" />
        </div>
        <p className="mt-3 text-xs uppercase tracking-[0.12em] text-black/60">
          Hình ảnh sản phẩm đang được chuẩn hóa cho storefront.
        </p>
      </div>
    );
  }

  const activeImage = model.activeImage!;

  // Single-image presentation (no redundant carousel / thumbnail controls)
  if (model.mode === "single") {
    return (
      <div className="min-w-0 lg:sticky lg:top-28 lg:self-start">
        <div className="product-visual product-visual--stone relative aspect-[3/4] overflow-hidden md:min-h-[44rem]">
          <Image
            src={activeImage.url}
            alt={activeImage.alt}
            fill
            preload
            sizes="(min-width: 1024px) 50vw, 100vw"
            className="object-cover"
          />
        </div>
      </div>
    );
  }

  // Multi-image gallery with interactive accessible thumbnails
  return (
    <div className="min-w-0 lg:sticky lg:top-28 lg:self-start">
      <div
        className="product-visual product-visual--stone relative aspect-[3/4] overflow-hidden md:min-h-[44rem]"
        role="region"
        aria-roledescription="carousel"
        aria-label={model.regionLabel}
      >
        <Image
          key={activeImage.url}
          src={activeImage.url}
          alt={activeImage.alt}
          fill
          preload={model.preloadsActiveImage}
          sizes="(min-width: 1024px) 50vw, 100vw"
          className="object-cover transition-opacity duration-300"
        />
      </div>

      <nav className="mt-4 flex flex-wrap gap-3" aria-label={model.thumbnailsLabel}>
        {model.thumbnails.map((thumbnail) => (
          <button
            key={thumbnail.url}
            type="button"
            onClick={() => setManualSelection({ variantId: selectedVariantId, index: thumbnail.index })}
            aria-label={thumbnail.label}
            aria-pressed={thumbnail.isSelected}
            className={`relative h-20 w-16 overflow-hidden border transition-all ${
              thumbnail.isSelected
                ? "border-black ring-1 ring-black"
                : "border-black/20 opacity-70 hover:opacity-100"
            } focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black`}
          >
            <Image
              src={thumbnail.url}
              alt={thumbnail.alt}
              fill
              sizes="64px"
              className="object-cover"
            />
          </button>
        ))}
      </nav>
    </div>
  );
}
