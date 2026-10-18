"use client";

import type { ReactNode } from "react";

/**
 * UX-08 / AC-19 — a link from the "cannot check out yet" notice to the cart line that needs attention.
 *
 * A plain fragment link without script. With script it also moves focus onto the line, which a fragment
 * navigation alone does not reliably do, so a keyboard or screen-reader user lands where the fix is.
 */
export function CartLineJumpLink({ targetId, children }: Readonly<{ targetId: string; children: ReactNode }>) {
  return (
    <a
      className="underline underline-offset-4"
      href={`#${targetId}`}
      onClick={(event) => {
        const target = document.getElementById(targetId);
        if (!target) return;
        event.preventDefault();
        target.scrollIntoView({ block: "center" });
        target.focus({ preventScroll: true });
        history.replaceState(history.state, "", `#${targetId}`);
      }}
    >
      {children}
    </a>
  );
}
