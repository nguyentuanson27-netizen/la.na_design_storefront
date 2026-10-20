"use client";

import Image from "next/image";
import Link from "next/link";
import { createPortal } from "react-dom";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";

import {
  useVariantSelection,
  type PurchaseAttemptResult,
  type PurchaseOptionDimension,
  type UseVariantSelectionInput,
  type VariantSelectionController,
  ADDED_TO_BAG_MESSAGE,
  OUT_OF_STOCK_LABEL,
} from "@/components/headless/use-variant-selection";
import { handleDrawerFocusTrap } from "@/components/headless/cart-drawer-model";
import {
  describeLowStock,
  formatFlashClock,
  NO_PRODUCT_URGENCY,
  resolveFlashRemainingMs,
  type FlashClock,
  type ProductUrgency,
} from "@/components/headless/product-urgency";
import { useElapsedMs } from "@/components/headless/use-elapsed-ms";
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
 * generic pure black/white one, and a focus ring that stays visible on both. The chip is drawn
 * light and compact -- 32px tall, a soft tint at rest, regular weight, a hairline on hover, the
 * buttons' 6px corner -- so
 * the one filled chip per group reads as the choice without the whole selector shouting.
 *
 * The chip is what the shopper sees; the touch target is its `<label>` (`choiceTarget`), which
 * pads it to the repository's 44px practical target. A block rather than a flex box, so the
 * sentence-case `::first-letter` rule below can apply to it.
 */
const SELECTABLE_CHIP =
  "block min-h-8 min-w-11 whitespace-nowrap rounded-md border border-transparent bg-[#3B2219]/5 px-4 text-center text-sm font-normal leading-[30px] tracking-[0.02em] text-[#3B2219] transition-colors hover:border-[#3B2219]/40 peer-checked:border-[#3B2219] peer-checked:bg-[#3B2219] peer-checked:text-[#F5F0E8] peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[#3B2219] peer-disabled:cursor-not-allowed peer-disabled:hover:border-transparent";

/** A choice briefly locked while a purchase request is in flight. */
const DISABLED_CHIP = "peer-disabled:opacity-50";

/**
 * A choice the catalogue says cannot be bought. Struck through rather than only dimmed, so a sold
 * out option is not mistaken for an unselected one on the tinted chip.
 */
const UNAVAILABLE_CHIP = "opacity-50 line-through decoration-1";

/**
 * Merchant option names arrive in whatever case the back office typed -- often all capitals
 * ("FULL SET", "ÁO LẺ"). Shown in sentence case for a softer read; applied in CSS only, so the
 * DOM text, accessible names and every selector keyed on them stay exactly the merchant's.
 */
const SENTENCE_CASE = "lowercase first-letter:uppercase";

/** The label around each chip: 6px above and below the 32px chip make a 44px touch target. */
function choiceTarget(disabled: boolean) {
  return `py-1.5 ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`;
}

function chipClass(disabled: boolean) {
  return `${SELECTABLE_CHIP} ${disabled ? UNAVAILABLE_CHIP : DISABLED_CHIP}`;
}

function BoltIcon({ className }: Readonly<{ className?: string }>) {
  return (
    <svg aria-hidden="true" focusable={false} className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M13.5 2 4 13.5h6.5L9.5 22 20 9.5h-6.8L13.5 2Z" />
    </svg>
  );
}

function RulerIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <rect x="2.5" y="8" width="19" height="8" rx="1" />
      <path d="M6 8v3M9.5 8v2M13 8v3M16.5 8v2M20 8v3" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

/** The `lg` seam the phone purchase bar lives below, as the media query its observer runs under. */
const BELOW_LG = "(max-width: 1023.98px)";

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

/** The guide's notes and table: visible when there is no artwork, screen-reader-only beside it. */
function SizeGuideFacts({ guide }: { guide: ProductMappedSizeGuide }) {
  return (
    <>
      <p>{guide.circumferenceSemanticsNote}</p>
      {guide.tolerance ? (
        <p>
          <strong>Dung sai:</strong> {guide.tolerance.note}
        </p>
      ) : null}
      <p>{guide.guidanceNote}</p>

      <table className="mt-2 w-full border-collapse text-left text-sm text-black">
        <caption className="sr-only">{`Dữ liệu bảng size ${guide.chart.title}`}</caption>
        <thead>
          <tr className="border-b border-black/15 bg-black/[0.03]">
            <th scope="col" className="py-3 pl-3 pr-4 font-semibold">
              Thông số
            </th>
            {guide.chart.sizes.map((size) => (
              <th key={size} scope="col" className="px-3 py-3 text-right font-semibold">
                {size}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {guide.chart.rows.map((row) => (
            <tr key={row.parameter} className="border-b border-black/10">
              <th scope="row" className="py-3 pl-3 pr-4 font-normal">
                {row.parameter}
              </th>
              {guide.chart.sizes.map((size) => (
                <td key={size} className="px-3 py-3 text-right tabular-nums">
                  {row.values[size]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

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

  /*
   * Below `sm` the artwork is the whole dialog: it spans the phone's full width instead of shrinking
   * to fit the screen height, and a chart taller than the screen scrolls inside the dialog with the
   * close button pinned in view. From `sm` up, and for the drawn fallback, the dialog is unchanged.
   */
  const hasArtwork = guide.imageUrl !== null;

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
      className={`m-auto max-w-2xl border-0 bg-transparent p-0 text-black shadow-none backdrop:bg-black/45 sm:max-h-[calc(100dvh-2rem)] sm:w-[calc(100%-2rem)] ${
        hasArtwork
          ? "max-h-dvh w-full overflow-y-auto sm:overflow-hidden"
          : "max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] overflow-hidden"
      }`}
      onClose={onClose}
      onKeyDown={containFocus}
    >
      <div
        className={`relative flex min-h-0 items-center justify-center sm:max-h-[calc(100dvh-2rem)] ${
          hasArtwork ? "" : "max-h-[calc(100dvh-1rem)]"
        }`}
      >
        <button
          ref={closeButtonRef}
          type="button"
          className={`${hasArtwork ? "fixed sm:absolute" : "absolute"} right-2 top-2 z-10 min-h-11 bg-[#FAF7F2] px-3 text-sm font-semibold underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3B2219]`}
          onClick={closeDialog}
        >
          Đóng
        </button>

        {guide.imageUrl ? (
          <>
            {/*
              The artwork already contains the visible chart title and shopper guidance. Keep the
              same guidance plus the machine-readable table in the accessibility tree so removing
              duplicate visual chrome does not turn the image into the only source of those facts.
            */}
            <div className="sr-only">
              <SizeGuideFacts guide={guide} />
            </div>

            <Image
              src={guide.imageUrl}
              alt=""
              width={1280}
              height={1280}
              sizes="(max-width: 640px) 100vw, (min-width: 1024px) 640px, 500px"
              className="h-auto w-full object-contain sm:max-h-[calc(100dvh-2rem)] sm:w-auto sm:max-w-full lg:w-[min(40rem,calc(100dvh-2rem))]"
            />
          </>
        ) : (
          // No artwork set in admin: draw the same guide from its configured data.
          <div className="max-h-[calc(100dvh-1rem)] w-full overflow-y-auto bg-[#FAF7F2] px-5 pb-6 pt-14 sm:max-h-[calc(100dvh-2rem)] sm:px-8">
            <h2 className="font-display text-2xl tracking-[-0.02em]">{guide.chart.title}</h2>
            <div className="mt-4 space-y-2 text-sm leading-6 text-black/70">
              <SizeGuideFacts guide={guide} />
            </div>
          </div>
        )}
      </div>
    </dialog>
  );
}

export function PurchasePanelView({
  controller,
  productName = "",
  sizeGuide,
  tryOnTrigger = null,
  mobileNudge = null,
  sizeHelp = null,
  assurance = null,
  offers = null,
  urgency = NO_PRODUCT_URGENCY,
}: Readonly<{
  controller: VariantSelectionController;
  /** Named on the phone purchase bar while nothing is chosen yet, since the heading is above the fold. */
  productName?: string;
  sizeGuide: ProductMappedSizeGuide | null;
  /**
   * Optional entry point that shares the size guide's line (virtual try-on). It opens its own dialog
   * elsewhere and shares no state with this panel; it appears on the panel only, not in the options sheet.
   */
  tryOnTrigger?: ReactNode;
  /** Floats just above the phone purchase bar (e.g. a reminder of try-on); absolutely placed, so it never resizes the bar. */
  mobileNudge?: ReactNode;
  /** Server-built ways to ask the shop about size (chat links), under the size guide on the panel only. */
  sizeHelp?: ReactNode;
  /** Server-built buying facts (payment, returns, shipping), directly under the purchase buttons. */
  assurance?: ReactNode;
  /** Server-built promotions this product takes part in, directly under the price. */
  offers?: ReactNode;
  /** Server-decided Flash Sale countdown and "Còn x" facts; none by default. */
  urgency?: ProductUrgency;
}>) {
  const {
    view,
    selection,
    isPending,
    canAttemptPurchase,
    message,
    validation,
    chooseKind,
    chooseColor,
    chooseSize,
    addToBag,
    buyNow,
    promptForKind,
  } = controller;
  const { priceDisplay, availabilityDateLabel } = view;
  // One clock for the page, ticking only while something is on Flash Sale. The countdown follows the
  // chosen variant's own campaign, and disappears for a variant no Flash Sale prices.
  const elapsedMs = useElapsedMs(urgency.flash !== null);
  const flashRemainingMs = resolveFlashRemainingMs(urgency, view.selectedVariantId);
  const flashClock = flashRemainingMs === null ? null : formatFlashClock(flashRemainingMs - elapsedMs);
  const lowStockLabel = describeLowStock(urgency, {
    variantId: view.selectedVariantId,
    size: selection.size,
  });
  const mobilePresentation = resolveMobilePurchasePresentation(view, selection);
  const justAdded = message === ADDED_TO_BAG_MESSAGE;

  // Each option group on each surface, so a purchase attempt can take the shopper to the one missing.
  const fieldsetRefs = useRef<Record<"panel" | "sheet", Partial<Record<PurchaseOptionDimension, HTMLFieldSetElement | null>>>>({
    panel: {},
    sheet: {},
  });
  const panelActionsRef = useRef<HTMLDivElement | null>(null);
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
  /*
   * UX-02, the rule the cart and checkout bars already follow: one primary purchase control on
   * screen at a time. While the panel's own buttons are in view the phone bar steps aside; it comes
   * back as soon as they scroll away. It starts shown, so the server-rendered page and a browser
   * without IntersectionObserver keep the bar.
   */
  const [panelActionsInView, setPanelActionsInView] = useState(false);

  useScrollLock(isSheetOpen);

  useEffect(() => {
    const actions = panelActionsRef.current;
    if (actions === null || typeof IntersectionObserver === "undefined") return;
    const query = window.matchMedia(BELOW_LG);
    let observer: IntersectionObserver | null = null;
    const sync = () => {
      observer?.disconnect();
      observer = null;
      if (!query.matches) {
        setPanelActionsInView(false);
        return;
      }
      observer = new IntersectionObserver(([entry]) => setPanelActionsInView(entry?.isIntersecting ?? false));
      observer.observe(actions);
    };
    sync();
    query.addEventListener("change", sync);
    return () => {
      query.removeEventListener("change", sync);
      observer?.disconnect();
    };
  }, []);

  const awaitsKindSelection = view.kindSelectionGuidance !== null;
  const selectedKindLabel =
    selection.kindKey === null
      ? null
      : view.kinds.find((choice) => choice.key === selection.kindKey)?.label ?? null;

  function setFieldsetRef(surface: "panel" | "sheet", dimension: PurchaseOptionDimension) {
    return (element: HTMLFieldSetElement | null) => {
      fieldsetRefs.current[surface][dimension] = element;
    };
  }

  function focusOptionGroup(surface: "panel" | "sheet", dimension: PurchaseOptionDimension) {
    const group = fieldsetRefs.current[surface][dimension];
    group?.scrollIntoView({ block: "center", inline: "nearest" });
    group?.focus({ preventScroll: true });
  }

  /** The error line, outline and description a group wears while its choice is being asked for. */
  function validationFor(dimension: PurchaseOptionDimension, surface: "panel" | "sheet") {
    const text = validation[dimension];
    const id = `storefront-${dimension}-error-${surface}`;
    return {
      text,
      id,
      invalid: text ? ("true" as const) : undefined,
      outline: text ? "outline outline-2 outline-offset-4 outline-[#3B2219]" : "",
      line: text ? (
        <p id={id} className="mt-2 text-sm font-medium text-[#8A3A35]" role="alert">
          {text}
        </p>
      ) : null,
    };
  }

  function renderSelectorLegend(label: string, selectedValue: string | null) {
    // Sizes are codes ("XL", "2XL") and keep their case; the named axes read as words.
    const valueCase = label === "Kích cỡ" ? "" : `inline-block ${SENTENCE_CASE}`;
    return (
      <legend className="text-sm leading-5 text-[#3B2219]/70">
        <span>{label}</span>
        {selectedValue === null ? null : (
          <span aria-hidden="true">
            {": "}
            <span className={`font-medium text-[#2A1810] ${valueCase}`}>{selectedValue}</span>
          </span>
        )}
      </legend>
    );
  }

  function runPurchase(surface: "panel" | "sheet", action: () => PurchaseAttemptResult | null) {
    const result = action();
    if (result === "missing-kind") focusOptionGroup(surface, "kind");
    else if (result === "missing-color") focusOptionGroup(surface, "color");
    else if (result === "missing-size") focusOptionGroup(surface, "size");
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
    const isPanel = surface === "panel";
    const extra = isPanel ? tryOnTrigger : null;
    if (sizeGuide === null && extra === null) return null;

    return (
      <div className="mt-0.5 flex flex-wrap items-center gap-x-6">
        {sizeGuide === null ? null : (
          <button
            ref={isPanel ? mainSizeGuideTriggerRef : sheetSizeGuideTriggerRef}
            type="button"
            className="group inline-flex min-h-11 items-center gap-2 text-sm text-[#3B2219] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#3B2219]"
            onClick={isPanel ? showMainSizeGuide : showSheetSizeGuide}
          >
            <RulerIcon />
            <span className="underline decoration-[#3B2219]/30 underline-offset-[5px] transition-colors group-hover:decoration-[#3B2219]">
              Hướng dẫn chọn size
            </span>
          </button>
        )}
        {extra}
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

  function handleViewCartClick(event: MouseEvent<HTMLAnchorElement>) {
    // Leave "open in new tab" and friends to the browser; a plain tap opens the existing drawer.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    requestStorefrontCartDrawerOpen();
  }

  function handleStickyAction() {
    if (!mobilePresentation.readyToAdd) {
      openSheet();
      return;
    }
    runPurchase("panel", () => addToBag(requestStorefrontCartDrawerOpen));
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
    const check = validationFor("kind", surface);

    return (
      <fieldset
        ref={setFieldsetRef(surface, "kind")}
        tabIndex={-1}
        aria-invalid={check.invalid}
        aria-describedby={check.text ? check.id : undefined}
        className={`mt-3.5 rounded-sm ${check.outline}`}
      >
        {renderSelectorLegend("Loại", selectedKindLabel)}
        <div className="mt-0.5 flex flex-wrap gap-x-2">
          {view.kinds.map((choice) => (
            <label key={choice.key} className={choiceTarget(choice.disabled)}>
              <input
                className="peer sr-only"
                type="radio"
                name={groupName("kind", surface)}
                value={choice.key}
                checked={selection.kindKey === choice.key}
                disabled={choice.disabled || isPending}
                onChange={() => chooseKind(choice.key)}
              />
              <span className={`${chipClass(choice.disabled)} ${SENTENCE_CASE}`}>{choice.label}</span>
            </label>
          ))}
        </div>
        {check.line}
      </fieldset>
    );
  }

  function renderSizeFieldset(surface: "panel" | "sheet") {
    const check = validationFor("size", surface);
    const kindGuidanceId = `storefront-kind-guidance-${surface}`;
    const sizeDescribedBy =
      [check.text ? check.id : null, awaitsKindSelection ? kindGuidanceId : null]
        .filter((id): id is string => id !== null)
        .join(" ") || undefined;

    return (
      <fieldset
        ref={setFieldsetRef(surface, "size")}
        tabIndex={-1}
        aria-invalid={check.invalid}
        aria-describedby={sizeDescribedBy}
        className={`mt-3.5 rounded-sm ${check.outline}`}
      >
        {renderSelectorLegend("Kích cỡ", selection.size)}
        {/*
          Owner request 2026-09-24: the "choose a kind first" sentence is not shown. It stays in
          the accessibility tree as the size group's description, because the size inputs are
          disabled until a kind is chosen and a screen reader would otherwise meet locked options
          with no reason; sighted shoppers get the dashed, unresolved chips as the cue.
        */}
        {view.kindSelectionGuidance === null ? null : (
          <p id={kindGuidanceId} className="sr-only">
            {view.kindSelectionGuidance}
          </p>
        )}
        <div className="mt-0.5 flex flex-wrap gap-x-2">
          {view.sizes.map((choice) => (
            <label
              key={choice.value}
              className={choiceTarget(choice.disabled && !awaitsKindSelection)}
              // A size locked only because no kind is chosen yet answers the tap by asking for the
              // kind: the disabled radio itself cannot, and a tap that lands on nothing reads as broken.
              onClick={awaitsKindSelection ? () => runPurchase(surface, promptForKind) : undefined}
            >
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
                className={
                  awaitsKindSelection
                    ? `${SELECTABLE_CHIP} ${UNRESOLVED_SIZE_CHIP}`
                    : chipClass(choice.disabled)
                }
              >
                {choice.value}
              </span>
            </label>
          ))}
        </div>
        {renderSizeGuideTrigger(surface)}
        {/* Wrapped: a server-built slot placed straight among sibling children reads as an unkeyed list item. */}
        {surface === "panel" && sizeHelp !== null ? <div>{sizeHelp}</div> : null}
        {check.line}
      </fieldset>
    );
  }

  function renderColorFieldset(surface: "panel" | "sheet") {
    if (!view.hasColorOptions) return null;
    const check = validationFor("color", surface);

    return (
      <fieldset
        ref={setFieldsetRef(surface, "color")}
        tabIndex={-1}
        aria-invalid={check.invalid}
        aria-describedby={check.text ? check.id : undefined}
        className={`mt-3.5 rounded-sm ${check.outline}`}
      >
        {renderSelectorLegend(view.colorDimensionLabel ?? "Màu", selection.color)}
        <div className="mt-0.5 flex flex-wrap gap-x-2">
          {view.colors.map((choice) => (
            <label key={choice.value} className={choiceTarget(choice.disabled)}>
              <input
                className="peer sr-only"
                type="radio"
                name={groupName("color", surface)}
                value={choice.value}
                checked={selection.color === choice.value}
                disabled={choice.disabled || isPending}
                onChange={() => chooseColor(choice.value)}
              />
              <span className={`${chipClass(choice.disabled)} ${SENTENCE_CASE}`}>{choice.value}</span>
            </label>
          ))}
        </div>
        {check.line}
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

  /*
   * The sale as the phone bar and the sheet header carry it. On a phone the panel's own price sits
   * below the photograph, so the bar is often the first price a shopper reads: a sale it did not
   * show would look like the full price.
   */
  function renderCompactPrice(clock: FlashClock | null = null) {
    // During a Flash Sale the bar's second line is the countdown, so the struck price moves up
    // beside the Flash price and the percentage stays in the panel, where it is said once.
    return (
      <span className="flex min-w-0 items-baseline gap-x-2 whitespace-nowrap">
        <span className="sr-only">{priceDisplay.compareAtText ? "Giá khuyến mãi " : ""}</span>
        <span
          className={`font-display text-base font-semibold tabular-nums ${clock ? "text-[#9A3324]" : ""}`}
        >
          {priceDisplay.displayText}
        </span>
        {priceDisplay.compareAtText && clock ? (
          <>
            <span className="sr-only">Giá gốc </span>
            <span className="text-xs tabular-nums text-black/55 line-through decoration-black/40">
              {priceDisplay.compareAtText}
            </span>
          </>
        ) : priceDisplay.compareAtText ? (
          <span className="text-xs font-medium tabular-nums text-[#8A3A35]">-{priceDisplay.discountPercent}%</span>
        ) : null}
      </span>
    );
  }

  function renderFlashCompact(clock: FlashClock) {
    return (
      <span className="mt-0.5 flex items-center gap-1 text-xs font-bold tabular-nums text-[#D6262F]">
        <BoltIcon className="h-3 w-3 shrink-0" />
        <span aria-hidden="true">Còn {clock.text}</span>
        <span className="sr-only">{clock.spoken}</span>
      </span>
    );
  }

  function renderLowStock(surface: "panel" | "sheet") {
    if (lowStockLabel === null) return null;
    return (
      <p
        className={`text-sm font-semibold text-[#9A3324] ${surface === "panel" ? "mt-2.5" : "mt-3"}`}
        data-pdp-low-stock=""
      >
        {lowStockLabel}
      </p>
    );
  }

  function renderCompactDetail(fallback: string) {
    const detail = mobilePresentation.summary || fallback;
    return (
      <span className="mt-0.5 block truncate text-xs text-black/60">
        {priceDisplay.compareAtText ? (
          <>
            <span className="sr-only">Giá gốc </span>
            <span className="tabular-nums line-through decoration-black/40">{priceDisplay.compareAtText}</span>
            {detail ? <span aria-hidden="true">{" · "}</span> : null}
          </>
        ) : null}
        {detail}
      </span>
    );
  }

  const barHidden = panelActionsInView && !isSheetOpen;

  return (
    <>
      <section
        aria-label="Mua sản phẩm"
        className="mt-1 border-t border-[#3B2219]/15 pt-6 lg:mt-0 lg:border-t-0 lg:pt-0"
      >
        {flashClock === null ? null : (
          <div className="pdp-flash-strip" data-pdp-flash="">
            <span className="pdp-flash-strip__label">
              <BoltIcon className="pdp-flash-strip__bolt" />
              FLASH SALE
            </span>
            {/* The digits tick every second, so they are hidden from assistive technology; the
                sentence beside them changes once a minute and is not a live region. */}
            <span className="pdp-flash-strip__clock">
              <span>Kết thúc sau</span>
              <span className="pdp-flash-strip__digits" aria-hidden="true">
                {flashClock.days > 0 ? (
                  <>
                    <b>{flashClock.days}</b>
                    <span className="pdp-flash-strip__unit">ngày</span>
                  </>
                ) : null}
                <b>{flashClock.hours}</b>:<b>{flashClock.minutes}</b>:<b>{flashClock.seconds}</b>
              </span>
              <span className="sr-only">{flashClock.spoken}</span>
            </span>
          </div>
        )}
        <div className={`flex items-baseline justify-between gap-6 ${flashClock === null ? "" : "mt-4"}`}>
          <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-display text-[1.75rem] leading-tight font-normal tabular-nums tracking-[0.01em] text-[#2A1810]">
            {priceDisplay.compareAtText ? (
              <>
                <span className="sr-only">Giá gốc </span>
                <span className="align-baseline text-lg text-[#3B2219]/70 line-through decoration-[#3B2219]/40">
                  {priceDisplay.compareAtText}
                </span>
                <span className="sr-only">{flashClock === null ? "Giá khuyến mãi " : "Giá Flash Sale "}</span>
                {/* Red only for a Flash price, the one sale the page shouts about. */}
                <span className={flashClock === null ? undefined : "text-[#9A3324]"}>{priceDisplay.displayText}</span>
                <span className="inline-flex items-center self-center border border-[#3B2219]/30 px-2 py-0.5 text-xs font-medium tracking-[0.08em] text-[#3B2219]">
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

        {offers === null ? null : <div>{offers}</div>}

        {/*
          One order on both surfaces, owner request 2026-09-24: kind, then colour, then size. A
          product without a kind renders no kind fieldset, so it reads colour then size, which is
          what the desktop panel already showed for those products. The mobile sheet below uses
          the same order, so the two compositions no longer disagree.
        */}
        {renderKindFieldset("panel")}
        {renderColorFieldset("panel")}
        {renderSizeFieldset("panel")}
        {renderLowStock("panel")}

        <div ref={panelActionsRef} className="mt-8 grid grid-cols-2 gap-3">
          <button
            className="btn btn--primary w-full px-4"
            type="button"
            aria-label={view.addToBagAccessibleName}
            disabled={!canAttemptPurchase}
            aria-busy={isPending}
            onClick={() => runPurchase("panel", addToBag)}
          >
            {view.addToBagLabel}
          </button>
          <button
            className="btn btn--outline w-full px-4"
            type="button"
            disabled={!canAttemptPurchase}
            aria-busy={isPending}
            onClick={() => runPurchase("panel", buyNow)}
          >
            Mua ngay
          </button>
        </div>

        <p
          className={`mt-3 min-h-6 text-sm ${justAdded ? "font-medium text-[#24472D]" : "text-[#3B2219]/70"}`}
          role="status"
          aria-live="polite"
        >
          {justAdded ? (
            <span className="inline-flex items-center gap-2">
              <CheckIcon />
              {message}
            </span>
          ) : (
            purchaseStatus
          )}
        </p>
        {/*
          A confirmed add from the panel says so where the shopper is looking and offers the next
          step, without taking over the page the way the sheet's hand-off to the drawer does: the
          shopper chose to stay on the product, so the cart opens only when they ask for it.
        */}
        {justAdded ? (
          <Link
            href="/cart"
            data-pdp-view-cart=""
            className="btn btn--outline mt-2 w-full"
            onClick={handleViewCartClick}
          >
            Xem giỏ hàng
          </Link>
        ) : null}

        {availabilityDateLabel === null ? null : (
          <p className="mt-1 text-xs text-black/55" role="status" aria-live="polite">
            Dự kiến có hàng: {availabilityDateLabel}
          </p>
        )}

        {assurance === null ? null : <div>{assurance}</div>}
      </section>

      <section
        aria-label="Mua nhanh"
        data-mobile-purchase-bar=""
        data-hidden={barHidden ? "true" : "false"}
        aria-hidden={barHidden ? true : undefined}
        inert={barHidden}
        className={`fixed inset-x-0 bottom-0 z-40 border-t border-black/20 bg-[#FAF7F2] px-4 pt-3 shadow-[0_-8px_24px_rgba(0,0,0,0.08)] transition-[transform,visibility] duration-200 motion-reduce:transition-none lg:hidden ${
          barHidden ? "invisible translate-y-full" : ""
        }`}
        style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
      >
        {mobileNudge}
        <div className="mx-auto flex w-full max-w-[42rem] min-w-0 items-center gap-3">
          {/*
            The price column never yields to the button: the button may take at most 60% of the bar
            and wraps onto a second line before it squeezes the price, which is what a long
            "Chọn ..." label used to do. The cart is not repeated here -- the header carries it, and
            a takeover of this column hid the price of the product the shopper is looking at.
          */}
          <p className="m-0 min-w-0 flex-1">
            {renderCompactPrice(flashClock)}
            {flashClock === null
              ? renderCompactDetail(productName || mobilePresentation.actionLabel)
              : renderFlashCompact(flashClock)}
          </p>
          <button
            ref={stickyTriggerRef}
            className="btn btn--primary min-w-0 max-w-[60%] shrink px-3 text-balance"
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
                  {/* The price stays in the header while choices are made: it moves with the kind. */}
                  <p className="m-0 min-w-0">
                    <span className="block text-xs font-semibold uppercase tracking-[0.12em] text-black/55">
                      Lựa chọn sản phẩm
                    </span>
                    <span className="mt-1 block">{renderCompactPrice()}</span>
                    {renderCompactDetail("")}
                  </p>
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

                <div className="max-h-[calc(88dvh-10rem)] overflow-y-auto px-5 pb-5">
                  {renderKindFieldset("sheet")}
                  {renderColorFieldset("sheet")}
                  {renderSizeFieldset("sheet")}
                  {renderLowStock("sheet")}

                  <p className="mt-4 min-h-6 text-sm text-black/65" role="status" aria-live="polite">
                    {mobilePurchaseStatus}
                  </p>
                </div>

                <div className="border-t border-black/15 bg-[#FAF7F2] p-4">
                  {mobilePresentation.readyToAdd ? (
                    /*
                     * A finished selection offers both ways out the panel has: into the bag (and the
                     * drawer), or straight to checkout for the shopper who is buying just this.
                     */
                    <div className="grid grid-cols-2 gap-3">
                      <button
                        type="button"
                        className="btn btn--primary w-full px-3"
                        disabled={isPending}
                        aria-busy={isPending}
                        onClick={() => runPurchase("sheet", () => addToBag(handleSheetAddAccepted))}
                      >
                        {mobilePresentation.actionLabel}
                      </button>
                      <button
                        type="button"
                        className="btn btn--outline w-full px-3"
                        disabled={isPending}
                        aria-busy={isPending}
                        onClick={() => runPurchase("sheet", buyNow)}
                      >
                        Mua ngay
                      </button>
                    </div>
                  ) : (
                    <button type="button" className="btn btn--primary w-full" disabled>
                      {view.selectedVariantId !== null && !view.canAdd
                        ? mobilePresentation.unavailableMessage || "Lựa chọn này tạm hết"
                        : mobilePresentation.actionLabel}
                    </button>
                  )}
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
