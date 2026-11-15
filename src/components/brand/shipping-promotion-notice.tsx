"use client";

import { useCampaignName, useT } from "@/i18n/client";
import type { ShippingPromotionNotice } from "../headless/shipping-promotion-model";
import { useShippingPromotion } from "../headless/use-shipping-promotion";

/** "{name}. {rule sentences}": the name by itself, the sentences through the catalog. */
function detailOf(
  notice: ShippingPromotionNotice,
  t: (source: string) => string,
  campaignName: (name: string) => string,
): string {
  const prefix = `${notice.campaignName}. `;
  return notice.detail.startsWith(prefix)
    ? `${campaignName(notice.campaignName)}. ${t(notice.detail.slice(prefix.length))}`
    : t(notice.detail);
}

export function ShippingPromotionNoticeView({ initial }: Readonly<{ initial: ShippingPromotionNotice | null }>) {
  const t = useT();
  const campaignName = useCampaignName();
  const notice = useShippingPromotion(initial);
  if (!notice) return null;
  return <div className="mt-5 border-l-2 border-black/40 pl-4">
    <h3 className="font-semibold">{t(notice.headline)}</h3><p className="mt-2 text-sm leading-6 text-black/70">{detailOf(notice, t, campaignName)}</p>
  </div>;
}
