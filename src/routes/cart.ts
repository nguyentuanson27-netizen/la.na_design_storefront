import { connection } from "next/server";

import { tryReadGuestShippingPolicy } from "@/commerce/guest-shipping-policy";
import { getCurrentStorefrontCartBenefits } from "@/commerce/storefront-cart-runtime";
import { loadCurrentVoucherPicker, hasPendingVoucherCode } from "@/commerce/voucher-picker-runtime";
import { buildCartViewEvent } from "@/components/analytics/cart-funnel-tracking";
import { isCommerceTrackingEnabled } from "@/components/analytics/commerce-event-reporter";

import { buildCartViewModel, canTrackLegacyCartPrices, type CartViewModel } from "./cart-model.ts";
import { sealRoute, type RouteHandle } from "./core.tsx";
import type { VoucherPickerModel } from "./voucher-picker-model.ts";

/** The cart's loader: the shopper's current lines and the `view_cart` event they produce. */

export type CartRouteProps = Readonly<Record<string, never>>;

/** The cart view plus the voucher picker, which is null whenever there is nothing to offer or the feature is OFF. */
export type CartRouteViewModel = CartViewModel & Readonly<{ vouchers: VoucherPickerModel | null; voucherLinkOffered: boolean }>;

export async function loadCartRoute(): Promise<RouteHandle<CartRouteViewModel>> {
  await connection();
  const cart = await getCurrentStorefrontCartBenefits();
  const { lines } = cart;
  const vouchers = cart.lines.length > 0 ? await loadCurrentVoucherPicker() : null;
  const voucherLinkOffered = vouchers !== null && (await hasPendingVoucherCode());

  return sealRoute({
    data: { ...buildCartViewModel({ ...cart, commerceTrackingEnabled: isCommerceTrackingEnabled(), shippingPolicy: tryReadGuestShippingPolicy() }), vouchers, voucherLinkOffered },
    // Cart prices are re-resolved on every request, so nothing here is promotion-cached; the shared
    // default cadence is what the shell mounts.
    refreshAfterMs: 60_000,
    // `buildCartViewEvent` returns null when it cannot build a safe event, which is the fail-closed
    // path the shell already handles.
    trackingEvent: canTrackLegacyCartPrices(cart) ? buildCartViewEvent(lines) : null,
    structuredData: [],
    pixelEvents: [],
  });
}
