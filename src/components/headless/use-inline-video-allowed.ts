"use client";

import { useSyncExternalStore } from "react";

type ConnectionHints = EventTarget & Readonly<{ saveData?: boolean; effectiveType?: string }>;

const REDUCED_MOTION_MEDIA = "(prefers-reduced-motion: reduce)";

const SLOW_CONNECTIONS = new Set(["slow-2g", "2g"]);

/**
 * Where the video sits. Below `lg` (`phone`) it is a frame on the photograph. From `lg` up, in a window
 * tall enough, it is a floating mini-player (`float`): 299px tall, 104px off the bottom edge and
 * under the sticky header (about 88px), so a window shorter than 520px would push it, and the stop
 * button on its corner, up under the header or past the top of the screen. There (`dock`) it stays a
 * small poster tile on the photograph, with no preview.
 */
export type VideoLayout = "phone" | "float" | "dock";

const WIDE_MEDIA = "(min-width: 1024px)";
export const FLOATING_VIDEO_MEDIA = "(min-width: 1024px) and (min-height: 520px)";

function subscribeToLayout(onStoreChange: () => void) {
  const queries = [window.matchMedia(WIDE_MEDIA), window.matchMedia(FLOATING_VIDEO_MEDIA)];
  for (const query of queries) query.addEventListener("change", onStoreChange);
  return () => { for (const query of queries) query.removeEventListener("change", onStoreChange); };
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

function videoLayout(): VideoLayout {
  if (!window.matchMedia(WIDE_MEDIA).matches) return "phone";
  return window.matchMedia(FLOATING_VIDEO_MEDIA).matches ? "float" : "dock";
}

/** Which of the three layouts the window is in. `phone` on the server and during hydration. */
export function useVideoLayout(): VideoLayout {
  return useSyncExternalStore(subscribeToLayout, videoLayout, () => "phone");
}
