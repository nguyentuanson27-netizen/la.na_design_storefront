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
 * Everything static about the product -- the heading, editorial copy, size/care notes and policy
 * facts -- stays server-rendered and arrives through slots, so becoming a client component here
 * does not drag the whole article across the boundary.
 */

type BrandProductDetailProps = Readonly<{
  selection: UseVariantSelectionInput;
  media: StorefrontProductMedia;
  productName: string;
  galleryIndexByVariantId: Readonly<Record<string, number>>;
  sizeGuide: ProductMappedSizeGuide | null;
  /** Left column, first: name, collection context. */
  identity: ReactNode;
  /** Left column, below the identity: description, material, care. `null` when none truthfully exists. */
  productInformation: ReactNode | null;
  /** Right column, below the panel: shipping and returns. */
  purchaseInformation: ReactNode;
}>;

export function BrandProductDetail({
  selection,
  media,
  productName,
  galleryIndexByVariantId,
  sizeGuide,
  identity,
  productInformation,
  purchaseInformation,
}: BrandProductDetailProps) {
  const controller = useVariantSelection(selection);

  return (
    <>
      <BrandProductMediaStage
        media={media}
        productName={productName}
        selectedVariantId={controller.view.selectedVariantId}
        galleryIndexByVariantId={galleryIndexByVariantId}
      />

      <div className="mx-auto max-w-[1600px] px-6 pb-10 pt-5 md:pb-16 md:pt-7 lg:py-16">
        {/* No trusted photography at all: preserve the existing truthful fallback. */}
        {media.gallery.length > 0 ? null : (
          <div className="max-w-sm">
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
        {/* From `lg` the columns fill independently: the purchase panel spans rows 1-2 and shipping
            and returns sit in row 3, straight under it, while the product information spans rows
            2-4 and the trailing `1fr` row absorbs its height. With it in row 2 alone, a long
            description set row 2's height and pushed shipping far below the panel. */}
        <div className="grid min-w-0 items-start gap-6 lg:mt-7 lg:grid-cols-2 lg:grid-rows-[auto_auto_auto_1fr] lg:gap-x-16 lg:gap-y-10 lg:border-t lg:border-black/20 lg:pt-8">
          <div className="min-w-0 lg:col-start-1 lg:row-start-1">{identity}</div>

          <div className="min-w-0 lg:col-start-2 lg:row-start-1 lg:row-span-2">
            <PurchasePanelView controller={controller} sizeGuide={sizeGuide} />
          </div>

          {/* Omitted entirely rather than rendered empty: a product with no approved editorial
              facts should not contribute a blank cell to the row. */}
          {productInformation === null ? null : (
            <div className="min-w-0 lg:col-start-1 lg:row-start-2 lg:row-span-3">{productInformation}</div>
          )}

          <div className="min-w-0 lg:col-start-2 lg:row-start-3">{purchaseInformation}</div>

        </div>
      </div>
    </>
  );
}
