import { sealRoute, type RouteHandle } from "./core.tsx";

/**
 * The order-tracking page's loader.
 *
 * The lookup itself is a server action the form owns, so the page has nothing to load: it renders a
 * form and the copy explaining what the result will and will not show.
 */

export type TrackOrderRouteProps = Readonly<Record<string, never>>;

export type TrackOrderViewModel = Readonly<Record<string, never>>;

export async function loadTrackOrderRoute(): Promise<RouteHandle<TrackOrderViewModel>> {
  return sealRoute({
    data: Object.freeze({}),
    // Nothing here is promotion-priced, so it re-reads on the shared default cadence.
    refreshAfterMs: 60_000,
    trackingEvent: null,
    structuredData: [],
    pixelEvents: [],
  });
}
