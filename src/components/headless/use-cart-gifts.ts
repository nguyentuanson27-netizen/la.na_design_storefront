"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { readStorefrontCartGifts, setStorefrontCartGift } from "@/commerce/cart-gift-selection-actions";
import { giftMutationOutcome } from "./cart-gift-mutation-model";

/** No optimistic choices. The action's refreshed route installs the new quote before releasing busy. */
export function useCartGifts(onBusyChange?: (pending: boolean) => void, locked = false, isLocked?: () => boolean) {
  const [pending, startTransition] = useTransition();
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState("");
  const busy = useRef(false);
  const unknown = useRef(false);
  useEffect(() => {
    busy.current = pending || unknown.current;
    onBusyChange?.(busy.current);
  }, [pending, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  async function readback() {
    try {
      const result = await readStorefrontCartGifts();
      if (result.ok) {
        unknown.current = false; setUncertain(false);
        setMessage("Đã kiểm tra lại quà trong đơn. Hãy xem lựa chọn và báo giá hiện tại trước khi tiếp tục.");
        return;
      }
    } catch { /* Result remains unknown: retry reads only. */ }
    unknown.current = true; setUncertain(true);
    setMessage("Chưa xác nhận được kết quả lưu quà. Nàng kiểm tra lại quà trong giỏ và đừng nhận hoặc bỏ quà lần nữa lúc này nhé.");
  }
  function retryRead() {
    if (pending) return;
    busy.current = true; onBusyChange?.(true);
    startTransition(readback);
  }
  function change(campaignId: string, variantId: string, campaignRevision: number, quantity: number, label: string, removed: number) {
    if (locked || isLocked?.() || busy.current || unknown.current) return false;
    busy.current = true; onBusyChange?.(true);
    setMessage(quantity === 0 || removed > 0 ? "Đang bỏ quà…" : "Đang thêm quà…");
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof setStorefrontCartGift>> | null = null;
      try { result = await setStorefrontCartGift({ campaignId, variantId, campaignRevision, quantity }); } catch { /* ambiguous */ }
      const outcome = giftMutationOutcome(result);
      if (outcome === "readback") { await readback(); return; }
      if (outcome === "saved") {
        const swapped = result && "replaced" in result && (result.replaced ?? 0) > 0;
        setMessage(removed > 0 ? `Đã bỏ ${removed} quà ${label} khỏi đơn.`
          : `Đã thêm vào đơn: ${label}.${swapped ? " Quà của mốc trước đã được thay bằng món này." : ""}`);
      } else {
        setMessage(`Chưa ${removed > 0 ? "bỏ" : "thêm"} quà ${label}. Quyền nhận hoặc tồn kho đã thay đổi. Đang kiểm tra lại số suất thực tế.`);
        // The refusal is known, but the visible eligibility/stock may be stale.
        await readback();
        if (!unknown.current) setMessage(`Chưa ${removed > 0 ? "bỏ" : "thêm"} quà ${label}. Lựa chọn và số suất hiện tại được cập nhật bên trên.`);
      }
    });
    return true;
  }
  return { pending, uncertain, message, change, retryRead };
}
