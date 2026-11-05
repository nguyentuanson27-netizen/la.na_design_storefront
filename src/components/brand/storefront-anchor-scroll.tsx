"use client";

import { useEffect } from "react";

const SUPPORTED_ANCHORS = new Set([
  "san-pham",
  "products",
  "bo-loc",
  "bo-suu-tap",
  "mua-hang",
  "dat-hang",
  "chon-size",
  "chi-tiet",
]);

/**
 * Ensures in-page deep-linking anchors (e.g. `#san-pham`, `#mua-hang`) reliably scroll
 * into view on mobile WebViews (Facebook Messenger, Zalo, Instagram in-app browsers)
 * after Next.js App Router hydration and font/image layout settle.
 *
 * Also supports query fallback (`?scroll=san-pham` or `?anchor=san-pham`) for marketing
 * links or ad platforms that may strip URL fragment hashes during redirects.
 */
export function StorefrontAnchorScroll() {
  useEffect(() => {
    function resolveTargetId(): string | null {
      // 1. Check URL hash first (standard anchor link)
      const rawHash = window.location.hash.replace(/^#/, "");
      if (rawHash) {
        try {
          const decoded = decodeURIComponent(rawHash);
          if (SUPPORTED_ANCHORS.has(decoded)) return decoded;
        } catch {
          if (SUPPORTED_ANCHORS.has(rawHash)) return rawHash;
        }
      }

      // 2. Query parameter fallback if hash was omitted or stripped by ad platform
      try {
        const params = new URLSearchParams(window.location.search);
        const queryAnchor = params.get("scroll") || params.get("anchor") || params.get("view");
        if (queryAnchor && SUPPORTED_ANCHORS.has(queryAnchor)) {
          return queryAnchor;
        }
      } catch {
        // Ignore URLSearchParams error
      }

      return null;
    }

    const targetId = resolveTargetId();
    if (!targetId) return;

    function scrollToTarget() {
      const element = document.getElementById(targetId);
      if (!element) return;
      element.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    // Schedule scroll after hydration and on full window load
    const timer = setTimeout(scrollToTarget, 80);
    window.addEventListener("load", scrollToTarget, { once: true });
    window.addEventListener("hashchange", scrollToTarget);

    return () => {
      clearTimeout(timer);
      window.removeEventListener("load", scrollToTarget);
      window.removeEventListener("hashchange", scrollToTarget);
    };
  }, []);

  return null;
}
