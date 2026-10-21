import { prisma } from "../db/prisma.ts";
import { readPancakeShopId } from "../integrations/pancake/config.ts";
import { buildShippingPromotionNotice } from "../components/headless/shipping-promotion-model.ts";
import { readActiveShippingCampaigns } from "./shipping-campaign-repository.ts";

/** Best-effort advertising only. Quote readers must NOT use this null-on-error display adapter. */
export async function readStorefrontShippingPromotion(now = new Date()) {
  try {
    return buildShippingPromotionNotice(await readActiveShippingCampaigns(prisma, readPancakeShopId(), now), now);
  } catch {
    return null;
  }
}
