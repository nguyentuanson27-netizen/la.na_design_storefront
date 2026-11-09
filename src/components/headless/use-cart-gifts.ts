"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { readStorefrontCartGifts, setStorefrontCartGift } from "@/commerce/cart-gift-selection-actions";
import { giftMutationOutcome } from "./cart-gift-mutation-model";

/** No optimistic choices. The action's refreshed route installs the new quote before releasing busy. */
export function useCartGifts(onBusyChange?: (pending: boolean) => void, locked = false, isLocked?: () => boolean) {
  const [pending, startTransition] = useTransition();
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState("");
  // What a screen reader hears when the sighted text is deliberately brief: which gift was saved or removed.
  const [spokenMessage, setSpokenMessage] = useState("");
  // Counts server-confirmed saves only; a refusal or a read-back never raises it.
  const [savedCount, setSavedCount] = useState(0);
  const busy = useRef(false);
  /** `text` is what is shown; `spoken` (when set) is the fuller sentence a screen reader hears instead. */
  function say(text: string, spoken = "") {
    setMessage(text);
    setSpokenMessage(spoken);
  }
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
        say("Đã kiểm tra lại quà trong đơn. Hãy xem lựa chọn và báo giá hiện tại trước khi tiếp tục.");
        return;
      }
    } catch { /* Result remains unknown: retry reads only. */ }
    unknown.current = true; setUncertain(true);
    say("Chưa xác nhận được kết quả lưu quà. Nàng kiểm tra lại quà trong giỏ và đừng nhận hoặc bỏ quà lần nữa lúc này nhé.");
  }
  function retryRead() {
    if (pending) return;
    busy.current = true; onBusyChange?.(true);
    startTransition(readback);
  }
  function change(campaignId: string, variantId: string, campaignRevision: number, quantity: number, label: string, removed: number) {
    if (locked || isLocked?.() || busy.current || unknown.current) return false;
    busy.current = true; onBusyChange?.(true);
    say(quantity === 0 || removed > 0 ? "Đang bỏ quà…" : "Đang thêm quà…");
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof setStorefrontCartGift>> | null = null;
      try { result = await setStorefrontCartGift({ campaignId, variantId, campaignRevision, quantity }); } catch { /* ambiguous */ }
      const outcome = giftMutationOutcome(result);
      if (outcome === "readback") { await readback(); return; }
      if (outcome === "saved") {
        setSavedCount((count) => count + 1);
        const swapped = result && "replaced" in result && (result.replaced ?? 0) > 0;
        // The shown text is brief on purpose; the spoken one still names the gift.
        const swapNote = swapped ? " Quà của mốc trước đã được thay bằng món này." : "";
        say(
          removed > 0 ? "Đã bỏ quà khỏi đơn." : `Đã thêm vào đơn.${swapped ? " Quà mốc trước đã được thay." : ""}`,
          removed > 0 ? `Đã bỏ ${removed} quà ${label} khỏi đơn.` : `Đã thêm vào đơn: ${label}.${swapNote}`,
        );
      } else {
        say(`Chưa ${removed > 0 ? "bỏ" : "thêm"} quà ${label}. Quyền nhận hoặc tồn kho đã thay đổi. Đang kiểm tra lại số suất thực tế.`);
        // The refusal is known, but the visible eligibility/stock may be stale.
        await readback();
        if (!unknown.current) say(`Chưa ${removed > 0 ? "bỏ" : "thêm"} quà ${label}. Lựa chọn và số suất hiện tại được cập nhật bên trên.`);
      }
    });
    return true;
  }
  return { pending, uncertain, message, spokenMessage, savedCount, change, retryRead };
}
