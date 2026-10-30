"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { CheckoutUpsellBanner } from "@/routes/checkout-model";

/**
 * OD-01/A (UX-COMMERCE-001, amendment to SPEC-UPS-001): the checkout no longer adds the +1 itself. It
 * names the opportunity the server proved and offers the way to the eligible-products listing; the cart and checkout quote
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

/**
 * `locked` while an order is being placed or its outcome is not yet known (PROCESSING /
 * SYNC_UNKNOWN): leaving then would strand the buyer before they learn whether the order exists.
 * Before submitting, leaving for the eligible listing is free (owner decision: no leave warning).
 */
export function CheckoutUpsell({ model, locked = false }: Readonly<{ model: CheckoutUpsellBanner; locked?: boolean }>) {
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

  if (!attempt || attempt.paidCartKey !== model.paidCartKey || attempt.dismissed || model.offerName === null) {
    return null;
  }

  // "1 món" and "ưu đãi" promise only what the server proved: one more qualifying piece reaches the
  // named programme. The cart and checkout quote decide again whatever the buyer brings back.
  return (
    <section className="flex items-start gap-3 border border-[#e7ded7] bg-[#fbf8f5] px-4 py-3" aria-label="Gợi ý mua thêm">
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold leading-6">Thêm 1 món để nhận ưu đãi</h2>
        <div className="mt-1 flex min-w-0 flex-col items-start gap-2 text-xs leading-5 text-black/70">
          <span className="min-w-0 break-words">{model.offerName}</span>
          {locked ? (
            <span aria-disabled="true" className="inline-flex min-h-11 cursor-not-allowed items-center text-sm font-semibold text-black/45" data-upsell-link-locked>
              Chọn thêm món
            </span>
          ) : (
            <Link href={`/offers/eligible?campaign=${encodeURIComponent(model.campaignId ?? "")}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-black underline underline-offset-4">
              Chọn thêm món
            </Link>
          )}
        </div>
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


type LoadedUpsell = Readonly<{
  quoteProof: string;
  quoteRenderId?: string;
  model: CheckoutUpsellBanner | null;
}>;

function parseUpsellBanner(value: unknown): CheckoutUpsellBanner | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "campaignId,offerName,paidCartKey") return null;
  if (typeof record.paidCartKey !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(record.paidCartKey)) return null;
  if (record.offerName !== null && (typeof record.offerName !== "string" || record.offerName.length > 256)) return null;
  if (record.campaignId !== null && (typeof record.campaignId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(record.campaignId))) return null;
  if ((record.campaignId === null) !== (record.offerName === null)) return null;
  return { paidCartKey: record.paidCartKey, offerName: record.offerName as string | null, campaignId: record.campaignId as string | null };
}

/**
 * Load only after checkout's shipping-address options are available. Failed / stale optional
 * recommendations never block the quote, form or submission. A render id forces a fresh read even
 * for A -> B -> A cart changes whose signed quote bytes happen to match.
 */
export function CheckoutUpsellLoader({ quoteProof, quoteRenderId, locked, ready }: Readonly<{
  quoteProof: string | null;
  quoteRenderId?: string;
  locked: boolean;
  ready: boolean;
}>) {
  const [loaded, setLoaded] = useState<LoadedUpsell | null>(null);

  useEffect(() => {
    // Geo readiness controls network work only; the mounted banner keeps D-06 dismissal state.
    if (!quoteProof || !ready || locked) return;
    const controller = new AbortController();
    let active = true;
    void (async () => {
      let model: CheckoutUpsellBanner | null = null;
      try {
        const response = await fetch("/api/checkout/upsell", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ quoteProof }),
          signal: controller.signal,
        });
        if (response.ok) model = parseUpsellBanner(await response.json());
      } catch {
        // An optional banner does not interrupt address entry or order submission.
      }
      if (active && !controller.signal.aborted) {
        setLoaded((previous) => ({
          quoteProof, quoteRenderId,
          // A temporarily missing offer must not erase an earlier dismissal within this checkout.
          model: model ?? (previous?.model ? { ...previous.model, offerName: null } : null),
        }));
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [quoteProof, quoteRenderId, locked, ready]);

  // Hide the old offer immediately when the proof/render changes, but keep the paid-cart key
  // mounted so D-06 dismiss state is preserved across a quote-only refresh.
  const current = ready && quoteProof && loaded?.quoteProof === quoteProof && loaded.quoteRenderId === quoteRenderId
    ? loaded.model
    : loaded?.model ? { ...loaded.model, offerName: null } : null;
  return current ? <CheckoutUpsell model={current} locked={locked} /> : null;
}
