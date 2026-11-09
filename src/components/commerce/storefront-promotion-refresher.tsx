"use client";

import { useEffect } from "react";
import { useRouter } from "@/i18n/navigation";

import { MAX_STOREFRONT_PROMOTION_REFRESH_MS } from "@/commerce/storefront-promotion-freshness";

/**
 * Revalidates a promotion-priced storefront surface from a server-computed relative duration.
 *
 * The timer self-rearms after it fires. This matters when a server refresh returns the same duration
 * (most commonly the 60s fallback): React is then free to preserve this component without rerunning
 * the effect, but the visible page must still keep the <=60s freshness guarantee. The first delay can
 * be zero for a just-crossed boundary; subsequent fallback revalidation is capped at 60s so a stale
 * zero cannot become a runaway loop while the server response is in flight.
 */
export function StorefrontPromotionRefresher({ refreshAfterMs }: { refreshAfterMs: number }) {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const revalidate = () => {
      if (cancelled) return;
      router.refresh();
    };

    const armFallback = () => {
      if (cancelled) return;
      timer = setTimeout(() => {
        revalidate();
        armFallback();
      }, MAX_STOREFRONT_PROMOTION_REFRESH_MS);
    };

    const safeInitialDelay = Number.isFinite(refreshAfterMs)
      ? Math.min(
          Math.max(0, refreshAfterMs),
          MAX_STOREFRONT_PROMOTION_REFRESH_MS,
        )
      : MAX_STOREFRONT_PROMOTION_REFRESH_MS;

    timer = setTimeout(() => {
      revalidate();
      // If the refreshed server tree supplies a different duration, React cleans up this effect and
      // arms from that new value. If it supplies the same duration, this fallback keeps the loop
      // alive instead of relying on a prop change that never happened.
      armFallback();
    }, safeInitialDelay);

    const onVisible = () => {
      if (document.visibilityState === "visible") revalidate();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) revalidate();
    };

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onPageShow);

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [refreshAfterMs, router]);

  return null;
}
