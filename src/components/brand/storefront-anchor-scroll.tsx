"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";

import {
  resolveStorefrontAnchor,
  storefrontQueryAnchor,
  storefrontScrollBehavior,
} from "@/routes/storefront-anchors";

/** How long a client-side navigation waits for the new route to render the target. */
const TARGET_WAIT_ATTEMPTS = 20;
const TARGET_WAIT_INTERVAL_MS = 100;

function scrollToAnchor(): boolean {
  const targetId = resolveStorefrontAnchor(window.location.hash, window.location.search);
  if (!targetId) return true; // nothing to do
  const element = document.getElementById(targetId);
  if (!element) return false;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  element.scrollIntoView({ behavior: storefrontScrollBehavior(reduce), block: "start" });
  return true;
}

/**
 * Ensures in-page deep-linking anchors (e.g. `#san-pham`, `#mua-hang`) reliably scroll
 * into view on mobile WebViews (Facebook Messenger, Zalo, Instagram in-app browsers)
 * after Next.js App Router hydration and font/image layout settle.
 *
 * Also supports query fallback (`?scroll=san-pham` or `?anchor=san-pham`) for marketing
 * links or ad platforms that may strip URL fragment hashes during redirects. The root layout
 * persists across client-side navigation, so the effect follows the pathname and the query
 * anchor, not just the first load: `<Link href="/shop?scroll=san-pham">` scrolls too.
 */
function AnchorScrollEffect() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Only the anchor named by the query matters, not the whole query string: switching the listing
  // view (`?view=`) or a filter must not yank the shopper back to the anchor.
  const queryAnchor = storefrontQueryAnchor(searchParams.toString());

  useEffect(() => {
    // The delayed attempts exist to wait for the route to render and to correct a late layout
    // shift. Once the shopper has started scrolling themselves they must not be pulled back.
    let userMoved = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;

    function markUserMoved() {
      userMoved = true;
    }
    const interactionEvents = ["wheel", "touchstart", "keydown", "mousedown"] as const;
    for (const type of interactionEvents) {
      window.addEventListener(type, markUserMoved, { once: true, passive: true });
    }

    function attempt() {
      if (userMoved) return;
      if (scrollToAnchor()) return;
      // The target is not in the DOM yet (route still rendering): wait a bounded time for it.
      if (++attempts < TARGET_WAIT_ATTEMPTS) timer = setTimeout(attempt, TARGET_WAIT_INTERVAL_MS);
    }
    function scrollAfterLoad() {
      if (!userMoved) scrollToAnchor();
    }
    function onHashChange() {
      scrollToAnchor();
    }

    // After hydration, and again on full window load for the layout that settles after it.
    timer = setTimeout(attempt, 80);
    if (document.readyState !== "complete") {
      window.addEventListener("load", scrollAfterLoad, { once: true });
    }
    window.addEventListener("hashchange", onHashChange);

    return () => {
      clearTimeout(timer);
      window.removeEventListener("load", scrollAfterLoad);
      window.removeEventListener("hashchange", onHashChange);
      for (const type of interactionEvents) window.removeEventListener(type, markUserMoved);
    };
  }, [pathname, queryAnchor]);

  return null;
}

/** `useSearchParams` needs a Suspense boundary so it does not opt the whole layout out of static rendering. */
export function StorefrontAnchorScroll() {
  return (
    <Suspense fallback={null}>
      <AnchorScrollEffect />
    </Suspense>
  );
}
