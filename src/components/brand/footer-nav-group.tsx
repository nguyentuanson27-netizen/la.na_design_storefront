"use client";

import { useState } from "react";
import Link from "next/link";

import type { NavigationLink } from "@/brand";

/**
 * One footer link column: a plain heading and list wherever the footer is still more than one
 * column, a disclosure that starts closed on the single-column mobile footer.
 *
 * Which of the two it is, is decided in CSS at the same 640px breakpoint `globals.css` collapses
 * `.footer-groups` at -- not by measuring the viewport here. Both the static heading and the
 * disclosure button are rendered, and the stylesheet shows exactly one of them, so the footer is
 * already in its final shape at first paint. Deciding it from `matchMedia` after mount would
 * instead render the expanded desktop column on every phone and then collapse it once hydration
 * lands, which is a visible jump in the footer a reader may already be looking at.
 *
 * React owns only `data-open`. The panel's visibility follows from it in CSS, so the panel and
 * `aria-expanded` cannot disagree, and the control that is not in play is `display: none` rather
 * than a button announcing a collapsed state next to links that are plainly visible.
 *
 * The initial `false` is the hydrated mobile default, not the no-JS one. Because the disclosure is
 * a React button, a visitor with scripting disabled could never open it, so `SiteFooter` ships a
 * `<noscript>` stylesheet that reverses the collapse for them; §33 guarantees they keep every link.
 * Any change to the mobile rules in `globals.css` has to keep that block in step, which is what
 * `tests/domain/site-footer.test.ts` and the JavaScript-disabled runtime test check.
 */
export function FooterNavGroup({
  heading,
  navigationLabel,
  panelId,
  links,
}: Readonly<{
  heading: string;
  /** The landmark's name, which the approved copy spells out where the heading abbreviates. */
  navigationLabel: string;
  panelId: string;
  links: readonly NavigationLink[];
}>) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <section className="footer-group" data-footer-group data-open={isOpen}>
      <h2 className="footer-heading">
        <span className="footer-heading__static">{heading}</span>
        <button
          type="button"
          className="footer-disclosure"
          aria-expanded={isOpen}
          aria-controls={panelId}
          onClick={() => setIsOpen((open) => !open)}
        >
          <span>{heading}</span>
          <svg
            className="footer-chevron"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </h2>
      <nav className="footer-panel" aria-label={navigationLabel} id={panelId}>
        <ul className="footer-nav-list">
          {links.map((item) => (
            <li key={item.label}>
              <Link href={item.href}>{item.label}</Link>
            </li>
          ))}
        </ul>
      </nav>
    </section>
  );
}
