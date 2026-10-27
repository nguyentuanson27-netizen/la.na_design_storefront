"use client";

import { useSyncExternalStore } from "react";

type ConnectionHints = Readonly<{ saveData?: boolean; effectiveType?: string }>;

const SLOW_CONNECTIONS = new Set(["slow-2g", "2g"]);

function subscribeNothing() {
  return () => undefined;
}

function inlineVideoAllowed(): boolean {
  // Motion that starts by itself and never stops needs the shopper's consent (WCAG 2.2.2); the
  // operating system's reduced-motion setting is that consent withheld.
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  const connection = (navigator as Navigator & { connection?: ConnectionHints }).connection;
  if (connection?.saveData) return false;
  return !(connection?.effectiveType && SLOW_CONNECTIONS.has(connection.effectiveType));
}

/**
 * Whether a looping, muted preview may start without being asked for: not under reduced motion, not
 * with Data Saver on and not on a 2G link, where the photographs alone are what the shopper can
 * afford. False on the server and during hydration, so the markup both render agrees.
 */
export function useInlineVideoAllowed(): boolean {
  return useSyncExternalStore(subscribeNothing, inlineVideoAllowed, () => false);
}
