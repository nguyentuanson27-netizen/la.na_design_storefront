"use client";

import { useSyncExternalStore } from "react";

import { getStorefrontCartLines } from "@/commerce/storefront-cart-actions";
import { createCartSummaryStore } from "@/components/headless/cart-summary-store-core";
import {
  buildCartViewModel,
  EMPTY_CART_SUMMARY,
  summarizeCartViewModel,
  type CartSummary,
} from "@/routes/cart-model";

/**
 * Window-wide "does the cart have something in it" fact, shared by the header badge and the mobile
 * purchase bar.
 *
 * The cart itself stays server-authoritative: this only mirrors what the last server read said, so
 * the chrome can reassure the shopper after the drawer closes. It is a presentation hint and never
 * gates a purchase. The ordering rules live in `cart-summary-store-core.ts`.
 */
const store = createCartSummaryStore(async () => {
  const lines = await getStorefrontCartLines();
  return summarizeCartViewModel(buildCartViewModel({ lines, commerceTrackingEnabled: false }));
});

export const publishCartSummary = store.publish;
export const refreshCartSummary = store.refresh;

export function useCartSummary(): CartSummary {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => EMPTY_CART_SUMMARY);
}
