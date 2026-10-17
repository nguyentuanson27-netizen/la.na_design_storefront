"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { CheckoutUpsellModel } from "@/commerce/promotion-upsell";

let reloadAttemptRestored = false;
const STORAGE_KEY = "la-checkout-upsell-attempt-v1";
type PendingAdd = { paidCartKey: string; entitlements: { campaignId: string; entitled: number }[] };
type Attempt = { paidCartKey: string; dismissed: boolean; giftIds: string[]; pendingAdd?: PendingAdd };

function readAttempt(): Attempt | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null");
    if (!value || typeof value.paidCartKey !== "string" || typeof value.dismissed !== "boolean" || !Array.isArray(value.giftIds) || !value.giftIds.every((id: unknown) => typeof id === "string")) return null;
    if (value.pendingAdd && (typeof value.pendingAdd.paidCartKey !== "string" || !Array.isArray(value.pendingAdd.entitlements) || !value.pendingAdd.entitlements.every((e: { campaignId?: unknown; entitled?: unknown } | null) => e && typeof e.campaignId === "string" && typeof e.entitled === "number" && Number.isSafeInteger(e.entitled) && e.entitled >= 0))) return null;
    return value;
  } catch { return null; }
}

function saveAttempt(value: Attempt) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* UI-only; never authorizes a write */ }
}

export function CheckoutUpsell({ model, onBusyChange }: Readonly<{ model: CheckoutUpsellModel; locked: boolean; isLocked?: () => boolean; onBusyChange: (pending: boolean) => void }>) {
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const initialized = useRef(false);
  const mounted = useRef(false);

  useEffect(() => () => onBusyChange(false), [onBusyChange]);

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
      let next: Attempt = canRestore && stored?.paidCartKey === model.paidCartKey ? stored : { paidCartKey: model.paidCartKey, dismissed: false, giftIds: [] };
      if (canRestore && stored?.pendingAdd?.paidCartKey === model.paidCartKey) {
        const before = new Map(stored.pendingAdd.entitlements.map((e) => [e.campaignId, e.entitled]));
        const unlocked = model.giftPicker.campaigns.filter((c) => c.entitled > (before.get(c.campaignId) ?? 0)).map((c) => c.campaignId);
        next = { paidCartKey: model.paidCartKey, dismissed: false, giftIds: [...new Set([...stored.giftIds, ...unlocked])] };
      }
      initialized.current = true;
      reloadAttemptRestored = true;
      saveAttempt(next);
      setAttempt(next);
    });
    return () => { active = false; };
  }, [model.paidCartKey, model.giftPicker.campaigns]);

  function dismiss() {
    const next = { paidCartKey: model.paidCartKey, dismissed: true, giftIds: attempt?.giftIds ?? [] };
    saveAttempt(next);
    setAttempt(next);
  }

  if (!attempt || attempt.paidCartKey !== model.paidCartKey || !model.offer || attempt.dismissed) {
    return null;
  }

  return (
    <section
      className="border border-[#e7ded7] bg-[#fbf8f5] p-4 sm:p-5"
      aria-label="Gợi ý mua thêm"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="inline-block rounded-full bg-black/[0.06] px-2.5 py-0.5 text-[11px] font-medium tracking-wide text-black/75 uppercase">
              Gợi ý ưu đãi
            </span>
          </div>
          <h2 className="font-display text-base sm:text-lg text-black leading-snug">
            {model.offer.name}
          </h2>
          <p className="text-xs sm:text-sm text-black/70 leading-relaxed">
            Bạn chỉ cần thêm đúng 1 sản phẩm phù hợp nữa vào giỏ hàng để đạt mốc ưu đãi này.
          </p>
          <div className="pt-2 flex flex-wrap items-center gap-4">
            <Link
              href="/shop"
              className="btn btn--outline btn--sm text-xs"
            >
              Tiếp tục mua sắm
            </Link>
            <button
              className="text-xs sm:text-sm text-black/60 underline underline-offset-4 hover:text-black transition-colors"
              type="button"
              onClick={dismiss}
            >
              Không mua thêm, tiếp tục thanh toán
            </button>
          </div>
        </div>
        <button
          type="button"
          className="text-black/40 hover:text-black p-1 -mr-1 -mt-1 text-lg leading-none transition-colors"
          aria-label="Đóng gợi ý ưu đãi"
          onClick={dismiss}
        >
          ×
        </button>
      </div>
    </section>
  );
}
