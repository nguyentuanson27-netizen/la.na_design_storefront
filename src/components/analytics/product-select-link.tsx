"use client";

import Link from "@/i18n/link";
import type { ReactNode } from "react";

import type { TrackingEvent } from "@/tracking/commerce-events";
import { publishBrowserTrackingEvent } from "@/tracking/data-layer";

/**
 * A product card's link, which reports `select_item` for the card the shopper actually clicked.
 *
 * The event is built on the server and passed here whole. That is deliberate: a click handler that
 * assembled an item from rendered text would be reading a price out of the DOM, which is the exact
 * thing the canonical contract exists to prevent. `null` means this deployment publishes no
 * commerce events, or the product had no safe identity, and the link behaves as an ordinary link.
 *
 * Navigation is never conditional on the event. The publisher cannot throw, and the guard below
 * covers anything else, so a blocked dataLayer costs the shopper nothing.
 */
export function ProductSelectLink({
  href,
  className,
  ariaLabel,
  event,
  children,
}: {
  href: string;
  className?: string;
  ariaLabel?: string;
  event: TrackingEvent | null;
  children: ReactNode;
}) {
  return (
    <Link
      aria-label={ariaLabel}
      className={className}
      href={href}
      onClick={() => {
        if (event === null) return;
        try {
          publishBrowserTrackingEvent(event);
        } catch {
          // Tracking never interrupts a shopper.
        }
      }}
    >
      {children}
    </Link>
  );
}
