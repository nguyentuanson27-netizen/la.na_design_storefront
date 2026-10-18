"use client";

import { useCartLine, type UseCartLineInput } from "@/components/headless/use-cart-line";

/**
 * Markup only. Every brand throws this file away and writes its own.
 *
 * No quantity is validated here and no message is chosen here: both come from `useCartLine`, which
 * is where they must stay.
 *
 * The remove control is positioned against the nearest positioned ancestor, so the line card places
 * it (top-right of the line's text column).
 */

export function BrandCartLineControls({
  productName,
  totalText,
  ...props
}: UseCartLineInput & Readonly<{ productName: string; totalText?: string }>) {
  const line = useCartLine(props);
  const stepClassName =
    "inline-flex h-10 w-10 items-center justify-center text-lg text-black/80 transition hover:text-black disabled:cursor-not-allowed disabled:opacity-35";

  return (
    <div className="mt-3">
      <div className="inline-flex items-center rounded-lg bg-black/[0.05]">
        <button
          aria-label={line.decrementTarget < line.currentQuantity - 1 ? `Giảm ${productName} còn ${line.decrementTarget}` : `Bớt một ${productName}`}
          className={stepClassName}
          disabled={!line.canDecrement}
          onClick={line.decrement}
          type="button"
        >
          <span aria-hidden="true">−</span>
        </button>
        <label className="sr-only" htmlFor={line.inputId}>
          Số lượng
        </label>
        <input
          id={line.inputId}
          className="h-10 w-10 bg-transparent text-center text-sm text-black/80 outline-none [appearance:textfield] focus-visible:ring-1 focus-visible:ring-black disabled:cursor-not-allowed disabled:opacity-45 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          type="number"
          min={1}
          max={line.maxQuantity}
          step={1}
          inputMode="numeric"
          value={line.quantity}
          disabled={!line.canEditQuantity}
          onBlur={line.commitTypedQuantity}
          onChange={(event) => line.setQuantity(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              line.commitTypedQuantity();
            }
          }}
        />
        <button
          aria-label={`Thêm một ${productName}`}
          className={stepClassName}
          disabled={!line.canIncrement}
          onClick={line.increment}
          type="button"
        >
          <span aria-hidden="true">+</span>
        </button>
      </div>
      <p className={`mt-1.5 text-sm empty:hidden ${line.messageIsWarning ? "font-medium text-amber-800" : "text-black/60"}`} role="status" aria-live="polite">
        {line.message}
      </p>
      {totalText ? <p className="mt-3 font-semibold" data-line-total>{totalText}</p> : null}
      <button
        aria-label={`Xóa ${productName} khỏi giỏ hàng`}
        className="absolute right-0 top-0 inline-flex h-10 w-10 items-center justify-center text-black/70 transition hover:text-black disabled:cursor-not-allowed disabled:opacity-40"
        disabled={!line.canRemove}
        onClick={line.removeLine}
        type="button"
      >
        <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 24 24">
          <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
        </svg>
      </button>
    </div>
  );
}
