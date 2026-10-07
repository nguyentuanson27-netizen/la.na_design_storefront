"use client";

import { trackFacebookPixelEvent, type FacebookPixelEventParameters } from "./facebook-pixel-client";
import type { CommittedMetaEvent } from "@/commerce/meta-event-reporting";
import { readMetaPagePath } from "@/integrations/meta/page-source";

const CONFIGURED = (process.env.LA_BUILD_FACEBOOK_PIXEL_ID ?? "").length > 0;
let observedUrl: string | null = null;
const observedEvents = new Set<string>();

export function trackMetaBrowserEvent(name: "PageView" | "ViewContent" | "InitiateCheckout",
  parameters?: FacebookPixelEventParameters, receipt?: string): void {
  if (!CONFIGURED || typeof window === "undefined") return;
  try {
    const url = `${window.location.pathname}${window.location.search}`;
    if (observedUrl !== url) { observedUrl = url; observedEvents.clear(); }
    const path = readMetaPagePath(window.location.pathname);
    if (!path) return;
    // Child effects can run before the layout tracker. Preserve document event order in both twins.
    if (name !== "PageView" && !observedEvents.has("PageView")) trackMetaBrowserEvent("PageView");
    if (observedEvents.has(name)) return;
    observedEvents.add(name);
    const eventId = crypto.randomUUID();
    trackFacebookPixelEvent(name, parameters, eventId);
    const signal = name === "PageView" ? { eventId, path }
      : receipt ? { eventId, receipt } : null;
    // Browser occurrence and Pixel delivery are independent: blockers must not silence CAPI.
    if (signal) void fetch("/api/meta/events", {
      method: "POST", headers: { "content-type": "application/json" },
      credentials: "same-origin", keepalive: true, body: JSON.stringify(signal),
    }).catch(() => undefined);
  } catch { /* Measurement never interrupts a shopper. */ }
}

/** The CAPI twin was already scheduled from the committed server mutation. */
export function trackCommittedMetaAddToCart(event: CommittedMetaEvent | undefined): void {
  if (event) trackFacebookPixelEvent("AddToCart", event.parameters, event.eventId);
}
