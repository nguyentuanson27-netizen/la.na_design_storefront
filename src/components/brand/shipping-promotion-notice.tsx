"use client";

import type { ShippingPromotionNotice } from "../headless/shipping-promotion-model";
import { useShippingPromotion } from "../headless/use-shipping-promotion";

export function ShippingPromotionNoticeView({ initial }: Readonly<{ initial: ShippingPromotionNotice | null }>) {
  const notice = useShippingPromotion(initial);
  if (!notice) return null;
  return <div className="mt-5 border-l-2 border-black/40 pl-4">
    <h3 className="font-semibold">{notice.headline}</h3><p className="mt-2 text-sm leading-6 text-black/70">{notice.detail}</p>
  </div>;
}
