"use client";

import type { ReactNode } from "react";

import type { StorefrontProductMedia } from "@/commerce/product-media";
import { BrandProductGallery } from "@/components/brand/product-gallery";
import { BrandProductMediaStage } from "@/components/brand/product-media-stage";
import { PurchasePanelView } from "@/components/brand/purchase-panel";
import {
  useVariantSelection,
  type UseVariantSelectionInput,
} from "@/components/headless/use-variant-selection";
import type { ProductMappedSizeGuide } from "@/routes/product-model";

/**
 * The product detail's client coordinator: one selection, three surfaces.
 *
 * `useVariantSelection` is called here and only here. The panel renders that controller, and both
 * galleries are handed the variant it resolved plus the product's server-built variant-to-gallery
 * map, so choosing a colour moves the photograph. Calling the hook inside each component instead
 * would give the page two selections that drift apart on the first click.
 *
 * Refinement spec §1/§3 reshaped what sits around it. The media stage is now the PDP's first
 * surface for every viewport -- full-bleed, and from `lg` up the whole gallery -- and the
 * information below it is a two-column row rather than a gallery column beside a sticky panel.
 * Below `lg` the old editorial grid still carries images 2..n in the content column, because the
 * mobile composition belongs to its own spec.
 *
 * Everything static about the product -- the heading, the editorial copy, the size and care notes,
 * the breadcrumb -- stays server-rendered and arrives through the slots, so becoming a client
 * component here does not drag the whole article across the boundary.
 */

type BrandProductDetailProps = Readonly<{
  selection: UseVariantSelectionInput;
  media: StorefrontProductMedia;
  productName: string;
  /** Server-resolved from a `?variant=` deep link; the below-`lg` gallery clamps out-of-range. */
  initialGalleryIndex: number;
  galleryIndexByVariantId: Readonly<Record<string, number>>;
  sizeGuide: ProductMappedSizeGuide | null;
  /** Rendered above the information row, inside the page shell. */
  breadcrumb: ReactNode;
  /** Left column, first: name, collection context. */
  identity: ReactNode;
  /** Left column, below the identity: description, material, care -- whatever truthfully exists. */
  productInformation: ReactNode;
  /** Right column, below the panel: shipping and returns. */
  purchaseInformation: ReactNode;
}>;

export function BrandProductDetail({
  selection,
  media,
  productName,
  initialGalleryIndex,
  galleryIndexByVariantId,
  sizeGuide,
  breadcrumb,
  identity,
  productInformation,
  purchaseInformation,
}: BrandProductDetailProps) {
  const controller = useVariantSelection(selection);

  /*
   * The stage owns image 1, so the below-`lg` editorial grid keeps showing what it always showed:
   * everything after it, with the variant map shifted by one to match.
   */
  const hasStage = media.gallery.length > 0;
  const remainingMedia = Object.freeze({
    primary: media.gallery[1] ?? null,
    gallery: Object.freeze(media.gallery.slice(1)),
  });
  const remainingGalleryIndexByVariantId = Object.freeze(
    Object.fromEntries(
      Object.entries(galleryIndexByVariantId)
        .filter(([, index]) => index > 0)
        .map(([variantId, index]) => [variantId, index - 1]),
    ),
  );

  return (
    <>
      <BrandProductMediaStage
        media={media}
        productName={productName}
        selectedVariantId={controller.view.selectedVariantId}
        galleryIndexByVariantId={galleryIndexByVariantId}
      />

      <div className="mx-auto max-w-[1600px] px-6 py-10 md:py-16">
        {breadcrumb}

        {/* No trusted photography at all: the gallery's own truthful fallback, not an invented
            hero. There is no stage to hide it behind, so it stands above the information row. */}
        {hasStage ? null : (
          <div className="mt-7 max-w-sm">
            <BrandProductGallery media={media} productName={productName} preloadFirstImage={false} />
          </div>
        )}

        {/*
          Desktop places the four blocks explicitly rather than letting them flow, because the
          column they belong to and the order they are read in are two different things. The DOM
          order -- media, identity, purchase, product information, shipping -- is the stacked order
          a narrow viewport needs, with price and CTAs directly under the name. At `lg` the purchase
          panel spans both content rows of the right column so a long panel cannot push the
          product's own description down past it.
        */}
        <div className="mt-7 grid min-w-0 items-start gap-10 border-t border-black/20 pt-8 lg:grid-cols-2 lg:gap-x-16 lg:gap-y-10">
          {hasStage && remainingMedia.gallery.length > 0 ? (
            <div className="min-w-0 lg:hidden">
              <BrandProductGallery
                media={remainingMedia}
                productName={productName}
                initialIndex={initialGalleryIndex > 0 ? initialGalleryIndex - 1 : 0}
                selectedVariantId={controller.view.selectedVariantId}
                galleryIndexByVariantId={remainingGalleryIndexByVariantId}
                preloadFirstImage={false}
              />
            </div>
          ) : null}

          <div className="min-w-0 lg:col-start-1 lg:row-start-1">{identity}</div>

          <div className="min-w-0 lg:col-start-2 lg:row-start-1 lg:row-span-2">
            <PurchasePanelView controller={controller} sizeGuide={sizeGuide} />
          </div>

          <article className="min-w-0 lg:col-start-1 lg:row-start-2">{productInformation}</article>

          <div className="min-w-0 lg:col-start-2 lg:row-start-3">{purchaseInformation}</div>
        </div>
      </div>
    </>
  );
}
