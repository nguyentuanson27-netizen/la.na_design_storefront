"use client";

import Image from "next/image";

import {
  resolveGalleryModel,
  type GalleryModelInput,
} from "@/components/headless/resolve-gallery-model";

/**
 * F7a presentation only.
 *
 * Trusted URLs, deduplication, caps, variant-to-gallery mapping and fallback decisions stay in the
 * existing media/model boundaries. This component only lays the resolved gallery out editorially.
 */
type BrandProductGalleryProps = Omit<GalleryModelInput, "manualSelection"> & Readonly<{
  /** PDP hero already owns LCP preload; below-fold remaining media must stay lazy. */
  preloadFirstImage?: boolean;
}>;

export function BrandProductGallery({ preloadFirstImage = true, ...props }: BrandProductGalleryProps) {
  const model = resolveGalleryModel(props);

  if (model.mode === "empty") {
    return (
      <div className="min-w-0">
        <div
          className="product-visual product-visual--stone relative aspect-[3/4] overflow-hidden"
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

  if (model.mode === "single") {
    const image = model.activeImage!;

    return (
      <div className="min-w-0">
        <div className="product-visual product-visual--stone relative aspect-[3/4] overflow-hidden">
          <Image
            src={image.url}
            alt={image.alt}
            fill
            preload={preloadFirstImage}
            sizes="(min-width: 1024px) 60vw, 100vw"
            className="object-cover"
          />
        </div>
      </div>
    );
  }

  const editorialImages = [
    model.activeImage!,
    ...model.images.filter((_, index) => index !== model.activeIndex),
  ];

  return (
    <div
      className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-2 lg:gap-4"
      aria-label={model.regionLabel}
    >
      {editorialImages.map((image, index) => (
        <div
          key={image.url}
          className="product-visual product-visual--stone relative aspect-[3/4] min-w-0 overflow-hidden"
        >
          <Image
            src={image.url}
            alt={image.alt || `${props.productName} - Ảnh ${model.images.indexOf(image) + 1}`}
            fill
            preload={preloadFirstImage && index === 0 && model.preloadsActiveImage}
            sizes="(min-width: 1024px) 30vw, 100vw"
            className="object-cover"
          />
        </div>
      ))}
    </div>
  );
}
