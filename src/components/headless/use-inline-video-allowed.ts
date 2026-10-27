"use client";

import { useSyncExternalStore } from "react";

type ConnectionHints = Readonly<{ saveData?: boolean; effectiveType?: string }>;

const SLOW_CONNECTIONS = new Set(["slow-2g", "2g"]);

/** The `lg` seam: the preview belongs to the phone layout, desktop keeps its poster tile. */
export const DESKTOP_VIDEO_MEDIA = "(min-width: 1024px)";

function subscribeToLayout(onStoreChange: () => void) {
  const query = window.matchMedia(DESKTOP_VIDEO_MEDIA);
  query.addEventListener("change", onStoreChange);
  return () => query.removeEventListener("change", onStoreChange);
}

function inlineVideoAllowed(): boolean {
  if (window.matchMedia(DESKTOP_VIDEO_MEDIA).matches) return false;
  // Motion that starts by itself and never stops needs the shopper's consent (WCAG 2.2.2); the
  // operating system's reduced-motion setting is that consent withheld.
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  const connection = (navigator as Navigator & { connection?: ConnectionHints }).connection;
  if (connection?.saveData) return false;
  return !(connection?.effectiveType && SLOW_CONNECTIONS.has(connection.effectiveType));
}

/**
 * Whether a looping, muted preview may start without being asked for: on the phone layout only, not
 * under reduced motion, not with Data Saver on and not on a 2G link, where the photographs alone are
 * what the shopper can afford. False on the server and during hydration, so the markup both render
 * agrees.
 */
export function useInlineVideoAllowed(): boolean {
  return useSyncExternalStore(subscribeToLayout, inlineVideoAllowed, () => false);
}
