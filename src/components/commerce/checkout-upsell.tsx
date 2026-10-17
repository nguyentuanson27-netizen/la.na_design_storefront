"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type MouseEvent } from "react";
import type { CheckoutUpsellModel } from "@/commerce/promotion-upsell";

/**
 * OD-01/A (UX-COMMERCE-001, amendment to SPEC-UPS-001): the checkout no longer adds the +1 itself. It
 * names the opportunity the server proved and offers the way to `/sale`; the cart and checkout quote
 * decide again whatever the buyer brings back. Nothing here mutates the cart or the quote.
 */
let reloadAttemptRestored = false;
const STORAGE_KEY = "la-checkout-upsell-attempt-v1";
type Attempt = { paidCartKey: string; dismissed: boolean };

function readAttempt(): Attempt | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null");
    if (!value || typeof value.paidCartKey !== "string" || typeof value.dismissed !== "boolean") return null;
    return { paidCartKey: value.paidCartKey, dismissed: value.dismissed };
  } catch { return null; }
}

function saveAttempt(value: Attempt) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* UI-only; never authorizes a write */ }
}

export function CheckoutUpsell({ model, hasEnteredDetails }: Readonly<{
  model: CheckoutUpsellModel;
  /** Whether the receiving form holds anything the buyer typed; leaving would discard it (it is never stored). */
  hasEnteredDetails: () => boolean;
}>) {
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [confirmingExit, setConfirmingExit] = useState(false);
  const initialized = useRef(false);
  const mounted = useRef(false);
  const exitLink = useRef<HTMLAnchorElement>(null);
  const warningHeading = useRef<HTMLParagraphElement>(null);
  const returnFocus = useRef(false);
  const warningId = useId();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // A client navigation/Activity exit ends the attempt. Browser reload does not run this
      // cleanup. Deferral avoids treating React StrictMode's immediate effect replay as an exit.
      queueMicrotask(() => {
        if (mounted.current) return;
        initialized.current = false;
        try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* UI-only */ }
      });
    };
  }, []);

  useEffect(() => {
    let active = true;
    // Hide until tab state is known, including reload, so a dismissed offer never flashes at hydration.
    queueMicrotask(() => {
      if (!active) return;
      const stored = readAttempt();
      const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      const canRestore = initialized.current || (navigation?.type === "reload" && !reloadAttemptRestored);
      // D-06: a paid-cart change (A→B→A included) carries a different key, so the skip resets.
      const next: Attempt = canRestore && stored?.paidCartKey === model.paidCartKey ? stored : { paidCartKey: model.paidCartKey, dismissed: false };
      initialized.current = true;
      reloadAttemptRestored = true;
      saveAttempt(next);
      setAttempt(next);
    });
    return () => { active = false; };
  }, [model.paidCartKey]);

  useEffect(() => {
    if (confirmingExit) warningHeading.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      exitLink.current?.focus();
    }
  }, [confirmingExit]);

  function dismiss() {
    const next = { paidCartKey: model.paidCartKey, dismissed: true };
    saveAttempt(next);
    setAttempt(next);
  }

  function requestExit(event: MouseEvent<HTMLAnchorElement>) {
    // Nothing typed: nothing to lose, so the link simply goes. Modified clicks open a new tab and
    // leave this form where it is.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    if (!hasEnteredDetails()) return;
    event.preventDefault();
    setConfirmingExit(true);
  }

  function stay() {
    returnFocus.current = true;
    setConfirmingExit(false);
  }

  if (!attempt || attempt.paidCartKey !== model.paidCartKey || !model.offer || attempt.dismissed) {
    return null;
  }

  return (
    <section className="border border-[#e7ded7] bg-[#fbf8f5] p-4 sm:p-5" aria-label="Gợi ý mua thêm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <h2 className="font-display text-base leading-snug text-black sm:text-lg">
            Thêm 1 sản phẩm phù hợp để đạt ưu đãi
          </h2>
          <p className="text-xs leading-relaxed text-black/70 sm:text-sm">
            Chương trình: {model.offer.name}. Không phải mọi sản phẩm ở trang Sale đều thuộc chương trình; giỏ hàng và
            bước thanh toán sẽ kiểm tra lại ưu đãi.
          </p>
          {confirmingExit ? null : (
            <div className="flex flex-wrap items-center gap-4 pt-2">
              <Link ref={exitLink} href="/sale" className="btn btn--outline btn--sm min-h-11 text-xs" onClick={requestExit}>
                Tiếp tục mua sắm
              </Link>
              <button
                className="min-h-11 text-left text-xs text-black/70 underline underline-offset-4 transition-colors hover:text-black sm:text-sm"
                type="button"
                onClick={dismiss}
              >
                Không mua thêm, tiếp tục thanh toán
              </button>
            </div>
          )}
        </div>
        <button
          type="button"
          className="-mr-1 -mt-1 min-h-11 min-w-11 p-1 text-lg leading-none text-black/60 transition-colors hover:text-black"
          aria-label="Đóng gợi ý ưu đãi"
          onClick={dismiss}
        >
          ×
        </button>
      </div>
      {confirmingExit ? (
        <div className="mt-4 border border-black/25 bg-white p-4" role="group" aria-labelledby={warningId} data-upsell-exit-warning>
          <p id={warningId} ref={warningHeading} tabIndex={-1} className="text-sm font-semibold">
            Rời trang thanh toán?
          </p>
          <p className="mt-2 text-sm leading-6">
            Thông tin nhận hàng bạn đã nhập chưa được gửi và sẽ không được lưu khi rời trang. Sản phẩm trong giỏ và quà đã
            lưu vẫn được giữ.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <button type="button" className="btn btn--primary btn--sm min-h-11" onClick={stay}>
              Ở lại thanh toán
            </button>
            <Link href="/sale" className="min-h-11 content-center text-sm underline underline-offset-4">
              Vẫn đến trang Sale
            </Link>
          </div>
        </div>
      ) : null}
    </section>
  );
}
