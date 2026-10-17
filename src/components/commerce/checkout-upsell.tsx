"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { CheckoutUpsellBanner } from "@/routes/checkout-model";

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

export function CheckoutUpsell({ model }: Readonly<{ model: CheckoutUpsellBanner }>) {
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const initialized = useRef(false);
  const mounted = useRef(false);

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

  function dismiss() {
    const next = { paidCartKey: model.paidCartKey, dismissed: true };
    saveAttempt(next);
    setAttempt(next);
  }

  if (!attempt || attempt.paidCartKey !== model.paidCartKey || attempt.dismissed) {
    return null;
  }

  // "1 món" and "ưu đãi" promise only what the server proved: one more qualifying piece reaches the
  // named programme. The cart and checkout quote decide again whatever the buyer brings back.
  return (
    <section className="flex items-start gap-3 border border-[#e7ded7] bg-[#fbf8f5] px-4 py-3" aria-label="Gợi ý mua thêm">
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold leading-6">Thêm 1 món để nhận ưu đãi</h2>
        <p className="text-xs leading-5 text-black/70">{model.offerName}</p>
        <Link href="/sale" className="mt-1 inline-flex min-h-11 items-center text-sm font-semibold underline underline-offset-4">
          Chọn thêm món
        </Link>
      </div>
      <button
        type="button"
        className="-mr-2 -mt-1 min-h-11 min-w-11 text-lg leading-none text-black/60 transition-colors hover:text-black"
        aria-label="Đóng gợi ý ưu đãi"
        onClick={dismiss}
      >
        ×
      </button>
    </section>
  );
}
