import { connection } from "next/server";
import { readStorefrontShippingPromotion } from "@/commerce/storefront-shipping-promotion";
import { readGuestShippingPolicy } from "@/commerce/guest-shipping-policy";

import { buildShippingViewModel, type ShippingViewModel } from "./evergreen-model.ts";
import { sealRoute, type RouteHandle } from "./core.tsx";

/**
 * The Shipping page's loader.
 *
 * `readGuestShippingPolicy` is the server's own authority on shipping price, and the one thing on
 * this page that is not a static fact. Reading it here keeps the page describing what checkout will
 * actually charge rather than a number written into markup.
 */

export type ShippingRouteProps = Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>;

export async function loadShippingRoute(): Promise<RouteHandle<ShippingViewModel>> {
  await connection();
  const activeShippingPromotion = await readStorefrontShippingPromotion();
  return sealRoute({
    data: buildShippingViewModel({ policy: readGuestShippingPolicy(), activeShippingPromotion }),
    // Nothing here is promotion-priced, so it re-reads on the shared default cadence.
    refreshAfterMs: 60_000,
    trackingEvent: null,
    structuredData: [],
    pixelEvents: [],
  });
}
