"use client";

import { useEffect, useState } from "react";
import { getStorefrontShippingPromotion } from "../../commerce/storefront-shipping-promotion-actions";
import type { ShippingPromotionNotice } from "./shipping-promotion-model";

/** Keeps the /shipping notice live: refresh it while the tab is visible and drop expired copy without waiting for navigation. */
export function useShippingPromotion(initial: ShippingPromotionNotice | null) {
  const [notice, setNotice] = useState(initial);
  useEffect(() => {
    let disposed = false;
    let sequence = 0;
    let expiration: ReturnType<typeof setTimeout> | undefined;
    function expire(value: ShippingPromotionNotice | null, elapsed = 0) {
      clearTimeout(expiration);
      if (value?.expiresAtMs !== null && value?.expiresAtMs !== undefined) {
        const remaining = Math.max(0, value.expiresAtMs - value.observedAtMs - elapsed);
        // The interval below rechecks long windows before a timer's signed-int limit is reached.
        expiration = setTimeout(() => { if (!disposed) setNotice(null); }, Math.min(remaining, 2_147_483_647));
      }
    }
    async function refresh() {
      if (document.visibilityState === "hidden") return;
      const request = ++sequence;
      const started = performance.now();
      try {
        const next = await getStorefrontShippingPromotion();
        if (disposed || request !== sequence) return;
        const elapsed = performance.now() - started;
        const fresh = next && next.expiresAtMs !== null && next.expiresAtMs - next.observedAtMs <= elapsed ? null : next;
        setNotice(fresh);
        expire(fresh, elapsed);
      } catch {
        if (!disposed && request === sequence) { setNotice(null); clearTimeout(expiration); }
      }
    }
    expire(initial);
    void refresh();
    const interval = setInterval(() => { void refresh(); }, 60_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { disposed = true; clearInterval(interval); clearTimeout(expiration); document.removeEventListener("visibilitychange", refresh); };
  }, [initial]);
  return notice;
}
