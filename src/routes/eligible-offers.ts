import { cookies, headers } from "next/headers";
import { connection } from "next/server";

import { readAuthServerConfig } from "@/auth/config";
import { upsellReadGate } from "@/commerce/checkout-upsell-read-gate";
import { deriveGuestCheckoutClientKey } from "@/commerce/guest-checkout-client-identity";
import { createGuestCheckoutRateLimiter } from "@/commerce/guest-checkout-rate-limit";
import { createPromotionUpsellService, type CheckoutUpsellBrowse } from "@/commerce/promotion-upsell";
import { isPromotionUpsellEnabled } from "@/commerce/promotion-upsell-policy";
import { prisma } from "@/db/prisma";
import { readPancakeShopId } from "@/integrations/pancake/config";
import { sealRoute, type RouteHandle } from "./core.tsx";

/** Personalized, read-only offer listing; the view never authorizes a cart mutation. */
export type EligibleOffersRouteProps = Readonly<{ searchParams: Promise<{ campaign?: string | string[] }> }>;
export type EligibleOffersViewModel = Readonly<{ offer: CheckoutUpsellBrowse | null; limited: boolean }>;

export async function loadEligibleOffersRoute({ searchParams }: EligibleOffersRouteProps): Promise<RouteHandle<EligibleOffersViewModel>> {
  await connection();
  const { campaign } = await searchParams;
  const campaignId = typeof campaign === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(campaign)
    ? campaign : null;
  let offer: CheckoutUpsellBrowse | null = null;
  let limited = false;
  if (campaignId) {
    // An optional GET must have the same resource protections as the checkout POST.
    // Acquire before hitting the DB; neither a queue nor a failure can block COD checkout.
    const release = upsellReadGate.tryAcquire();
    if (!release) {
      limited = true;
    } else {
      try {
        const auth = readAuthServerConfig();
        const shopId = readPancakeShopId();
        if (isPromotionUpsellEnabled(shopId)) {
          const clientKey = deriveGuestCheckoutClientKey(await headers(), auth);
          // Shared across instances and with POST /api/checkout/upsell: 20 attempts/minute
          // per trusted client, independent of the geo and checkout-submit buckets.
          if (!(await createGuestCheckoutRateLimiter(prisma).consumeUpsellClient({ clientKey }))) {
            limited = true;
          } else {
            offer = await createPromotionUpsellService(prisma, await cookies(), {
              shopId, secret: auth.secret,
            }).getBrowse(campaignId);
          }
        }
      } catch {
        // Fail closed on invalid identity, unavailable limiter or quote failure.
      } finally {
        release();
      }
    }
  }

  return sealRoute({
    data: { offer, limited },
    refreshAfterMs: 60_000,
    trackingEvent: null,
    structuredData: [],
    pixelEvents: [],
  });
}
