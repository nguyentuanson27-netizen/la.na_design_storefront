"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import type { StorefrontProductMedia } from "@/commerce/product-media";
import type { TryOnProvider } from "@/commerce/try-on-provider";
import { BrandProductGallery } from "@/components/brand/product-gallery";
import { BrandProductMediaStage } from "@/components/brand/product-media-stage";
import { PurchasePanelView } from "@/components/brand/purchase-panel";
import { BrandTryOnDialog, BrandTryOnNudge, BrandTryOnTrigger } from "@/components/brand/try-on-dialog";
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
  /** Server-decided virtual try-on entry point; `null` renders nothing and changes nothing else. */
  tryOn: Readonly<{ productSlug: string; provider: TryOnProvider }> | null;
  /** Left column, first: name, collection context. */
  identity: ReactNode;
  /** Left column, below the identity: description, material, care. `null` when none truthfully exists. */
  productInformation: ReactNode | null;
  /** Right column, below the panel: shipping and returns. */
  purchaseInformation: ReactNode;
  /** Inside the panel, under the size guide: chat links for size questions. */
  sizeHelp?: ReactNode;
  /** Inside the panel, under the purchase buttons: payment, returns and shipping facts. */
  purchaseAssurance?: ReactNode;
}>;

export function BrandProductDetail({
  selection,
  media,
  productName,
  galleryIndexByVariantId,
  sizeGuide,
  tryOn,
  identity,
  productInformation,
  purchaseInformation,
  sizeHelp = null,
  purchaseAssurance = null,
}: BrandProductDetailProps) {
  const controller = useVariantSelection(selection);
  // Virtual try-on is only a link on the size-guide line and a dialog: it shares no state with the
  // selection above, so opening, failing or dismissing it cannot change what the shopper buys.
  const [tryOnOpen, setTryOnOpen] = useState(false);
  const tryOnTriggerRef = useRef<HTMLButtonElement | null>(null);
  // Focus returns to whichever control opened the dialog. That is not always the entry point: when
  // the phone reminder opened it, the entry point is by definition above the viewport, and focusing
  // it would leave focus on a control the shopper cannot see.
  const tryOnNudgeOpenRef = useRef<HTMLButtonElement | null>(null);
  const tryOnReturnFocusRef = useRef<HTMLElement | null>(null);
  // The phone-only reminder appears once the shopper has scrolled *past* the entry point (it is
  // above the viewport), not while it is still ahead of them, and can be put away for this visit.
  const [scrolledPastTryOn, setScrolledPastTryOn] = useState(false);
  const [tryOnNudgeDismissed, setTryOnNudgeDismissed] = useState(false);
  const hasTryOn = tryOn !== null;

  useEffect(() => {
    const trigger = tryOnTriggerRef.current;
    if (!hasTryOn || trigger === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry) setScrolledPastTryOn(!entry.isIntersecting && entry.boundingClientRect.top < 0);
    });
    observer.observe(trigger);
    return () => observer.disconnect();
  }, [hasTryOn]);

  function openTryOnFrom(opener: HTMLElement | null) {
    tryOnReturnFocusRef.current = opener;
    setTryOnOpen(true);
  }

  function handleTryOnOpenChange(open: boolean) {
    if (!open) {
      // The dialog moves focus right after this call. If the opener has since gone (the reminder
      // unmounts, or the phone bar is hidden by a resize) fall back to the entry point.
      const opener = tryOnReturnFocusRef.current;
      const usable = opener !== null && opener.isConnected && opener.getClientRects().length > 0;
      if (!usable) tryOnReturnFocusRef.current = tryOnTriggerRef.current;
    }
    setTryOnOpen(open);
  }

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
            <PurchasePanelView
              controller={controller}
              sizeGuide={sizeGuide}
              sizeHelp={sizeHelp}
              assurance={purchaseAssurance}
              mobileNudge={
                // Stays mounted while the dialog is open (the native modal makes it inert), so the
                // button that opened the dialog still exists when focus is given back to it.
                hasTryOn && scrolledPastTryOn && !tryOnNudgeDismissed ? (
                  <BrandTryOnNudge
                    openRef={tryOnNudgeOpenRef}
                    onOpen={() => openTryOnFrom(tryOnNudgeOpenRef.current)}
                    onDismiss={() => setTryOnNudgeDismissed(true)}
                  />
                ) : null
              }
              tryOnTrigger={
                tryOn === null ? null : (
                  <BrandTryOnTrigger triggerRef={tryOnTriggerRef} onOpen={() => openTryOnFrom(tryOnTriggerRef.current)} />
                )
              }
            />
          </div>

          {/* Omitted entirely rather than rendered empty: a product with no approved editorial
              facts should not contribute a blank cell to the row. */}
          {productInformation === null ? null : (
            <div className="min-w-0 lg:col-start-1 lg:row-start-2 lg:row-span-3">{productInformation}</div>
          )}

          <div className="min-w-0 lg:col-start-2 lg:row-start-3">{purchaseInformation}</div>

        </div>
      </div>

      {tryOn === null ? null : (
        <BrandTryOnDialog
          productSlug={tryOn.productSlug}
          productName={productName}
          provider={tryOn.provider}
          open={tryOnOpen}
          onOpenChange={handleTryOnOpenChange}
          returnFocusRef={tryOnReturnFocusRef}
        />
      )}
    </>
  );
}
