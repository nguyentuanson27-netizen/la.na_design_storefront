"use client";

import { useEffect, useState } from "react";

/**
 * Milliseconds since this page hydrated, ticking once a second while `active`.
 *
 * A countdown subtracts this from the server's remaining duration rather than reading a deadline
 * against the browser's clock, which may be wrong. It starts at 0, so the first client render
 * matches the server's and hydration has nothing to reconcile.
 *
 * One clock for the page: switching the variant a countdown follows changes the duration it
 * subtracts from, not when it started counting.
 */
export function useElapsedMs(active: boolean): number {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!active) return;
    const start = performance.now();
    const id = window.setInterval(() => setElapsed(performance.now() - start), 1000);
    return () => window.clearInterval(id);
  }, [active]);

  return elapsed;
}
