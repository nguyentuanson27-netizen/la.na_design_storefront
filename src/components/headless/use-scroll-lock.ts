"use client";

import { useEffect } from "react";

/**
 * Hold the page still while a full-screen overlay is open.
 *
 * `document.body.style.overflow = "hidden"` is the usual one-liner for this, and on this site it
 * does nothing. The viewport takes its overflow from the **root** element and falls back to `body`
 * only when the root computes to `visible` on both axes -- but `globals.css` sets
 * `html { overflow-x: clip }` so the full-bleed grids cannot widen the page. That stops the
 * propagation, so hiding body's overflow only turns the body box into a scroll container while the
 * viewport carries on scrolling behind the overlay.
 *
 * Measured on the homepage at 390x844 with the mobile menu open: a 500px wheel moved
 * `window.scrollY` from 0 to 500. `editorial.spec.ts` reproduces it for the menu and the search
 * dialog.
 *
 * So both elements are locked, with inline styles that outrank the stylesheet and are restored
 * exactly as they were. `html` becoming a scroll container for the duration is harmless: the
 * sticky masthead that `overflow-x: clip` protects is behind a full-screen dialog while this is in
 * effect.
 *
 * This lives in one place because it was written twice -- once in the header, once in the search
 * overlay -- and both copies carried the same defect. A second copy is how the next overlay
 * inherits it again.
 */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;

    const root = document.documentElement;
    const originalBodyOverflow = document.body.style.overflow;
    const originalRootOverflow = root.style.overflow;

    document.body.style.overflow = "hidden";
    root.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = originalBodyOverflow;
      root.style.overflow = originalRootOverflow;
    };
  }, [active]);
}
