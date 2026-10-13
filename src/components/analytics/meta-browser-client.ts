"use client";

import { trackFacebookPixelEvent, type FacebookPixelEventParameters } from "./facebook-pixel-client";
import type { CommittedMetaEvent } from "@/commerce/meta-event-reporting";
import { readMetaPagePath } from "@/integrations/meta/page-source";

import { whenMetaBrowserIdKnown } from "./meta-browser-id-wait";

const CONFIGURED = (process.env.LA_BUILD_FACEBOOK_PIXEL_ID ?? "").length > 0;
let observedUrl: string | null = null;
const observedEvents = new Set<string>();
const reportedReceiptIds = new Set<string>();

export function trackMetaBrowserEvent(name: "PageView" | "ViewContent" | "InitiateCheckout",
  parameters?: FacebookPixelEventParameters, receipt?: string, serverEventId?: string): "refresh" | void {
  if (!CONFIGURED || typeof window === "undefined") return;
  try {
    const url = `${window.location.pathname}${window.location.search}`;
    if (observedUrl !== url) { observedUrl = url; observedEvents.clear(); }
    const path = readMetaPagePath(window.location.pathname);
    if (!path) return;
    // Child effects can run before the layout tracker. Preserve document event order in both twins.
    if (name !== "PageView" && !observedEvents.has("PageView")) trackMetaBrowserEvent("PageView");
    if (observedEvents.has(name)) return;
    // Back navigation can restore an RSC receipt. Refresh server facts before a new occurrence;
    // replaying that old receipt must retain its signed ID rather than inflate Meta conversions.
    if (receipt && serverEventId && reportedReceiptIds.has(serverEventId)) return "refresh";
    observedEvents.add(name);
    const eventId = serverEventId ?? crypto.randomUUID();
    if (receipt && serverEventId) {
      reportedReceiptIds.add(serverEventId);
      if (reportedReceiptIds.size > 200) reportedReceiptIds.delete(reportedReceiptIds.values().next().value!);
    }
    trackFacebookPixelEvent(name, parameters, eventId);
    const signal = name === "PageView" ? { eventId, path }
      : receipt ? { receipt } : null;
    // Browser occurrence and Pixel delivery are independent: blockers must not silence CAPI.
    // The server reads the page (and any fbclid) from the referrer, so pin it to the URL the event
    // happened on: the signal may leave after a client-side navigation to another page.
    const referrer = window.location.href;
    if (signal) whenMetaBrowserIdKnown(() => void fetch("/api/meta/events", {
      method: "POST", headers: { "content-type": "application/json" },
      credentials: "same-origin", keepalive: true, referrer, body: JSON.stringify(signal),
    }).catch(() => undefined));
  } catch { /* Measurement never interrupts a shopper. */ }
}

/** The CAPI twin was already scheduled from the committed server mutation. */
export function trackCommittedMetaAddToCart(event: CommittedMetaEvent | undefined): void {
  if (event) trackFacebookPixelEvent("AddToCart", event.parameters, event.eventId);
}
