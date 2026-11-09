import { ensureDataLayer } from "../../tracking/data-layer.ts";
import {
  parseTryOnClientEvent,
  type TryOnClientEvent,
} from "../../commerce/try-on-client-events.ts";

/**
 * Reports one step a shopper took in try-on (`try-on-client-events.ts`).
 *
 * Two destinations, both fire-and-forget and neither able to fail the page:
 *
 *   - the page's dataLayer, as `try_on_<step>`, so a tag manager the shop already runs can count the
 *     funnel (opened → photo → generated → result → thumb → size chosen) next to its commerce events.
 *     It is a closed set of flat fields, not an `ecommerce` payload, and never goes through the
 *     commerce publisher, whose boundary exists to keep checkout and customer data out of events;
 *   - `/api/try-on/events`, which writes one non-sensitive line to the server's own signal stream,
 *     so the numbers exist even where no tag manager is configured.
 *
 * Both are rebuilt through `parseTryOnClientEvent` first, so what leaves the browser is exactly the
 * closed vocabulary and nothing a caller attached. No image, file name, free text or identifier of
 * the shopper has a field to travel in.
 */
export function trackTryOn(event: TryOnClientEvent): void {
  try {
    if (typeof window === "undefined") return;
    const clean = parseTryOnClientEvent(event);
    if (clean === null) return;

    const dataLayer = ensureDataLayer(window as unknown as { dataLayer?: unknown });
    dataLayer?.push({
      event: `try_on_${clean.event}`,
      ...(clean.productSlug === undefined ? {} : { try_on_product: clean.productSlug }),
      ...(clean.source === undefined ? {} : { try_on_source: clean.source }),
      ...(clean.rating === undefined ? {} : { try_on_rating: clean.rating }),
      ...(clean.reason === undefined ? {} : { try_on_reason: clean.reason }),
    });

    void fetch("/api/try-on/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(clean),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Measuring must never change what the shopper sees.
  }
}
