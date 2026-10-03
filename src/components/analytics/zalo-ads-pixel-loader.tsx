"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useLayoutEffect } from "react";

import {
  quarantineZaloAdsPixel,
  readZaloAdsPixelState,
  startZaloAdsPixel,
  watchZaloAdsLocation,
  type GuardDocument,
  type GuardWindow,
} from "@/integrations/zalo-ads/pixel-guard";

/**
 * Inserts the official Zalo tag only where the tracker may observe the page, and cuts it off when
 * the URL changes to somewhere it may not (src/integrations/zalo-ads/pixel-guard.ts).
 *
 * App Router navigations are checked as a layout effect, inside the same synchronous commit as the
 * router's own history update, against both the router's target and the live address (which also
 * carries the fragment). Fragment changes, history traversal and other same-document URL changes
 * the router does not surface are watched directly.
 */
export function ZaloAdsPixelLoader({
  src,
  quarantinePolicy,
}: Readonly<{ src: string; quarantinePolicy: string }>) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useLayoutEffect(() => {
    const win = window as unknown as GuardWindow;
    const doc = document as unknown as GuardDocument;
    if (readZaloAdsPixelState(doc) === null) {
      startZaloAdsPixel(win, doc, src);
      return;
    }
    const search = searchParams.toString();
    const target = `${win.location.origin}${pathname}${search.length > 0 ? `?${search}` : ""}`;
    quarantineZaloAdsPixel(win, doc, quarantinePolicy, [target, win.location.href]);
  }, [pathname, searchParams, src, quarantinePolicy]);

  useEffect(
    () => watchZaloAdsLocation(window as unknown as GuardWindow, document as unknown as GuardDocument, quarantinePolicy),
    [quarantinePolicy],
  );

  return null;
}
