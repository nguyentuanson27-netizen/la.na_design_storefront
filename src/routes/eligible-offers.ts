import { cookies, headers } from "next/headers";
import { connection } from "next/server";

import { readAuthServerConfig } from "@/auth/config";
import { readAnonymousCartCookie } from "@/commerce/anonymous-cart-cookie";
import { isTrustedUpsellBrowseRequest } from "@/commerce/checkout-upsell-http";
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
const empty: EligibleOffersViewModel = { offer: null, limited: false };

async function browseForCart(campaignId: string): Promise<EligibleOffersViewModel> {
  try {
    const store = await cookies();
    const cartId = readAnonymousCartCookie(store);
    // A missing/malformed cart never consumes the checkout banner's shared IP quota.
    if (!cartId) return empty;

    const auth = readAuthServerConfig();
    const requestHeaders = await headers();
    // SameSite=Lax alone does not stop cross-site top-level GET navigation.
    // Reject cross-origin and speculative fetches before acquiring a slot or touching the DB.
    if (!isTrustedUpsellBrowseRequest(requestHeaders, auth.baseURL)) return empty;
    const shopId = readPancakeShopId();
    if (!isPromotionUpsellEnabled(shopId)) return empty;

    const release = upsellReadGate.tryAcquire();
    if (!release) return { ...empty, limited: true };
    try {
      const clientKey = deriveGuestCheckoutClientKey(requestHeaders, auth);
      const limiter = createGuestCheckoutRateLimiter(prisma);
      // A separate DB bucket bounds even forged, well-formed cookie IDs across app instances.
      // It cannot use up the POST banner's 20/minute budget.
      if (!(await limiter.consumeUpsellBrowseClient({ clientKey }))) return { ...empty, limited: true };
      const cart = await prisma.cart.findFirst({
        where: { id: cartId, userId: null, expiresAt: { gt: new Date() }, items: { some: {} } },
        select: { id: true },
      });
      if (!cart) return empty;
      // Only a confirmed, unexpired guest cart may spend the shared POST upsell budget.
      if (!(await limiter.consumeUpsellClient({ clientKey }))) return { ...empty, limited: true };
      const offer = await createPromotionUpsellService(prisma, store, { shopId, secret: auth.secret }).getBrowse(campaignId);
      return { offer, limited: false };
    } finally {
      release();
    }
  } catch {
    // Optional recommendations always fail closed; checkout submit and quote remain independent.
    return empty;
  }
}

export async function loadEligibleOffersRoute({ searchParams }: EligibleOffersRouteProps): Promise<RouteHandle<EligibleOffersViewModel>> {
  await connection();
  const { campaign } = await searchParams;
  const campaignId = typeof campaign === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(campaign)
    ? campaign : null;
  const data = campaignId ? await browseForCart(campaignId) : empty;
  return sealRoute({
    data,
    refreshAfterMs: 60_000,
    trackingEvent: null,
    structuredData: [],
    pixelEvents: [],
  });
}
