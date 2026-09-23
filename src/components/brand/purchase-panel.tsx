"use client";

import Image from "next/image";
import { createPortal } from "react-dom";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";

import {
  useVariantSelection,
  type PurchaseAttemptResult,
  type UseVariantSelectionInput,
  type VariantSelectionController,
  OUT_OF_STOCK_LABEL,
} from "@/components/headless/use-variant-selection";
import { handleDrawerFocusTrap } from "@/components/headless/cart-drawer-model";
import { requestStorefrontCartDrawerOpen } from "@/components/headless/cart-drawer-events";
import { resolveMobilePurchasePresentation } from "@/components/headless/variant-selection-model";
import { useScrollLock } from "@/components/headless/use-scroll-lock";
import type { ProductMappedSizeGuide } from "@/routes/product-model";

/**
 * Brand PDP purchase presentation.
 *
 * Price, selected variant and purchase eligibility all come from the shared selection controller.
 * This component owns only presentation/focus: desktop and mobile controls call the same controller
 * methods, so neither surface can drift into a second selection or cart path.
 */

/**
 * The selectable chip every variant control wears.
 *
 * Master spec §9 / refinement spec "Visual language": the warm brown-on-cream pairing, not the
 * generic pure black/white one, and a focus ring that stays visible on both.
 */
const SELECTABLE_CHIP =
  "flex min-h-11 min-w-11 items-center justify-center border border-transparent bg-[#3B2219]/5 px-4 text-sm font-medium text-[#3B2219] transition-colors peer-checked:border-[#3B2219] peer-checked:bg-[#3B2219] peer-checked:font-semibold peer-checked:text-[#F5F0E8] peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[#3B2219] peer-disabled:cursor-not-allowed";

const DISABLED_CHIP = "peer-disabled:opacity-50";

const UNRESOLVED_SIZE_CHIP =
  "border-dashed border-[#3B2219]/35 bg-[#3B2219]/5 text-[#3B2219]/65";

const DIALOG_FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function MappedSizeGuideDialog({
  guide,
  dialogRef,
  closeButtonRef,
  onClose,
}: Readonly<{
  guide: ProductMappedSizeGuide;
  dialogRef: RefObject<HTMLDialogElement | null>;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}>) {
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
    <dialog
      ref={dialogRef}
      aria-label={`Hướng dẫn chọn size: ${guide.chart.title}`}
      data-size-guide-id={guide.id}
      tabIndex={-1}
      className="m-auto max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-2xl overflow-hidden border-0 bg-transparent p-0 text-black shadow-none backdrop:bg-black/45 sm:max-h-[calc(100dvh-2rem)] sm:w-[calc(100%-2rem)]"
      onClose={onClose}
      onKeyDown={containFocus}
    >
      <div className="relative flex max-h-[calc(100dvh-1rem)] min-h-0 items-center justify-center sm:max-h-[calc(100dvh-2rem)]">
        <button
          ref={closeButtonRef}
          type="button"
          className="absolute right-2 top-2 z-10 min-h-11 bg-[#FAF7F2] px-3 text-sm font-semibold underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3B2219]"
          onClick={closeDialog}
        >
          Đóng
        </button>

        {/*
          The artwork already contains the visible chart title and shopper guidance. Keep the same
          guidance plus the machine-readable table in the accessibility tree so removing duplicate
          visual chrome does not turn the image into the only source of those facts.
        */}
        <div className="sr-only">
          <p>{guide.circumferenceSemanticsNote}</p>
          {guide.tolerance ? (
            <p>
              <strong>Dung sai:</strong> {guide.tolerance.note}
            </p>
          ) : null}
          <p>{guide.guidanceNote}</p>

          <table>
            <caption>{`Dữ liệu bảng size ${guide.chart.title}`}</caption>
            <thead>
              <tr>
                <th scope="col">Thông số</th>
                {guide.chart.sizes.map((size) => (
                  <th key={size} scope="col">
                    {size}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {guide.chart.rows.map((row) => (
                <tr key={row.parameter}>
                  <th scope="row">{row.parameter}</th>
                  {guide.chart.sizes.map((size) => (
                    <td key={size}>{row.values[size]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <Image
          src={`/brand/size-guides/${guide.id}.webp`}
          alt=""
          width={500}
          height={500}
          sizes="(max-width: 640px) calc(100vw - 1rem), 500px"
          unoptimized
          className="h-auto max-h-[calc(100dvh-1rem)] w-auto max-w-full object-contain sm:max-h-[calc(100dvh-2rem)]"
        />
      </div>
    </dialog>
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
  const mobilePresentation = resolveMobilePurchasePresentation(view, selection);

  const sizeSelectorRef = useRef<HTMLFieldSetElement | null>(null);
  const stickyTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const sheetCloseRef = useRef<HTMLButtonElement | null>(null);
  const sheetSizeGuideTriggerRef = useRef<HTMLButtonElement | null>(null);
  const mainSizeGuideTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sizeGuideDialogRef = useRef<HTMLDialogElement | null>(null);
  const sizeGuideCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const sizeGuideSourceRef = useRef<"main" | "sheet" | null>(null);
  const sheetWasOpenRef = useRef(false);
  const suppressSheetFocusRestoreRef = useRef(false);
  const sheetInitialFocusRef = useRef<"close" | "size-guide">("close");

  const [isSheetOpen, setIsSheetOpen] = useState(false);

  useScrollLock(isSheetOpen);

  const awaitsKindSelection = view.kindSelectionGuidance !== null;
  const selectedKindLabel =
    selection.kindKey === null
      ? null
      : view.kinds.find((choice) => choice.key === selection.kindKey)?.label ?? null;

  function renderSelectorLegend(label: string, selectedValue: string | null) {
    return (
      <legend className="text-sm font-medium leading-5 text-[#3B2219]">
        <span>{label}</span>
        {selectedValue === null ? null : (
          <span aria-hidden="true">
            {": "}
            <span className="font-semibold text-[#2A1810]">{selectedValue}</span>
          </span>
        )}
      </legend>
    );
  }

  function runPurchase(action: () => PurchaseAttemptResult) {
    if (action() === "missing-size") {
      const selector = sizeSelectorRef.current;
      selector?.scrollIntoView({ block: "center", inline: "nearest" });
      selector?.focus({ preventScroll: true });
    }
  }

  function openSheet() {
    sheetInitialFocusRef.current = "close";
    setIsSheetOpen(true);
  }

  function closeSheet() {
    setIsSheetOpen(false);
  }

  function handleSheetKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSheet();
      return;
    }
    if (event.key === "Tab") {
      handleDrawerFocusTrap(event.nativeEvent, sheetRef.current);
    }
  }

  useEffect(() => {
    if (isSheetOpen) {
      sheetWasOpenRef.current = true;
      const timer = setTimeout(() => {
        if (sheetInitialFocusRef.current === "size-guide") {
          sheetSizeGuideTriggerRef.current?.focus();
          sheetInitialFocusRef.current = "close";
        } else {
          sheetCloseRef.current?.focus();
        }
      }, 0);
      return () => clearTimeout(timer);
    }

    if (!sheetWasOpenRef.current) return;
    sheetWasOpenRef.current = false;

    if (suppressSheetFocusRestoreRef.current) {
      suppressSheetFocusRestoreRef.current = false;
      return;
    }

    stickyTriggerRef.current?.focus();
  }, [isSheetOpen]);

  function showMainSizeGuide() {
    const dialog = sizeGuideDialogRef.current;
    if (!dialog || dialog.open) return;
    sizeGuideSourceRef.current = "main";
    dialog.showModal();
    sizeGuideCloseButtonRef.current?.focus();
  }

  function showSheetSizeGuide() {
    if (sizeGuide === null) return;
    sizeGuideSourceRef.current = "sheet";
    suppressSheetFocusRestoreRef.current = true;
    setIsSheetOpen(false);
    window.requestAnimationFrame(() => {
      const dialog = sizeGuideDialogRef.current;
      if (!dialog || dialog.open) return;
      dialog.showModal();
      sizeGuideCloseButtonRef.current?.focus();
    });
  }

  function renderSizeGuideTrigger(surface: "panel" | "sheet") {
    if (sizeGuide === null) return null;

    const isPanel = surface === "panel";
    return (
      <div className="mt-3">
        <button
          ref={isPanel ? mainSizeGuideTriggerRef : sheetSizeGuideTriggerRef}
          type="button"
          className="inline-flex min-h-11 items-center text-sm font-semibold underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-black"
          onClick={isPanel ? showMainSizeGuide : showSheetSizeGuide}
        >
          Hướng dẫn chọn size
        </button>
      </div>
    );
  }

  function handleSizeGuideClose() {
    if (sizeGuideSourceRef.current === "sheet") {
      sizeGuideSourceRef.current = null;
      sheetInitialFocusRef.current = "size-guide";
      setIsSheetOpen(true);
      return;
    }
    sizeGuideSourceRef.current = null;
    mainSizeGuideTriggerRef.current?.focus();
  }

  function handleSheetAddAccepted() {
    suppressSheetFocusRestoreRef.current = true;
    setIsSheetOpen(false);
    window.requestAnimationFrame(() => {
      requestStorefrontCartDrawerOpen();
    });
  }

  function handleStickyAction() {
    if (!mobilePresentation.readyToAdd) {
      openSheet();
      return;
    }
    runPurchase(() => addToBag(requestStorefrontCartDrawerOpen));
  }

  /**
   * The radio group name for one dimension on one surface.
   *
   * The panel is the server-rendered surface, so it keeps the canonical names -- the deep-link and
   * structured-data HTTP smokes read the served markup for `name="storefront-size"` to prove which
   * option the *server* preselected, and a renamed group makes both the positive and the negative
   * assertion match nothing at all. The sheet is a second live copy of the same groups in the same
   * document, so it gets its own names: two copies under one name are one native radio group, and
   * choosing in the sheet would uncheck the panel behind it.
   */
  function groupName(dimension: "kind" | "size" | "color", surface: "panel" | "sheet") {
    return surface === "panel" ? `storefront-${dimension}` : `storefront-${dimension}-sheet`;
  }

  function renderKindFieldset(surface: "panel" | "sheet") {
    if (!view.hasKindOptions) return null;

    return (
      <fieldset className="mt-4">
        {renderSelectorLegend("Loại", selectedKindLabel)}
        <div className="mt-2 flex flex-wrap gap-2">
          {view.kinds.map((choice) => (
            <label key={choice.key} className={choice.disabled ? "cursor-not-allowed" : "cursor-pointer"}>
              <input
                className="peer sr-only"
                type="radio"
                name={groupName("kind", surface)}
                value={choice.key}
                checked={selection.kindKey === choice.key}
                disabled={choice.disabled || isPending}
                onChange={() => chooseKind(choice.key)}
              />
              <span className={`${SELECTABLE_CHIP} ${DISABLED_CHIP}`}>{choice.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
    );
  }

  function renderSizeFieldset(surface: "panel" | "sheet") {
    const sizeErrorId = `storefront-size-error-${surface}`;
    const kindGuidanceId = `storefront-kind-guidance-${surface}`;
    const sizeDescribedBy =
      [sizeValidationMessage ? sizeErrorId : null, awaitsKindSelection ? kindGuidanceId : null]
        .filter((id): id is string => id !== null)
        .join(" ") || undefined;

    return (
      <fieldset
        ref={surface === "panel" ? sizeSelectorRef : undefined}
        tabIndex={surface === "panel" ? -1 : undefined}
        aria-invalid={sizeValidationMessage ? "true" : undefined}
        aria-describedby={sizeDescribedBy}
        className={`mt-4 rounded-sm ${
          sizeValidationMessage ? "outline outline-2 outline-offset-4 outline-[#3B2219]" : ""
        }`}
      >
        {renderSelectorLegend("Kích cỡ", selection.size)}
        {view.kindSelectionGuidance === null ? null : (
          <p id={kindGuidanceId} className="mt-2 max-w-xs text-sm leading-6 text-[#3B2219]">
            {view.kindSelectionGuidance}
          </p>
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          {view.sizes.map((choice) => (
            <label key={choice.value} className={choice.disabled ? "cursor-not-allowed" : "cursor-pointer"}>
              <input
                className="peer sr-only"
                type="radio"
                name={groupName("size", surface)}
                value={choice.value}
                checked={selection.size === choice.value}
                disabled={choice.disabled || isPending}
                onChange={() => chooseSize(choice.value)}
              />
              <span
                className={`${SELECTABLE_CHIP} ${
                  awaitsKindSelection
                    ? UNRESOLVED_SIZE_CHIP
                    : DISABLED_CHIP
                }`}
              >
                {choice.value}
              </span>
            </label>
          ))}
        </div>
        {renderSizeGuideTrigger(surface)}
        {sizeValidationMessage ? (
          <p id={sizeErrorId} className="mt-2 text-sm font-medium text-[#8A3A35]" role="alert">
            {sizeValidationMessage}
          </p>
        ) : null}
      </fieldset>
    );
  }

  function renderColorFieldset(surface: "panel" | "sheet") {
    if (!view.hasColorOptions) return null;

    return (
      <fieldset className="mt-4">
        {renderSelectorLegend("Màu", selection.color)}
        <div className="mt-2 flex flex-wrap gap-2">
          {view.colors.map((choice) => (
            <label key={choice.value} className={choice.disabled ? "cursor-not-allowed" : "cursor-pointer"}>
              <input
                className="peer sr-only"
                type="radio"
                name={groupName("color", surface)}
                value={choice.value}
                checked={selection.color === choice.value}
                disabled={choice.disabled || isPending}
                onChange={() => chooseColor(choice.value)}
              />
              <span className={`${SELECTABLE_CHIP} ${DISABLED_CHIP}`}>{choice.value}</span>
            </label>
          ))}
        </div>
      </fieldset>
    );
  }

  const purchaseStatus =
    message ||
    (view.selectedUnavailableReason === "OUT_OF_STOCK"
      ? OUT_OF_STOCK_LABEL
      : view.unavailableMessage ||
        (!view.hasPurchasableVariant ? "Không có lựa chọn khả dụng ở thời điểm hiện tại." : ""));
  const mobilePurchaseStatus = message || mobilePresentation.unavailableMessage || purchaseStatus;

  return (
    <>
      <section
        aria-label="Mua sản phẩm"
        className="mt-5 border-t border-black/20 pt-5 lg:mt-0 lg:border-t-0 lg:pt-0"
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
                <span className="ml-2 inline-flex items-center bg-[#3B2219] px-2 py-0.5 text-xs font-bold uppercase tracking-[0.1em] text-[#F5F0E8]">
                  -{priceDisplay.discountPercent}%
                </span>
              </>
            ) : (
              priceDisplay.displayText
            )}
          </p>
          {view.preorderLabel === null ? null : (
            <span
              className="preorder-marker inline-flex items-center border border-[#3B2219] px-2 py-0.5 text-xs font-semibold uppercase tracking-[0.1em]"
              data-purchase-state="preorder"
            >
              {view.preorderLabel}
            </span>
          )}
          {view.hasPurchasableVariant ? null : (
            <p className="text-xs uppercase tracking-[0.1em] text-[#3B2219]/70">Chưa thể mua online</p>
          )}
        </div>

        {/*
          The panel is the desktop surface, so it keeps the order PR #51 approved and shipped:
          kind then size then colour where a kind exists, and colour before size where one does
          not. The mobile sheet below states `kind -> size -> colour` uniformly, which is this
          spec's contract for the below-`lg` composition only -- rendering that order here would
          reorder the desktop controls of every product that has no kind.
        */}
        {view.hasKindOptions ? (
          <>
            {renderKindFieldset("panel")}
            {renderSizeFieldset("panel")}
            {renderColorFieldset("panel")}
          </>
        ) : (
          <>
            {renderColorFieldset("panel")}
            {renderSizeFieldset("panel")}
          </>
        )}

        <div className="mt-8 grid grid-cols-2 gap-2">
          <button
            className="min-h-12 w-full border border-[#3B2219] bg-[#3B2219] px-4 text-sm font-semibold text-[#F5F0E8] hover:bg-[#2A1810] hover:border-[#2A1810] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3B2219] disabled:cursor-not-allowed disabled:border-[#3B2219]/20 disabled:bg-[#3B2219]/10 disabled:text-[#3B2219]/45"
            type="button"
            aria-label={view.addToBagAccessibleName}
            disabled={!canAttemptPurchase}
            aria-busy={isPending}
            onClick={() => runPurchase(addToBag)}
          >
            {view.addToBagLabel}
          </button>
          <button
            className="min-h-12 w-full border border-[#3B2219] bg-[#F5F0E8] px-4 text-sm font-semibold text-[#3B2219] hover:bg-[#3B2219] hover:text-[#F5F0E8] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3B2219] disabled:cursor-not-allowed disabled:border-[#3B2219]/20 disabled:bg-[#3B2219]/5 disabled:text-[#3B2219]/45"
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
              {mobilePresentation.summary || mobilePresentation.actionLabel}
            </p>
          </div>
          <button
            ref={stickyTriggerRef}
            className="min-h-11 shrink-0 border border-[#3B2219] bg-[#3B2219] px-4 text-sm font-semibold text-[#F5F0E8] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3B2219] disabled:cursor-not-allowed disabled:border-[#3B2219]/20 disabled:bg-[#3B2219]/10 disabled:text-[#3B2219]/45"
            type="button"
            aria-haspopup={mobilePresentation.readyToAdd ? undefined : "dialog"}
            aria-expanded={mobilePresentation.readyToAdd ? undefined : isSheetOpen}
            aria-busy={isPending}
            disabled={isPending}
            onClick={handleStickyAction}
          >
            {mobilePresentation.actionLabel}
          </button>
        </div>
      </section>

      {isSheetOpen
        ? createPortal(
            <div className="fixed inset-0 z-50" data-mobile-purchase-sheet="">
              <div
                className="absolute inset-0 bg-black/45"
                aria-hidden="true"
                onClick={closeSheet}
              />
              <div
                ref={sheetRef}
                role="dialog"
                aria-modal="true"
                aria-label="Chọn lựa chọn sản phẩm"
                className="absolute inset-x-0 bottom-0 max-h-[88dvh] overflow-hidden rounded-t-2xl bg-[#FAF7F2] shadow-2xl"
                onKeyDown={handleSheetKeyDown}
              >
                <div className="flex items-center justify-between border-b border-black/15 px-5 py-4">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-black/55">
                      Lựa chọn sản phẩm
                    </p>
                    <p className="mt-1 truncate text-sm font-semibold">
                      {mobilePresentation.summary || priceDisplay.displayText}
                    </p>
                  </div>
                  <button
                    ref={sheetCloseRef}
                    type="button"
                    onClick={closeSheet}
                    aria-label="Đóng lựa chọn sản phẩm"
                    className="inline-flex h-11 w-11 shrink-0 items-center justify-center text-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
                  >
                    ×
                  </button>
                </div>

                <div className="max-h-[calc(88dvh-9rem)] overflow-y-auto px-5 pb-5">
                  {renderKindFieldset("sheet")}
                  {renderSizeFieldset("sheet")}
                  {renderColorFieldset("sheet")}

                  <p className="mt-4 min-h-6 text-sm text-black/65" role="status" aria-live="polite">
                    {mobilePurchaseStatus}
                  </p>
                </div>

                <div className="border-t border-black/15 bg-[#FAF7F2] p-4">
                  <button
                    type="button"
                    className="min-h-12 w-full bg-[#3B2219] px-5 text-sm font-semibold text-[#F5F0E8] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3B2219] disabled:cursor-not-allowed disabled:bg-[#3B2219]/15 disabled:text-[#3B2219]/45"
                    disabled={!mobilePresentation.readyToAdd || isPending}
                    aria-busy={isPending}
                    onClick={() => runPurchase(() => addToBag(handleSheetAddAccepted))}
                  >
                    {view.selectedVariantId !== null && !view.canAdd
                      ? mobilePresentation.unavailableMessage || "Lựa chọn này tạm hết"
                      : mobilePresentation.actionLabel}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}

      {sizeGuide === null ? null : (
        <MappedSizeGuideDialog
          guide={sizeGuide}
          dialogRef={sizeGuideDialogRef}
          closeButtonRef={sizeGuideCloseButtonRef}
          onClose={handleSizeGuideClose}
        />
      )}
    </>
  );
}

/** The panel standing alone: owns its own selection state. */
export function BrandPurchasePanel(props: UseVariantSelectionInput) {
  return <PurchasePanelView controller={useVariantSelection(props)} sizeGuide={null} />;
}
