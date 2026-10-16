"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { setStorefrontCartGift } from "@/commerce/cart-gift-selection-actions";

/** Action coordination and feedback stay outside brand presentation. */
export function useCartGifts(onBusyChange?: (pending: boolean) => void, locked = false) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState("");
  const [products, setProducts] = useState<Record<string, string>>({});
  const busy = useRef(false);
  useEffect(() => { busy.current = pending; onBusyChange?.(pending); }, [pending, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  function change(campaignId: string, variantId: string, campaignRevision: number, quantity: number) {
    if (locked || busy.current) return;
    busy.current = true;
    onBusyChange?.(true);
    startTransition(async () => {
      try {
        const result = await setStorefrontCartGift({ campaignId, variantId, campaignRevision, quantity });
        setMessage(result.ok ? quantity === 0 ? "Đã bỏ quà đã chọn." : "Đã lưu lựa chọn quà." : "Không thể lưu quà. Quyền nhận hoặc tồn kho đã thay đổi; hãy tải lại giỏ hàng và kiểm tra lựa chọn.");
      } catch { setMessage("Chưa thể lưu quà. Vui lòng thử lại."); }
    });
  }
  return { pending, message, products, setProducts, change };
}
