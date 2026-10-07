"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";

import { trackMetaBrowserEvent } from "./meta-browser-client";

/**
 * Reports PageView for real client-side URL changes.
 *
 * Includes the initial document view; the browser helper suppresses equivalent refresh/remounts.
 */
export function FacebookPixelRouteTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    trackMetaBrowserEvent("PageView");
  }, [pathname, searchParams]);

  return null;
}
