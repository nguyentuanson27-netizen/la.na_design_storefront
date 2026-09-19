"use client";

import { useRef, type KeyboardEvent } from "react";

import {
  useVariantSelection,
  type PurchaseAttemptResult,
  type UseVariantSelectionInput,
  type VariantSelectionController,
  OUT_OF_STOCK_LABEL,
} from "@/components/headless/use-variant-selection";
import type { ProductMappedSizeGuide } from "@/routes/product-model";

/**
 * Brand PDP purchase presentation.
 *
 * Price, selected variant and purchase eligibility all come from the shared selection controller.
 * This component owns only presentation/focus: desktop and mobile controls call the same controller
 * methods, so neither surface can drift into a second selection or cart path.
 */

const DIALOG_FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function MappedSizeGuideDialog({ guide }: Readonly<{ guide: ProductMappedSizeGuide }>) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  function openDialog() {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    closeButtonRef.current?.focus();
  }

  function closeDialog() {
    dialogRef.current?.close();
  }

  function containFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== "Tab") return;

    const dialog = dialogRef.current;
    if (!dialog) return;

    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR),
    ).filter((element) => element.getClientRects().length > 0);

    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;

    if (event.shiftKey) {
      if (active === first || !dialog.contains(active)) {
        event.preventDefault();
        last.focus();
      }
      return;
    }

    if (active === last || !dialog.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="absolute right-0 top-2 text-sm font-semibold underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-black"
        onClick={openDialog}
      >
        Hướng dẫn chọn size
      </button>

      <dialog
        ref={dialogRef}
        aria-label={`Hướng dẫn chọn size: ${guide.chart.title}`}
        data-size-guide-id={guide.id}
        tabIndex={-1}
        className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-3xl overflow-hidden border border-black/20 bg-[#FAF7F2] p-0 text-black shadow-2xl backdrop:bg-black/45"
        onClose={() => triggerRef.current?.focus()}
        onKeyDown={containFocus}
      >
        <div className="max-h-[calc(100dvh-2rem)] overflow-y-auto p-5 sm:p-7">
          <div className="flex items-start justify-between gap-6">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-black/55">
                Hướng dẫn chọn size
              </p>
              <h2 className="mt-2 font-serif text-3xl tracking-[-0.03em]">{guide.chart.title}</h2>
            </div>
            <button
              ref={closeButtonRef}
              type="button"
              className="min-h-11 shrink-0 border border-black/30 px-4 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
              onClick={closeDialog}
            >
              Đóng
            </button>
          </div>

          <div className="mt-5 space-y-3 text-sm leading-6 text-black/70">
            <p>{guide.circumferenceSemanticsNote}</p>
            {guide.tolerance ? (
              <p>
                <strong>Dung sai:</strong> {guide.tolerance.note}
              </p>
            ) : null}
            <p>{guide.guidanceNote}</p>
          </div>

          <div className="mt-6 max-w-full overflow-x-auto">
            <table className="w-full min-w-[32rem] border-collapse text-left text-sm">
              <caption className="sr-only">{guide.chart.title}</caption>
              <thead>
                <tr className="border-b border-black/15 bg-black/[0.03]">
                  <th scope="col" className="py-3.5 pr-4 pl-3 font-semibold">
                    Thông số
                  </th>
                  {guide.chart.sizes.map((size) => (
                    <th key={size} scope="col" className="px-4 py-3.5 text-right font-semibold">
                      {size}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-black/10">
                {guide.chart.rows.map((row) => (
                  <tr key={row.parameter}>
                    <th scope="row" className="py-3.5 pr-4 pl-3 font-medium text-black/80">
                      {row.parameter}
                    </th>
                    {guide.chart.sizes.map((size) => (
                      <td key={size} className="px-4 py-3.5 text-right tabular-nums text-black/70">
                        {row.values[size]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </dialog>
    </>
  );
}

export function PurchasePanelView({
  controller,
  sizeGuide,
}: Readonly<{
  controller: VariantSelectionController;
  sizeGuide: ProductMappedSizeGuide | null;
}>) {
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
            <span className="flex min-h-11 items-center border border-black/30 px-4 text-sm transition peer-checked:border-black peer-checked:bg-black peer-checked:text-white peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-black peer-disabled:cursor-not-allowed peer-disabled:opacity-60">
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
            <span className="flex min-h-11 items-center border border-black/30 px-4 text-sm transition peer-checked:border-black peer-checked:bg-black peer-checked:text-white peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-black peer-disabled:cursor-not-allowed peer-disabled:opacity-60">
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
            <span className="flex min-h-11 min-w-12 items-center justify-center border border-black/30 px-4 text-sm transition peer-checked:border-black peer-checked:bg-black peer-checked:text-white peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-black peer-disabled:cursor-not-allowed peer-disabled:opacity-60">
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
      ? OUT_OF_STOCK_LABEL
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
          {view.preorderLabel === null ? null : (
            /* §30 — the availability state itself, not a marketing badge and not the button. It
               sits with the price because that is what the shopper is reading when they decide,
               and it is plain text so the state never depends on colour alone. */
            <span
              className="preorder-marker inline-flex items-center border border-black px-2 py-0.5 text-xs font-semibold uppercase tracking-[0.12em]"
              data-purchase-state="preorder"
            >
              {view.preorderLabel}
            </span>
          )}
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

        {sizeGuide ? (
          <div className="relative h-0">
            <MappedSizeGuideDialog guide={sizeGuide} />
          </div>
        ) : null}

        <div className="mt-8 grid grid-cols-2 gap-2">
          <button
            className="min-h-12 w-full border border-black bg-black px-4 text-sm font-semibold text-white hover:bg-white hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black disabled:cursor-not-allowed disabled:border-black/20 disabled:bg-black/10 disabled:text-black/35"
            type="button"
            aria-label={view.addToBagAccessibleName}
            disabled={!canAttemptPurchase}
            aria-busy={isPending}
            onClick={() => runPurchase(addToBag)}
          >
            {view.addToBagLabel}
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
            aria-label={view.quickAddAccessibleName}
            disabled={!canAttemptPurchase}
            aria-busy={isPending}
            onClick={() => runPurchase(addToBag)}
          >
            {view.addToBagLabel}
          </button>
        </div>
      </section>
    </>
  );
}

/** The panel standing alone: owns its own selection state. */
export function BrandPurchasePanel(props: UseVariantSelectionInput) {
  return <PurchasePanelView controller={useVariantSelection(props)} sizeGuide={null} />;
}
