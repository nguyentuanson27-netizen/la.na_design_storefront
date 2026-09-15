import { connection } from "next/server";

import { getCurrentStorefrontCartLines } from "@/commerce/storefront-cart-runtime";
import { buildCartViewEvent } from "@/components/analytics/cart-funnel-tracking";
import { isCommerceTrackingEnabled } from "@/components/analytics/commerce-event-reporter";

import { buildCartViewModel, type CartViewModel } from "./cart-model.ts";
import { sealRoute, type RouteHandle } from "./core.tsx";

/** The cart's loader: the shopper's current lines and the `view_cart` event they produce. */

export type CartRouteProps = Readonly<Record<string, never>>;

export async function loadCartRoute(): Promise<RouteHandle<CartViewModel>> {
  await connection();
  const lines = await getCurrentStorefrontCartLines();

  return sealRoute({
    data: buildCartViewModel({ lines, commerceTrackingEnabled: isCommerceTrackingEnabled() }),
    // Cart prices are re-resolved on every request, so nothing here is promotion-cached; the shared
    // default cadence is what the shell mounts.
    refreshAfterMs: 60_000,
    // `buildCartViewEvent` returns null when it cannot build a safe event, which is the fail-closed
    // path the shell already handles.
    trackingEvent: buildCartViewEvent(lines),
    structuredData: [],
  });
}
