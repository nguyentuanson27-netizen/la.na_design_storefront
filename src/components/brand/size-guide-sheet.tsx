"use client";

import { useEffect, type KeyboardEvent, type RefObject } from "react";

import {
  buildSizeGuideSheetTable,
  buildSizeGuideSheetTitle,
  isSelectedGuideSize,
} from "@/components/headless/size-guide-sheet-model";
import type { ProductMappedSizeGuide } from "@/routes/product-model";

/** Tailwind's `sm` breakpoint: at and above it the size guide keeps its centred dialog. */
export const SIZE_GUIDE_SHEET_QUERY = "(max-width: 639.98px)";

/**
 * The phone size guide: a bottom sheet with one row per size, the shopper's chosen size picked out.
 *
 * It draws from the same approved chart the dialog and `/size-guide` use, so it carries no number
 * of its own. It deliberately ignores admin artwork: the table is what lets the chosen size's row
 * stand out. Cân nặng comes first, then the body measurements, all in a type size small enough that
 * the widest chart fits a 360px phone without scrolling sideways.
 *
 * Only ever opened below `sm`; if the viewport grows past it while open, it closes rather than
 * floating a phone sheet over a desktop layout.
 */
export function SizeGuideSheet({
  guide,
  selectedSize,
  dialogRef,
  closeButtonRef,
  onClose,
}: Readonly<{
  guide: ProductMappedSizeGuide;
  /** The size currently chosen in the purchase selector, or `null` while none is. */
  selectedSize: string | null;
  dialogRef: RefObject<HTMLDialogElement | null>;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}>) {
  const table = buildSizeGuideSheetTable(guide.chart);
  const title = buildSizeGuideSheetTitle(guide.chart.title, guide.productCode);

  useEffect(() => {
    const query = window.matchMedia(SIZE_GUIDE_SHEET_QUERY);
    function closeWhenNoLongerPhone() {
      if (!query.matches) dialogRef.current?.close();
    }
    query.addEventListener("change", closeWhenNoLongerPhone);
    return () => query.removeEventListener("change", closeWhenNoLongerPhone);
  }, [dialogRef]);

  // The close button is the only control inside, so Tab stays on it rather than leaving the modal.
  function holdFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== "Tab") return;
    event.preventDefault();
    closeButtonRef.current?.focus();
  }

  return (
    <dialog
      ref={dialogRef}
      aria-label={`Hướng dẫn chọn size: ${guide.chart.title}`}
      data-size-guide-id={guide.id}
      data-size-guide-sheet=""
      tabIndex={-1}
      className="fixed inset-x-0 bottom-0 top-auto m-0 max-h-[88dvh] w-full max-w-none overflow-y-auto rounded-t-3xl border-0 bg-[#FAF7F2] p-0 text-[#3B2219] shadow-none backdrop:bg-black/45 sm:hidden"
      onClose={onClose}
      onKeyDown={holdFocus}
    >
      <div className="px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-2.5">
        <div aria-hidden="true" className="mx-auto h-1 w-10 rounded-full bg-[#3B2219]/20" />

        <div className="mt-4 flex items-start justify-between gap-3">
          <h2 className="font-display text-xl leading-tight tracking-[-0.02em]">{title}</h2>
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="Đóng"
            className="-mr-1 -mt-1 inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-[#3B2219]/8 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3B2219]"
            onClick={() => dialogRef.current?.close()}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="size-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <p className="mt-2 text-sm leading-6 text-[#3B2219]/70">
          Tìm dòng có cân nặng của nàng, rồi so số đo cùng dòng.
        </p>

        <table className="mt-3 w-full table-fixed border-collapse text-center text-[11px] leading-tight tabular-nums">
          <caption className="sr-only">{`Dữ liệu bảng size ${guide.chart.title}`}</caption>
          <thead>
            <tr className="border-b border-[#3B2219]/15">
              <th scope="col" className="w-[13%] px-1 py-2 text-left font-semibold">
                Size
              </th>
              {table.columns.map((column) => (
                <th key={column.label} scope="col" className="px-0.5 py-2 font-semibold">
                  {column.label}
                  {column.unit ? (
                    <span className="block text-[10px] font-normal text-[#3B2219]/60">
                      ({column.unit})
                    </span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row) => {
              const selected = isSelectedGuideSize(row.size, selectedSize);
              return (
                <tr
                  key={row.size}
                  aria-current={selected ? "true" : undefined}
                  data-selected={selected ? "true" : undefined}
                  className={`border-b border-[#3B2219]/10 ${
                    selected ? "bg-[#3B2219]/10 font-semibold" : ""
                  }`}
                >
                  <th scope="row" className="px-1 py-3 text-left text-sm font-semibold">
                    {row.size}
                  </th>
                  {row.cells.map((cell, index) => (
                    <td key={table.columns[index]!.label} className="px-0.5 py-3">
                      {cell}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="mt-3 space-y-1.5 text-xs leading-5 text-[#3B2219]/65">
          <p>{guide.circumferenceSemanticsNote}</p>
          {guide.tolerance ? (
            <p>
              <strong>Dung sai:</strong> {guide.tolerance.note}
            </p>
          ) : null}
          <p>{guide.guidanceNote}</p>
        </div>
      </div>
    </dialog>
  );
}
