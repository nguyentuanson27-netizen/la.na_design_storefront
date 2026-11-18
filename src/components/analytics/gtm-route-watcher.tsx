"use client";

// The address-bar path, `/en/checkout/success` included, as the loader's pattern reads it.
import { usePathname } from "next/navigation";
import { useEffect } from "react";

import { GTM_EAGER_CHECK_GLOBAL } from "@/integrations/gtm/eager-check";

/**
 * Tells the Tag Manager loader that the route changed.
 *
 * The loader is an inline script in the root layout, which App Router keeps mounted across client
 * navigation, so it reads the pathname only once. A shopper who lands on `/`, where the container
 * waits for an interaction, and is then sent to `/checkout/success` by a client redirect with no
 * touch or key press would otherwise wait out the fallback delay on the page where the purchase is
 * published. On each pathname change this asks the loader to re-check; it loads the container at
 * once if the new path is a conversion page and it has not started, and does nothing otherwise.
 * `history.pushState` and `replaceState` update `usePathname()` too, so they are covered.
 */
export function GtmRouteWatcher() {
  const pathname = usePathname();

  useEffect(() => {
    try {
      const check = (window as unknown as Record<string, unknown>)[GTM_EAGER_CHECK_GLOBAL];
      if (typeof check === "function") check();
    } catch {
      // Tracking never interrupts a shopper.
    }
  }, [pathname]);

  return null;
}
