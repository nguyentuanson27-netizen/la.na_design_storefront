"use client";

import { useCartLine, type UseCartLineInput } from "@/components/headless/use-cart-line";

/**
 * Markup only. Every brand throws this file away and writes its own.
 *
 * No quantity is validated here and no message is chosen here: both come from `useCartLine`, which
 * is where they must stay.
 */

export function BrandCartLineControls(props: UseCartLineInput) {
  const line = useCartLine(props);

  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-2" htmlFor={line.inputId}>
          <span className="text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-black/55">
            Số lượng
          </span>
          <input
            id={line.inputId}
            className="h-11 w-24 border border-black/30 bg-transparent px-3 text-sm outline-none focus-visible:border-black focus-visible:ring-1 focus-visible:ring-black disabled:cursor-not-allowed disabled:opacity-45"
            type="number"
            min={1}
            max={line.maxQuantity}
            step={1}
            inputMode="numeric"
            value={line.quantity}
            disabled={!line.canEditQuantity}
            onChange={(event) => line.setQuantity(event.target.value)}
          />
        </label>
        <button
          className="min-h-11 border border-black bg-black px-5 text-xs font-semibold uppercase tracking-[0.12em] text-white transition hover:bg-white hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black disabled:cursor-not-allowed disabled:border-black/20 disabled:bg-black/10 disabled:text-black/35"
          type="button"
          disabled={!line.canSubmitUpdate}
          onClick={line.updateLine}
        >
          {line.isPending ? "Đang xử lý…" : "Cập nhật"}
        </button>
        <button
          className="min-h-11 px-2 text-xs font-semibold uppercase tracking-[0.12em] underline decoration-black/30 underline-offset-4 transition hover:decoration-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black disabled:cursor-not-allowed disabled:opacity-40"
          type="button"
          disabled={!line.canRemove}
          onClick={line.removeLine}
        >
          Xóa
        </button>
      </div>
      <p className="mt-2 min-h-5 text-sm text-black/60" role="status" aria-live="polite">
        {line.message}
      </p>
    </div>
  );
}
