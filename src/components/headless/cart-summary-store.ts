"use client";

import { useSyncExternalStore } from "react";

import { getStorefrontCartLines } from "@/commerce/storefront-cart-actions";
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
 * gates a purchase.
 */
let snapshot: CartSummary = EMPTY_CART_SUMMARY;
const listeners = new Set<() => void>();
// A late response from an earlier read must not overwrite a newer one.
let latestRead = 0;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return snapshot;
}

function getServerSnapshot() {
  return EMPTY_CART_SUMMARY;
}

export function publishCartSummary(next: CartSummary) {
  if (next.count === snapshot.count && next.totalText === snapshot.totalText) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

/** Re-reads the cart from the server and publishes the result. A failed read leaves the last one. */
export async function refreshCartSummary() {
  const read = ++latestRead;
  try {
    const lines = await getStorefrontCartLines();
    if (read !== latestRead) return;
    publishCartSummary(
      summarizeCartViewModel(buildCartViewModel({ lines, commerceTrackingEnabled: false })),
    );
  } catch {
    // The badge is a courtesy; the cart route and drawer report their own load failures.
  }
}

export function useCartSummary(): CartSummary {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
