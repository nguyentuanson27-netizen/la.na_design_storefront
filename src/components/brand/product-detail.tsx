"use client";

import type { ReactNode } from "react";

import type { StorefrontProductMedia } from "@/commerce/product-media";
import { BrandProductGallery } from "@/components/brand/product-gallery";
import { PurchasePanelView } from "@/components/brand/purchase-panel";
import {
  useVariantSelection,
  type UseVariantSelectionInput,
} from "@/components/headless/use-variant-selection";
import type { ProductMappedSizeGuide } from "@/routes/product-model";

/**
 * The product detail's client coordinator: one selection, two components.
 *
 * `useVariantSelection` is called here and only here. The panel renders that controller, and the
 * gallery is handed the variant it resolved plus the product's server-built variant-to-gallery map,
 * so choosing a colour moves the photograph. Calling the hook inside each component instead would
 * give the page two selections that drift apart on the first click.
 *
 * Everything static about the product -- the heading, the editorial copy, the size and care notes --
 * stays server-rendered and arrives through the two slots, so becoming a client component here does
 * not drag the whole article across the boundary.
 */

type BrandProductDetailProps = Readonly<{
  selection: UseVariantSelectionInput;
  media: StorefrontProductMedia;
  productName: string;
  /** Server-resolved from a `?variant=` deep link; the gallery clamps anything out of range. */
  initialGalleryIndex: number;
  galleryIndexByVariantId: Readonly<Record<string, number>>;
  sizeGuide: ProductMappedSizeGuide | null;
  beforePanel: ReactNode;
  afterPanel: ReactNode;
  /** The canonical first image is already rendered as the page hero. */
  excludeFirstImage?: boolean;
}>;

export function BrandProductDetail({
  selection,
  media,
  productName,
  initialGalleryIndex,
  galleryIndexByVariantId,
  sizeGuide,
  beforePanel,
  afterPanel,
  excludeFirstImage = false,
}: BrandProductDetailProps) {
  const controller = useVariantSelection(selection);
  const galleryMedia = excludeFirstImage
    ? Object.freeze({ primary: media.gallery[1] ?? null, gallery: Object.freeze(media.gallery.slice(1)) })
    : media;
  const remainingGalleryIndexByVariantId = excludeFirstImage
    ? Object.freeze(
        Object.fromEntries(
          Object.entries(galleryIndexByVariantId)
            .filter(([, index]) => index > 0)
            .map(([variantId, index]) => [variantId, index - 1]),
        ),
      )
    : galleryIndexByVariantId;
  const remainingInitialGalleryIndex =
    excludeFirstImage && initialGalleryIndex > 0 ? initialGalleryIndex - 1 : 0;
  const showGallery = !excludeFirstImage || galleryMedia.gallery.length > 0;

  return (
    <div className="mt-7 grid min-w-0 gap-10 border-t border-black/20 pt-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)] lg:gap-16">
      {showGallery ? (
        <BrandProductGallery
          media={galleryMedia}
          productName={productName}
          initialIndex={remainingInitialGalleryIndex}
          selectedVariantId={controller.view.selectedVariantId}
          galleryIndexByVariantId={remainingGalleryIndexByVariantId}
          preloadFirstImage={!excludeFirstImage}
        />
      ) : null}

      <article className="min-w-0 pb-10 lg:col-start-2 lg:pt-4">
        {beforePanel}
        <div className="contents">
          <PurchasePanelView controller={controller} sizeGuide={sizeGuide} />
        </div>
        {afterPanel}
      </article>
    </div>
  );
}
