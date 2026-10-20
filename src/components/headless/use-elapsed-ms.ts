"use client";

import { useEffect, useState } from "react";

/**
 * Milliseconds since `snapshot` arrived from the server, ticking once a second; 0 for `null`.
 *
 * A countdown subtracts this from the duration the server measured when it built `snapshot`,
 * rather than reading a deadline against the browser's clock, which may be wrong. It starts at 0, so
 * the first client render matches the server's and hydration has nothing to reconcile.
 *
 * The clock is anchored to the snapshot, not to the mount. `router.refresh()` (the promotion
 * refresher runs it at least once a minute) delivers a new snapshot whose durations were measured
 * just now while this component keeps its state; counting from the mount would subtract the time
 * already spent a second time. A new snapshot therefore restarts the count at 0. Switching the
 * variant a countdown follows reads another duration from the same snapshot, so the time already
 * spent still applies.
 */
export function useElapsedMs(snapshot: object | null): number {
  const [tick, setTick] = useState<Readonly<{ snapshot: object | null; elapsed: number }>>({
    snapshot,
    elapsed: 0,
  });
  // A new snapshot restarts the count during render, so no frame shows its durations minus the
  // previous snapshot's elapsed time.
  if (tick.snapshot !== snapshot) setTick({ snapshot, elapsed: 0 });

  useEffect(() => {
    if (snapshot === null) return;
    const start = performance.now();
    const id = window.setInterval(() => setTick({ snapshot, elapsed: performance.now() - start }), 1000);
    return () => window.clearInterval(id);
  }, [snapshot]);

  return tick.snapshot === snapshot ? tick.elapsed : 0;
}
