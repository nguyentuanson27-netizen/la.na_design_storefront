"use client";

import { useMemo } from "react";

import { formatFlashClock } from "@/components/headless/product-urgency";
import { useElapsedMs } from "@/components/headless/use-elapsed-ms";

/**
 * A cart line's Flash Sale countdown and "Còn x", in the drawer and on the cart page.
 *
 * Both facts are decided on the server by the PDP's own rules (`buildCartLineUrgency`); this only
 * ticks the clock the way the PDP does, from the duration the server measured, so a wrong browser
 * clock cannot move the deadline. When the clock runs out before the cart is re-read it says so,
 * because the price on screen is the Flash price and will not survive the next read.
 */
export function CartLineUrgency({
  flashRemainingMs,
  lowStockText,
  className = "",
}: Readonly<{ flashRemainingMs?: number; lowStockText?: string; className?: string }>) {
  // One snapshot per server answer: a re-read restarts the elapsed count from the new duration.
  const snapshot = useMemo(() => (flashRemainingMs === undefined ? null : { flashRemainingMs }), [flashRemainingMs]);
  const elapsedMs = useElapsedMs(snapshot);
  if (flashRemainingMs === undefined && lowStockText === undefined) return null;
  const clock = flashRemainingMs === undefined ? null : formatFlashClock(flashRemainingMs - elapsedMs);

  return (
    <div className={`space-y-0.5 ${className}`}>
      {flashRemainingMs === undefined ? null : clock ? (
        <p className="flex flex-wrap items-center gap-x-1 text-[0.72rem] font-bold tabular-nums text-[#D6262F]" data-cart-flash>
          {/* The digits tick every second, so they are hidden from assistive technology; the sentence
              beside them changes once a minute. In a narrow column the line breaks between the label
              and the clock, never inside the time. */}
          <span aria-hidden="true" className="inline-flex items-center gap-1 whitespace-nowrap">
            <svg aria-hidden="true" className="h-3 w-3 shrink-0" fill="currentColor" focusable={false} viewBox="0 0 24 24">
              <path d="M13.5 2 4 13.5h6.5L9.5 22 20 9.5h-6.8L13.5 2Z" />
            </svg>
            FLASH SALE ·
          </span>
          <span aria-hidden="true" className="whitespace-nowrap">Còn {clock.text}</span>
          <span className="sr-only">{clock.spoken}</span>
        </p>
      ) : (
        <p className="text-[0.72rem] text-[#70584B]" data-cart-flash="ended">
          Flash Sale đã kết thúc, giá sẽ được cập nhật.
        </p>
      )}
      {lowStockText === undefined ? null : (
        <p className="text-[0.72rem] font-semibold text-[#9A3324]" data-cart-low-stock>
          {lowStockText}
        </p>
      )}
    </div>
  );
}
