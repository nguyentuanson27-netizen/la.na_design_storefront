import { deriveCampaignLifecycle } from "../../commerce/promotion-campaign-lifecycle.ts";
import { validateShippingCampaign, MAX_SHIPPING_CAMPAIGNS, type ShippingCampaign } from "../../commerce/shipping-campaign.ts";

/** Public copy only: no internal product ids, campaign ids or mutable pricing authority reaches the browser. */
export type ShippingPromotionNotice = Readonly<{
  headline: string;
  detail: string;
  observedAtMs: number;
  expiresAtMs: number | null;
}>;

export function buildShippingPromotionNotice(campaigns: readonly ShippingCampaign[], now: Date): ShippingPromotionNotice | null {
  if (!Number.isFinite(now.getTime()) || campaigns.length > MAX_SHIPPING_CAMPAIGNS) throw new RangeError("Invalid shipping presentation input");
  const campaign = [...campaigns].sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .find((candidate) => deriveCampaignLifecycle({ ...candidate, now }).status === "ACTIVE");
  if (!campaign) return null;
  if (!validateShippingCampaign(campaign).ok) throw new RangeError("Invalid shipping presentation campaign");
  return Object.freeze({
    headline: `Miễn phí vận chuyển từ ${campaign.minimumQuantity} sản phẩm áp dụng`,
    detail: `${campaign.name}. Chỉ tính sản phẩm mua trong phạm vi chiến dịch, không tính quà tặng. ${campaign.stackingEnabled ? "Được cộng dồn với giảm giá và quà tặng." : "Không cộng dồn với giảm giá và quà tặng."} Giỏ hàng và thanh toán kiểm tra điều kiện hiện tại.`,
    observedAtMs: now.getTime(), expiresAtMs: campaign.endsAt?.getTime() ?? null,
  });
}
