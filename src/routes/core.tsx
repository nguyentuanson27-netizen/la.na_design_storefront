import type { ReactNode } from "react";

import { CommerceEventReporter } from "@/components/analytics/commerce-event-reporter";
import { FacebookPixelEvent } from "@/components/analytics/facebook-pixel-event";
import type { FacebookPixelEventParameters } from "@/components/analytics/facebook-pixel-client";
import { StorefrontPromotionRefresher } from "@/components/commerce/storefront-promotion-refresher";
import { serializeJsonLd } from "@/seo/structured-data";
import type { TrackingEvent } from "@/tracking/commerce-events";

/**
 * A JSON-LD document as the shell carries it. The two builders in `@/seo/structured-data` produce
 * exact document types; this is the widest shape the shell needs to know about, because the shell's
 * only job is to hand the value to the canonical serializer without inspecting it.
 */
export type JsonLdEntity = Readonly<Record<string, unknown>>;

/**
 * A page-level Meta pixel event, as the shell carries it.
 *
 * Mirrors `FacebookPixelEvent`'s props because the shell's job is to mount them, not to interpret
 * them. It exists so a loader can declare a pixel event at all: `src/app` may not import
 * `@/components/analytics/*`, so without a slot on the payload the only way to report one would be
 * for a page to breach the boundary -- or for a brand component to remember to mount it, which is
 * the forgetting this shell exists to prevent.
 */
export type RoutePixelEvent = Readonly<{
  name: string;
  parameters?: FacebookPixelEventParameters;
  /** Set where a Conversions API twin exists, so Meta counts the pair as one conversion. */
  eventId?: string;
  /** Report at most once per browser, keyed by `eventId`. */
  once?: boolean;
}>;

/**
 * Module-private. The payload hangs off a symbol nobody outside this file has a name for, which is
 * what stops a page reading route data straight from the handle and skipping the shell.
 */
const PAYLOAD = Symbol("route-payload");

export type RoutePayload<D> = {
  /** The view model the page renders. Reaches the page only through the shell's render prop. */
  data: D;
  /** Relative duration after which the promotion-priced surface must revalidate. */
  refreshAfterMs: number;
  /**
   * `null` is the deliberate fail-closed path: a route that could not build a canonical event says
   * so, rather than emitting a half-built one. The shell still mounts the reporter.
   */
  trackingEvent: TrackingEvent | null;
  structuredData: readonly JsonLdEntity[];
  /**
   * Page-level Meta pixel events. Empty on every route that reports none, spelled out rather than
   * optional so a new loader states its answer instead of inheriting silence.
   */
  pixelEvents: readonly RoutePixelEvent[];
};

/**
 * An opaque handle to a loaded route.
 *
 * The type carries `D` so the shell stays generic, but exposes no member a page can read: `PAYLOAD`
 * is not exported, so there is no name a page can write down. This stops the accident of a page
 * pulling `handle.data` and rendering without the shell -- it does not claim to stop someone
 * determined, who can still reach the symbol at runtime. See `tests/domain/route-handle-contract`.
 */
export type RouteHandle<D> = { readonly [PAYLOAD]: RoutePayload<D> };

/** Called by route loaders to hand a loaded route to the shell. */
export function sealRoute<D>(payload: RoutePayload<D>): RouteHandle<D> {
  return { [PAYLOAD]: payload };
}

/**
 * Module-private on purpose, and the reason seal, unseal and the shell share one file: exporting
 * this would hand every page the key and make the handle opaque in name only.
 */
function unsealRoute<D>(handle: RouteHandle<D>): RoutePayload<D> {
  return handle[PAYLOAD];
}

/**
 * The one place a storefront route is rendered.
 *
 * Every concern here is unconditional. Promotion refresh, the commerce event and JSON-LD are exactly
 * the things a page author forgets, so the shell owns them rather than reminding anyone: a route
 * cannot render through this component and be missing one of them. `CommerceEventReporter` decides
 * for itself what a `null` event means, which is why the shell mounts it either way instead of
 * branching -- a branch here would make "no event" and "no reporter" the same thing, and the second
 * one is a silent hole.
 */
export function StorefrontRoute<D>({
  handle,
  children,
}: {
  handle: RouteHandle<D>;
  children: (data: D) => ReactNode;
}) {
  const payload = unsealRoute(handle);

  return (
    <>
      <StorefrontPromotionRefresher refreshAfterMs={payload.refreshAfterMs} />
      <CommerceEventReporter event={payload.trackingEvent} />
      {/*
        One script per document, not one script holding an array. A route that publishes a single
        graph must emit exactly the document search engines already read there; wrapping it in an
        array would change every migrated page's JSON-LD into `[{…}]` for no gain.
      */}
      {payload.structuredData.map((document, index) => (
        <script
          key={index}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(document) }}
        />
      ))}
      {payload.pixelEvents.map((event, index) => (
        <FacebookPixelEvent
          key={event.eventId ?? `${event.name}:${index}`}
          name={event.name}
          parameters={event.parameters}
          eventId={event.eventId}
          once={event.once}
        />
      ))}
      {children(payload.data)}
    </>
  );
}
