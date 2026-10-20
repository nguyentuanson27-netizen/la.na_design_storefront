"use client";

import Link from "next/link";
import type { ShippingPromotionNotice } from "../headless/shipping-promotion-model";
import { useShippingPromotion } from "../headless/use-shipping-promotion";

export function ShippingPromotionNoticeView({ initial, detailed = false }: Readonly<{ initial: ShippingPromotionNotice | null; detailed?: boolean }>) {
  const notice = useShippingPromotion(initial);
  if (!notice) return null;
  return detailed ? <div className="mt-5 border-l-2 border-black/40 pl-4">
    <h3 className="font-semibold">{notice.headline}</h3><p className="mt-2 text-sm leading-6 text-black/70">{notice.detail}</p>
  </div> : <span><Link href="/shipping" className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2">{notice.headline}</Link>{" · "}</span>;
}
