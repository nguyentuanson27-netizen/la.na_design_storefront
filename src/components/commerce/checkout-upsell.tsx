"use client";

import Image from "next/image";
import { useEffect, useRef, useState, useTransition } from "react";
import { addCheckoutUpsell, requoteCheckoutUpsell } from "@/commerce/promotion-upsell-actions";
import { readStorefrontCartGifts } from "@/commerce/cart-gift-selection-actions";
import type { UpsellIntent } from "@/commerce/promotion-upsell-proof";
import type { CheckoutUpsellModel, UpsellVariantView } from "@/commerce/promotion-upsell";

let reloadAttemptRestored = false;
const STORAGE_KEY = "la-checkout-upsell-attempt-v1";
type PendingAdd = { paidCartKey: string; entitlements: { campaignId: string; entitled: number }[] };
type Attempt = { paidCartKey: string; dismissed: boolean; giftIds: string[]; pendingAdd?: PendingAdd };
const money = new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 });
function readAttempt(): Attempt | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null");
    if (!value || typeof value.paidCartKey !== "string" || typeof value.dismissed !== "boolean" || !Array.isArray(value.giftIds) || !value.giftIds.every((id: unknown) => typeof id === "string")) return null;
    if (value.pendingAdd && (typeof value.pendingAdd.paidCartKey !== "string" || !Array.isArray(value.pendingAdd.entitlements) || !value.pendingAdd.entitlements.every((e: { campaignId?: unknown; entitled?: unknown } | null) => e && typeof e.campaignId === "string" && typeof e.entitled === "number" && Number.isSafeInteger(e.entitled) && e.entitled >= 0))) return null;
    return value;
  } catch { return null; }
}
function saveAttempt(value: Attempt) { try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* UI-only; never authorizes a write */ } }

export function CheckoutUpsell({ model, locked, onBusyChange, isLocked }: Readonly<{ model: CheckoutUpsellModel; locked: boolean; isLocked?: () => boolean; onBusyChange: (pending: boolean) => void }>) {
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [variants, setVariants] = useState<Record<string, string>>({});
  const [verified, setVerified] = useState<Record<string, Omit<UpsellVariantView, "label"> & { sourceProof: string }>>({});
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();
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
  const busy = useRef(false);
  const unknown = useRef(false);
  const [uncertain, setUncertain] = useState(false);
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
        // The response may have been lost after commit. Only the expected next server key
        // recovers this attempt; current server entitlements remain the gift authority.
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
  useEffect(() => {
    busy.current = pending || unknown.current;
    onBusyChange(busy.current);
  }, [pending, uncertain, onBusyChange]);

  function retryRead() {
    if (pending || !unknown.current) return;
    busy.current = true; onBusyChange(true);
    startTransition(async () => {
      try {
        // This cookie-owned read resolves the entire paid cart and gift state, then refreshes
        // the route in the same response. A size requote cannot establish what the add wrote.
        const result = await readStorefrontCartGifts();
        if (result.ok) {
          unknown.current = false; setUncertain(false);
          setVariants({}); setVerified({});
          setMessage("Đã kiểm tra lại giỏ hàng và báo giá. Hãy xem số lượng và quyền nhận hiện tại trước khi tiếp tục.");
          return;
        }
      } catch { /* Remain locked; only retry a read, never replay the add. */ }
      setMessage("Chưa xác nhận được kết quả thêm hàng. Vui lòng kiểm tra lại giỏ hàng và báo giá; không bấm thêm lại lúc này.");
    });
  }

  function selectVariant(productId: string, variantId: string) {
    setVariants((current) => ({ ...current, [productId]: variantId }));
    setVerified((current) => { const next = { ...current }; delete next[productId]; return next; });
    const variant = model.offer?.products.find((p) => p.productId === productId)?.variants.find((v) => v.variantId === variantId);
    if (!variant || busy.current || isLocked?.() || locked) return;
    busy.current = true; onBusyChange(true);
    startTransition(async () => {
      try {
        const result = await requoteCheckoutUpsell(variant.intent);
        if (result.ok) setVerified((current) => ({ ...current, [productId]: { ...result.variant, sourceProof: variant.intent.proof } }));
        else setMessage("Giá hoặc quyền lợi đã thay đổi. Hãy chọn lại theo gợi ý mới.");
      } catch { setMessage("Chưa kiểm tra được phiên bản này. Vui lòng chọn lại sau."); }
    });
  }
  function dismiss() {
    const next = { paidCartKey: model.paidCartKey, dismissed: true, giftIds: attempt?.giftIds ?? [] };
    saveAttempt(next); setAttempt(next);
  }
  function add(variant: { intent: UpsellIntent }) {
    if (busy.current || isLocked?.() || locked || uncertain) return;
    const pendingAttempt: Attempt = { paidCartKey: model.paidCartKey, dismissed: false, giftIds: attempt?.giftIds ?? [], pendingAdd: { paidCartKey: model.nextPaidCartKey, entitlements: model.giftPicker.campaigns.map(({ campaignId, entitled }) => ({ campaignId, entitled })) } };
    saveAttempt(pendingAttempt); setAttempt(pendingAttempt);
    busy.current = true;
    onBusyChange(true);
    startTransition(async () => {
      try {
        const result = await addCheckoutUpsell(variant.intent);
        if (result.ok) {
          const next = { paidCartKey: result.paidCartKey, dismissed: false, giftIds: [...new Set([...(attempt?.giftIds ?? []), ...result.newGiftCampaignIds])] };
          saveAttempt(next); setAttempt(next); setVariants({}); setMessage("Đã thêm 1 chiếc. Báo giá và quyền lợi đã được làm mới.");
        } else {
          const stored = readAttempt();
          const next = { paidCartKey: stored?.paidCartKey ?? model.paidCartKey, dismissed: stored?.dismissed ?? false, giftIds: stored?.giftIds ?? [] };
          saveAttempt(next); setAttempt(next);
          setMessage("Giỏ hàng, ưu đãi hoặc tồn kho đã thay đổi. Hãy kiểm tra báo giá mới trước khi thử lại.");
        }
      } catch {
        unknown.current = true; setUncertain(true);
        setMessage("Chưa xác nhận được kết quả thêm hàng. Hãy kiểm tra lại giỏ hàng và báo giá; không bấm thêm lại ngay.");
      }
    });
  }
  if (!attempt || attempt.paidCartKey !== model.paidCartKey) return null;
  return <div className="space-y-5" aria-busy={pending || uncertain}>
    {model.offer && !attempt.dismissed ? <section className="border border-black/20 bg-[#fcf8f6] p-4 sm:p-5" aria-label="Gợi ý mua thêm">
      <h2 className="font-display text-2xl">Gợi ý thêm để đạt ưu đãi</h2>
      <p className="mt-2 text-sm">{model.offer.name} · Thêm đúng 1 chiếc phù hợp.</p>
      <div className="mt-4 space-y-5">{model.offer.products.map((p) => {
        const offered = p.variants.find((v) => v.variantId === variants[p.productId]);
        const selected = offered && verified[p.productId]?.sourceProof === offered.intent.proof ? verified[p.productId] : undefined;
        const from = Math.min(...p.variants.map((v) => v.priceVnd));
        return <fieldset disabled={pending || locked || uncertain} key={p.productId} className="min-w-0 border-t border-black/10 pt-4">
          <legend className="font-semibold">{p.name}</legend>
          {p.imageUrl ? <Image className="mt-2 h-24 w-20 object-cover" src={p.imageUrl} alt={p.name} width={80} height={96} /> : null}
          <label className="mt-3 block text-sm" htmlFor={`upsell-${p.productId}`}>Phân loại / màu / kích cỡ</label>
          <select id={`upsell-${p.productId}`} className="mt-2 w-full min-w-0 border border-black/30 bg-white p-3" value={selected?.variantId ?? ""} onChange={(event) => selectVariant(p.productId, event.target.value)}>
            <option value="">Chọn phiên bản</option>
            {p.variants.map((v) => <option key={v.variantId} value={v.variantId}>{v.label}</option>)}
          </select>
          <p className="mt-3 text-sm">{selected ? money.format(selected.priceVnd) : `Từ ${money.format(from)}`}</p>
          {selected ? <p className="mt-2 text-sm" aria-live="polite">Ước tính thay đổi tổng thanh toán: {selected.deltaVnd > 0 ? "+" : ""}{money.format(selected.deltaVnd)} (gồm phí giao hàng). Đây là sản phẩm mua thêm; tổng được xác nhận theo báo giá sau khi thêm.</p> : null}
          <button className="btn btn--secondary mt-3" type="button" disabled={!selected || pending || locked || uncertain} onClick={() => selected && add(selected)}>Thêm 1 chiếc</button>
        </fieldset>;
      })}</div>
      <button className="mt-5 text-left text-sm underline underline-offset-4" type="button" disabled={pending || locked || uncertain} onClick={dismiss}>Không mua thêm, tiếp tục thanh toán</button>
    </section> : null}
    <p className="text-sm" role="status" aria-live="polite">{pending ? "Đang kiểm tra và làm mới báo giá…" : message}</p>
    {uncertain ? <button type="button" className="min-h-11 text-sm underline" disabled={pending} onClick={retryRead}>Kiểm tra lại giỏ hàng và báo giá</button> : null}
  </div>;
}
