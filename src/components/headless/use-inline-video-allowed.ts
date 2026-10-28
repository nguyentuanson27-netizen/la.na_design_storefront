"use client";

import { useSyncExternalStore } from "react";

type ConnectionHints = EventTarget & Readonly<{ saveData?: boolean; effectiveType?: string }>;

const REDUCED_MOTION_MEDIA = "(prefers-reduced-motion: reduce)";

const SLOW_CONNECTIONS = new Set(["slow-2g", "2g"]);

/** The `lg` seam: below it the preview is a frame on the photograph, from it a floating mini-player. */
export const DESKTOP_VIDEO_MEDIA = "(min-width: 1024px)";

function subscribeToLayout(onStoreChange: () => void) {
  const query = window.matchMedia(DESKTOP_VIDEO_MEDIA);
  query.addEventListener("change", onStoreChange);
  return () => query.removeEventListener("change", onStoreChange);
}

function networkConnection(): ConnectionHints | undefined {
  return (navigator as Navigator & { connection?: ConnectionHints }).connection;
}

/** The two settings a shopper can change while the page is open: motion, and Data Saver / link speed. */
function subscribeToAllowance(onStoreChange: () => void) {
  const motion = window.matchMedia(REDUCED_MOTION_MEDIA);
  const connection = networkConnection();
  motion.addEventListener("change", onStoreChange);
  connection?.addEventListener("change", onStoreChange);
  return () => {
    motion.removeEventListener("change", onStoreChange);
    connection?.removeEventListener("change", onStoreChange);
  };
}

function inlineVideoAllowed(): boolean {
  // Motion that starts by itself and never stops needs the shopper's consent (WCAG 2.2.2); the
  // operating system's reduced-motion setting is that consent withheld.
  if (window.matchMedia(REDUCED_MOTION_MEDIA).matches) return false;
  const connection = networkConnection();
  if (connection?.saveData) return false;
  return !(connection?.effectiveType && SLOW_CONNECTIONS.has(connection.effectiveType));
}

/**
 * Whether a looping, muted preview may start without being asked for: not under reduced motion, not
 * with Data Saver on and not on a 2G link, where the photographs alone are what the shopper can
 * afford. False on the server and during hydration, so the markup both render agrees.
 */
export function useInlineVideoAllowed(): boolean {
  return useSyncExternalStore(subscribeToAllowance, inlineVideoAllowed, () => false);
}

function desktopLayout(): boolean {
  return window.matchMedia(DESKTOP_VIDEO_MEDIA).matches;
}

/** Whether the desktop layout is showing. False on the server and during hydration. */
export function useDesktopVideoLayout(): boolean {
  return useSyncExternalStore(subscribeToLayout, desktopLayout, () => false);
}
