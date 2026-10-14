"use client";

import { useState, useTransition } from "react";
import { setStorefrontCartGift } from "@/commerce/cart-gift-selection-actions";

/** Action coordination and feedback stay outside brand presentation. */
export function useCartGifts() {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState("");
  const [products, setProducts] = useState<Record<string, string>>({});
  function change(campaignId: string, variantId: string, campaignRevision: number, quantity: number) {
    startTransition(async () => {
      try {
        const result = await setStorefrontCartGift({ campaignId, variantId, campaignRevision, quantity });
        setMessage(result.ok ? quantity === 0 ? "Đã bỏ quà đã chọn." : "Đã lưu lựa chọn quà." : "Không thể lưu quà. Quyền nhận hoặc tồn kho đã thay đổi; hãy tải lại giỏ hàng và kiểm tra lựa chọn.");
      } catch { setMessage("Chưa thể lưu quà. Vui lòng thử lại."); }
    });
  }
  return { pending, message, products, setProducts, change };
}
