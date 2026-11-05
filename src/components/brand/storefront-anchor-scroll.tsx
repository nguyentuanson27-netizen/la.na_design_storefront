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
        let decoded = rawHash;
        try {
          decoded = decodeURIComponent(rawHash);
        } catch {
          // Malformed escape: fall back to the raw fragment.
        }
        if (SUPPORTED_ANCHORS.has(decoded)) return decoded;
      }

      // 2. Query parameter fallback if hash was omitted or stripped by ad platform
      const params = new URLSearchParams(window.location.search);
      const queryAnchor = params.get("scroll") || params.get("anchor");
      if (queryAnchor && SUPPORTED_ANCHORS.has(queryAnchor)) return queryAnchor;

      return null;
    }

    // The target is re-resolved on every attempt so a later `hashchange` goes to the new fragment,
    // not the one that was present at mount.
    function scrollToTarget() {
      const targetId = resolveTargetId();
      if (!targetId) return;
      document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    // The delayed initial attempts exist to correct a late layout shift. Once the shopper has
    // started scrolling themselves they must not be pulled back to the anchor.
    let userMoved = false;
    function markUserMoved() {
      userMoved = true;
    }
    function scrollUnlessUserMoved() {
      if (!userMoved) scrollToTarget();
    }

    const interactionEvents = ["wheel", "touchstart", "keydown", "mousedown"] as const;
    for (const type of interactionEvents) {
      window.addEventListener(type, markUserMoved, { once: true, passive: true });
    }

    // Schedule scroll after hydration and on full window load
    const timer = setTimeout(scrollUnlessUserMoved, 80);
    window.addEventListener("load", scrollUnlessUserMoved, { once: true });
    window.addEventListener("hashchange", scrollToTarget);

    return () => {
      clearTimeout(timer);
      window.removeEventListener("load", scrollUnlessUserMoved);
      window.removeEventListener("hashchange", scrollToTarget);
      for (const type of interactionEvents) window.removeEventListener(type, markUserMoved);
    };
  }, []);

  return null;
}
