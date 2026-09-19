"use client";

import { useRef } from "react";

import {
  useVariantSelection,
  type PurchaseAttemptResult,
  type UseVariantSelectionInput,
  type VariantSelectionController,
} from "@/components/headless/use-variant-selection";

/**
 * Brand PDP purchase presentation.
 *
 * Price, selected variant and purchase eligibility all come from the shared selection controller.
 * This component owns only presentation/focus: desktop and mobile controls call the same controller
 * methods, so neither surface can drift into a second selection or cart path.
 */

export function PurchasePanelView({ controller }: Readonly<{ controller: VariantSelectionController }>) {
  const {
    view,
    selection,
    isPending,
    canAttemptPurchase,
    message,
    sizeValidationMessage,
    chooseKind,
    chooseColor,
    chooseSize,
    addToBag,
    buyNow,
  } = controller;
  const { priceDisplay, availabilityDateLabel } = view;
  const sizeSelectorRef = useRef<HTMLFieldSetElement | null>(null);
  const sizeErrorId = "storefront-size-error";

  function runPurchase(action: () => PurchaseAttemptResult) {
    if (action() === "missing-size") {
      const selector = sizeSelectorRef.current;
      selector?.scrollIntoView({ block: "center", inline: "nearest" });
      selector?.focus({ preventScroll: true });
    }
  }

  const kindFieldset = view.hasKindOptions ? (
    <fieldset className="mt-8">
      <legend className="text-xs font-semibold uppercase tracking-[0.14em]">Loại</legend>
      <div className="mt-3 flex flex-wrap gap-2">
        {view.kinds.map((choice) => (
          <label key={choice.key} className={choice.disabled ? "cursor-not-allowed" : "cursor-pointer"}>
            <input
              className="peer sr-only"
              type="radio"
              name="storefront-kind"
              value={choice.key}
              checked={selection.kindKey === choice.key}
              disabled={choice.disabled || isPending}
              onChange={() => chooseKind(choice.key)}
            />
            <span className="flex min-h-11 items-center border border-black/30 px-4 text-sm transition peer-checked:border-black peer-checked:bg-black peer-checked:text-white peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-black peer-disabled:cursor-not-allowed peer-disabled:opacity-35">
              {choice.label}
            </span>
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
            <input
              className="peer sr-only"
              type="radio"
              name="storefront-color"
              value={choice.value}
              checked={selection.color === choice.value}
              disabled={choice.disabled || isPending}
              onChange={() => chooseColor(choice.value)}
            />
            <span className="flex min-h-11 items-center border border-black/30 px-4 text-sm transition peer-checked:border-black peer-checked:bg-black peer-checked:text-white peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-black peer-disabled:cursor-not-allowed peer-disabled:opacity-35">
              {choice.value}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  ) : null;

  const sizeFieldset = (
    <fieldset
      ref={sizeSelectorRef}
      tabIndex={-1}
      aria-invalid={sizeValidationMessage ? "true" : undefined}
      aria-describedby={sizeValidationMessage ? sizeErrorId : undefined}
      className={`${view.hasKindOptions || view.hasColorOptions ? "mt-7" : "mt-8"} rounded-sm ${sizeValidationMessage ? "outline outline-2 outline-offset-4 outline-black" : ""}`}
    >
      <legend className="text-xs font-semibold uppercase tracking-[0.14em]">Kích cỡ</legend>
      <div className="mt-3 flex flex-wrap gap-2">
        {view.sizes.map((choice) => (
          <label key={choice.value} className={choice.disabled ? "cursor-not-allowed" : "cursor-pointer"}>
            <input
              className="peer sr-only"
              type="radio"
              name="storefront-size"
              value={choice.value}
              checked={selection.size === choice.value}
              disabled={choice.disabled || isPending}
              onChange={() => chooseSize(choice.value)}
            />
            <span className="flex min-h-11 min-w-12 items-center justify-center border border-black/30 px-4 text-sm transition peer-checked:border-black peer-checked:bg-black peer-checked:text-white peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-black peer-disabled:cursor-not-allowed peer-disabled:opacity-35">
              {choice.value}
            </span>
          </label>
        ))}
      </div>
      {sizeValidationMessage ? (
        <p id={sizeErrorId} className="mt-3 text-sm font-medium text-red-800" role="alert">
          {sizeValidationMessage}
        </p>
      ) : null}
    </fieldset>
  );

  const purchaseStatus =
    message ||
    (view.selectedUnavailableReason === "OUT_OF_STOCK"
      ? "Hết hàng"
      : view.unavailableMessage || (!view.hasPurchasableVariant ? "Không có lựa chọn khả dụng ở thời điểm hiện tại." : ""));

  return (
    <>
      <section
        aria-label="Mua sản phẩm"
        className="mt-10 border-t border-black/20 pt-6 lg:sticky lg:top-28"
      >
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
                ? view.hasColorOptions
                  ? "Chọn loại × kích cỡ × màu"
                  : "Chọn loại × kích cỡ"
                : view.hasColorOptions
                  ? "Chọn màu × kích cỡ"
                  : "Chọn kích cỡ"
              : "Chưa thể mua online"}
          </p>
        </div>

        {view.hasKindOptions ? (
          <>
            {kindFieldset}
            {sizeFieldset}
            {colorFieldset}
          </>
        ) : (
          <>
            {colorFieldset}
            {sizeFieldset}
          </>
        )}

        <div className="mt-8 grid grid-cols-2 gap-2">
          <button
            className="min-h-12 w-full border border-black bg-black px-4 text-sm font-semibold text-white hover:bg-white hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black disabled:cursor-not-allowed disabled:border-black/20 disabled:bg-black/10 disabled:text-black/35"
            type="button"
            aria-label="Thêm vào giỏ hàng"
            disabled={!canAttemptPurchase}
            aria-busy={isPending}
            onClick={() => runPurchase(addToBag)}
          >
            Thêm vào giỏ
          </button>
          <button
            className="min-h-12 w-full border border-black bg-white px-4 text-sm font-semibold text-black hover:bg-black hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black disabled:cursor-not-allowed disabled:border-black/20 disabled:bg-black/5 disabled:text-black/35"
            type="button"
            disabled={!canAttemptPurchase}
            aria-busy={isPending}
            onClick={() => runPurchase(buyNow)}
          >
            Mua ngay
          </button>
        </div>

        <p className="mt-3 min-h-6 text-sm text-black/65" role="status" aria-live="polite">
          {purchaseStatus}
        </p>

        {availabilityDateLabel === null ? null : (
          <p className="mt-1 text-xs text-black/55" role="status" aria-live="polite">
            Dự kiến có hàng: {availabilityDateLabel}
          </p>
        )}
      </section>

      <section
        aria-label="Mua nhanh"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-black/20 bg-[#FAF7F2] px-4 pt-3 shadow-[0_-8px_24px_rgba(0,0,0,0.08)] lg:hidden"
        style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
      >
        <div className="mx-auto flex w-full max-w-[42rem] min-w-0 items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{priceDisplay.displayText}</p>
            <p className="mt-0.5 truncate text-xs text-black/60">
              {selection.size ? `Size ${selection.size}` : "Chưa chọn size"}
            </p>
          </div>
          <button
            className="min-h-11 shrink-0 border border-black bg-black px-4 text-sm font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black disabled:cursor-not-allowed disabled:border-black/20 disabled:bg-black/10 disabled:text-black/35"
            type="button"
            aria-label="Thêm vào giỏ từ thanh mua nhanh"
            disabled={!canAttemptPurchase}
            aria-busy={isPending}
            onClick={() => runPurchase(addToBag)}
          >
            Thêm vào giỏ
          </button>
        </div>
      </section>
    </>
  );
}

/** The panel standing alone: owns its own selection state. */
export function BrandPurchasePanel(props: UseVariantSelectionInput) {
  return <PurchasePanelView controller={useVariantSelection(props)} />;
}
