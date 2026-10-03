"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useLayoutEffect } from "react";

import { isZaloSafeLocation, isZaloSafeReferrer } from "@/integrations/zalo-ads/url-safety";

const SCRIPT_ID = "zalo-ads-pixel";
const QUARANTINE_ID = "zalo-ads-pixel-quarantine";

/**
 * Inserts the official Zalo tag only where the tracker may observe the page, and cuts it off when
 * the app navigates somewhere it may not.
 *
 * The decision is taken once per document, from the real address and referrer: either both are
 * safe (url-safety.ts) and the tag goes into <head> exactly as the official snippet would put it,
 * or the tracker never loads in this document. After it has loaded, every App Router navigation is
 * checked against the router's target URL; the first unsafe one adds the quarantine <meta> policy,
 * so the browser blocks every Zalo beacon from then on. That runs as a layout effect, inside the
 * same synchronous commit as the router's own history update, so no tracker timer can report the
 * new URL in between. Nothing here may throw into the page.
 */
export function ZaloAdsPixelLoader({
  src,
  quarantinePolicy,
}: Readonly<{ src: string; quarantinePolicy: string }>) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useLayoutEffect(() => {
    try {
      const origin = window.location.origin;
      const decided = document.documentElement.dataset.laZaloAdsPixel;

      if (decided === undefined) {
        const allowed =
          isZaloSafeLocation(window.location.href, origin)
          && isZaloSafeReferrer(document.referrer, origin);
        document.documentElement.dataset.laZaloAdsPixel = allowed ? "loaded" : "blocked";
        if (allowed) {
          const script = document.createElement("script");
          script.id = SCRIPT_ID;
          script.async = true;
          script.src = src;
          document.head.appendChild(script);
        }
        return;
      }

      if (decided !== "loaded" || document.getElementById(QUARANTINE_ID) !== null) return;
      const search = searchParams.toString();
      const target = `${origin}${pathname}${search.length > 0 ? `?${search}` : ""}`;
      if (isZaloSafeLocation(target, origin)) return;

      const policy = document.createElement("meta");
      policy.id = QUARANTINE_ID;
      policy.httpEquiv = "Content-Security-Policy";
      policy.content = quarantinePolicy;
      document.head.appendChild(policy);
      document.documentElement.dataset.laZaloAdsPixel = "quarantined";
    } catch {
      // Tracking is optional; the storefront must keep working whatever the tracker or DOM does.
    }
  }, [pathname, searchParams, src, quarantinePolicy]);

  return null;
}
