"use client";

import {
  useVariantSelection,
  type UseVariantSelectionInput,
  type VariantSelectionController,
} from "@/components/headless/use-variant-selection";

/**
 * Markup only. Every brand throws this file away and writes its own.
 *
 * No price is computed here and no purchasability is decided here: both come from
 * `useVariantSelection`, which is where they must stay. Nothing is imported from `@/commerce`
 * either -- the panel speaks only the hook's public input and result types.
 *
 * Two entry points, because a PDP needs the selection in two places at once:
 *
 *   - `PurchasePanelView` renders a controller someone else owns. A page that must keep the panel
 *     and the gallery on the same colour calls `useVariantSelection` once in a client coordinator,
 *     passes the result here, and passes `controller.view.selectedVariantId` plus the product's
 *     `galleryIndexByVariantId` to `BrandProductGallery`. One selection state, two components.
 *   - `BrandPurchasePanel` owns the hook itself, for the ordinary case of a panel standing alone.
 *     It is the surface the commerce shim renders, so today's product route is unchanged.
 */

export function PurchasePanelView({ controller }: Readonly<{ controller: VariantSelectionController }>) {
  const { view, selection, isPending, message, chooseKind, chooseColor, chooseSize, addToBag } =
    controller;
  const { priceDisplay } = view;

  const kindFieldset = view.hasKindOptions ? (
    <fieldset className="mt-8">
      <legend className="text-xs font-semibold uppercase tracking-[0.14em]">Loại</legend>
      <div className="mt-3 flex flex-wrap gap-2">
        {view.kinds.map((choice) => (
          <label key={choice.key} className={choice.disabled ? "cursor-not-allowed" : "cursor-pointer"}>
            <input className="peer sr-only" type="radio" name="storefront-kind" value={choice.key} checked={selection.kindKey === choice.key} disabled={choice.disabled || isPending} onChange={() => chooseKind(choice.key)} />
            <span className="flex min-h-11 items-center border border-black/30 px-4 text-sm transition peer-checked:border-black peer-checked:bg-black peer-checked:text-white peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-black peer-disabled:cursor-not-allowed peer-disabled:opacity-35">{choice.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  ) : null;

  const colorFieldset = view.hasColorOptions ? (
    <fieldset className="mt-7">
      <legend className="text-xs font-semibold uppercase tracking-[0.14em]">Màu</legend>
      <div className="mt-3 flex flex-wrap gap-2">
        {view.colors.map((choice) => (
          <label key={choice.value} className={choice.disabled ? "cursor-not-allowed" : "cursor-pointer"}>
            <input className="peer sr-only" type="radio" name="storefront-color" value={choice.value} checked={selection.color === choice.value} disabled={choice.disabled || isPending} onChange={() => chooseColor(choice.value)} />
            <span className="flex min-h-11 items-center border border-black/30 px-4 text-sm transition peer-checked:border-black peer-checked:bg-black peer-checked:text-white peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-black peer-disabled:cursor-not-allowed peer-disabled:opacity-35">{choice.value}</span>
          </label>
        ))}
      </div>
    </fieldset>
  ) : null;

  const sizeFieldset = (
    <fieldset className={view.hasKindOptions ? "mt-7" : view.hasColorOptions ? "mt-7" : "mt-8"}>
      <legend className="text-xs font-semibold uppercase tracking-[0.14em]">Kích cỡ</legend>
      <div className="mt-3 flex flex-wrap gap-2">
        {view.sizes.map((choice) => (
          <label key={choice.value} className={choice.disabled ? "cursor-not-allowed" : "cursor-pointer"}>
            <input className="peer sr-only" type="radio" name="storefront-size" value={choice.value} checked={selection.size === choice.value} disabled={choice.disabled || isPending} onChange={() => chooseSize(choice.value)} />
            <span className="flex min-h-11 min-w-12 items-center justify-center border border-black/30 px-4 text-sm transition peer-checked:border-black peer-checked:bg-black peer-checked:text-white peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-black peer-disabled:cursor-not-allowed peer-disabled:opacity-35">{choice.value}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );

  return (
    <div className="border-t border-black/20 pt-6">
      <div className="flex items-baseline justify-between gap-6">
        <p className="flex flex-wrap items-baseline gap-2 text-xl font-medium tracking-[-0.02em]">
          {priceDisplay.compareAtText ? (
            <>
              <span className="sr-only">Giá gốc </span>
              <span className="mr-1 align-baseline text-base font-normal text-black/60 line-through">
                {priceDisplay.compareAtText}
              </span>
              <span className="sr-only">Giá khuyến mãi </span>
              <span>{priceDisplay.displayText}</span>
              <span className="ml-2 inline-flex items-center bg-black px-2 py-0.5 text-xs font-bold uppercase tracking-[0.1em] text-white">
                -{priceDisplay.discountPercent}%
              </span>
            </>
          ) : (
            priceDisplay.displayText
          )}
        </p>
        <p className="text-xs uppercase tracking-[0.14em] text-black/55">
          {view.hasPurchasableVariant
            ? view.hasKindOptions
              ? view.hasColorOptions ? "Chọn loại × kích cỡ × màu" : "Chọn loại × kích cỡ"
              : view.hasColorOptions ? "Chọn màu × kích cỡ" : "Chọn kích cỡ"
            : "Chưa thể mua online"}
        </p>
      </div>

      {view.hasKindOptions ? <>{kindFieldset}{sizeFieldset}{colorFieldset}</> : <>{colorFieldset}{sizeFieldset}</>}

      <button
        className="mt-8 min-h-12 w-full border border-black bg-black px-6 text-sm font-semibold uppercase tracking-[0.12em] text-white hover:bg-white hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black disabled:cursor-not-allowed disabled:border-black/20 disabled:bg-black/10 disabled:text-black/35"
        type="button"
        disabled={!view.canAdd || isPending}
        onClick={addToBag}
      >
        {isPending ? "Đang thêm…" : "Thêm vào giỏ hàng"}
      </button>

      <p className="mt-3 min-h-6 text-sm text-black/65" role="status" aria-live="polite">
        {message || view.unavailableMessage || (!view.hasPurchasableVariant ? "Không có lựa chọn khả dụng ở thời điểm hiện tại." : "")}
      </p>

      {/*
        I9 — Google requires the availability date to be visible on the landing page beside the
        `backorder` it publishes in the feed, so this line is what makes that row truthful rather
        than a claim only a crawler sees.

        Its own live region, not appended to the status line above: that one carries transient
        add-to-bag feedback, and merging them would let a cart message overwrite a standing fact
        about the selected size. `aria-live="polite"` because the text changes as the shopper
        switches variants, which is exactly a dynamic update a screen-reader user should hear.

        Rendered only when the shared availability resolved a date for the SELECTED variant, so
        owner rule 10's three conditions need no logic here: nothing before a choice is made,
        never another variant's date, and nothing once the cycle has lapsed.
      */}
      {view.selectedAvailabilityDate === null ? null : (
        <p className="mt-1 text-xs text-black/55" role="status" aria-live="polite">
          Dự kiến có hàng: {view.selectedAvailabilityDate}
        </p>
      )}
    </div>
  );
}

/** The panel standing alone: owns its own selection state. */
export function BrandPurchasePanel(props: UseVariantSelectionInput) {
  return <PurchasePanelView controller={useVariantSelection(props)} />;
}
