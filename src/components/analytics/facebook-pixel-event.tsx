"use client";

import { useEffect, useRef } from "react";
import { trackMetaBrowserEvent } from "./meta-browser-client";

import {
  trackFacebookPixelEvent,
  type FacebookPixelEventParameters,
} from "./facebook-pixel-client";

type FacebookPixelEventProps = {
  name: string;
  parameters?: FacebookPixelEventParameters;
  /** Set where a Conversions API twin exists, so Meta counts the pair as one conversion. */
  eventId?: string;
  /**
   * Report this event at most once per browser, keyed by `eventId`. Meta only deduplicates by
   * event id inside its own window, so a confirmation page that someone bookmarks and reopens
   * weeks later would otherwise report the same order's revenue again.
   */
  once?: boolean;
  capiReceipt?: string;
};

const REPORTED_STORAGE_PREFIX = "la:fb-pixel-reported:";

function hasAlreadyReported(storageKey: string): boolean {
  try {
    return window.localStorage.getItem(storageKey) !== null;
  } catch {
    // Storage can be unavailable (private mode, blocked cookies). Reporting twice is a better
    // failure than never reporting a sale at all.
    return false;
  }
}

function markReported(storageKey: string): void {
  try {
    window.localStorage.setItem(storageKey, "1");
  } catch {
    // See above: the event still goes out, it just is not remembered.
  }
}

/**
 * Reports one page-level event when the page it sits on mounts.
 *
 * Deliberately fires once per mount rather than tracking its props: `parameters` is a fresh object
 * on every render, so a dependency on it would report the same checkout over and over.
 */
export function FacebookPixelEvent({ name, parameters, eventId, once, capiReceipt }: FacebookPixelEventProps) {
  const hasReported = useRef(false);

  useEffect(() => {
    if (hasReported.current) return;
    hasReported.current = true;

    const storageKey =
      once === true && eventId !== undefined ? `${REPORTED_STORAGE_PREFIX}${eventId}` : null;
    if (storageKey !== null && hasAlreadyReported(storageKey)) return;

    if (name === "ViewContent" || name === "InitiateCheckout") {
      trackMetaBrowserEvent(name, parameters, capiReceipt);
      return;
    }

    trackMetaBrowserEvent("PageView");

    // Recorded only once the loaded pixel has taken the event. Marking it up front would suppress
    // a reload's retry for a call still sitting in a queue the pixel never came to drain — turning
    // a delivery failure into a permanently missing sale.
    trackFacebookPixelEvent(name, parameters, eventId, () => {
      if (storageKey !== null) markReported(storageKey);
    });
  }, [capiReceipt, eventId, name, once, parameters]);

  return null;
}
