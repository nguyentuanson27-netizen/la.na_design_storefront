"use client";

// The address-bar path, `/en/shop` included -- not the storefront's own route-path hook, which
// strips the language prefix for route matching. A report is about the URL that was seen, and the
// two language versions of a page are different URLs to marketing and search.
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

import { buildPageViewEvent } from "@/tracking/commerce-events";
import { publishBrowserTrackingEvent } from "@/tracking/data-layer";

/**
 * Reports exactly one `page_view` for the initial render and one for each App Router navigation.
 *
 * Unlike the Meta snippet, nothing else fires an initial page view here, so the first render is
 * reported rather than skipped. `searchParams` is part of the effect key so a query-only navigation
 * still counts as a navigation, while the event itself carries only the path.
 */
export function TrackingPageViewReporter() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const lastReported = useRef<string | null>(null);

  useEffect(() => {
    const location = `${pathname}?${searchParams}`;
    if (lastReported.current === location) return;
    lastReported.current = location;

    try {
      publishBrowserTrackingEvent(buildPageViewEvent({ pathname }));
    } catch {
      // Tracking never interrupts a shopper.
    }
  }, [pathname, searchParams]);

  return null;
}
