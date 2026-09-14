"use client";

import type { ReactNode } from "react";

import type { StorefrontProductMedia } from "@/commerce/product-media";
import { BrandProductGallery } from "@/components/brand/product-gallery";
import { PurchasePanelView } from "@/components/brand/purchase-panel";
import {
  useVariantSelection,
  type UseVariantSelectionInput,
} from "@/components/headless/use-variant-selection";

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
  beforePanel: ReactNode;
  afterPanel: ReactNode;
}>;

export function BrandProductDetail({
  selection,
  media,
  productName,
  initialGalleryIndex,
  galleryIndexByVariantId,
  beforePanel,
  afterPanel,
}: BrandProductDetailProps) {
  const controller = useVariantSelection(selection);

  return (
    <div className="mt-7 grid min-w-0 gap-10 border-t border-black/20 pt-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)] lg:gap-16">
      <BrandProductGallery
        media={media}
        productName={productName}
        initialIndex={initialGalleryIndex}
        selectedVariantId={controller.view.selectedVariantId}
        galleryIndexByVariantId={galleryIndexByVariantId}
      />

      <article className="min-w-0 pb-10 lg:pt-4">
        {beforePanel}
        <div className="mt-10">
          <PurchasePanelView controller={controller} />
        </div>
        {afterPanel}
      </article>
    </div>
  );
}
