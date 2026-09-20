"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

import { trackFacebookPixelEvent } from "./facebook-pixel-client";

/**
 * Reports PageView for real client-side URL changes.
 *
 * The base snippet already reports the document load. Router state can re-emit an equivalent
 * pathname/search value during hydration or development checks, so "skip the first effect" is not
 * enough: remember the last logical URL and report only when that value actually changes.
 */
export function FacebookPixelRouteTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const lastRoute = useRef<string | null>(null);

  useEffect(() => {
    const search = searchParams.toString();
    const route = search.length > 0 ? `${pathname}?${search}` : pathname;

    if (lastRoute.current === null) {
      lastRoute.current = route;
      return;
    }
    if (lastRoute.current === route) return;

    lastRoute.current = route;
    trackFacebookPixelEvent("PageView");
  }, [pathname, searchParams]);

  return null;
}
