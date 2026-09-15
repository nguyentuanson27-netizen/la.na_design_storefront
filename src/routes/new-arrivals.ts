import { sealRoute, type RouteHandle } from "./core.tsx";

/**
 * The new-arrivals page's loader.
 *
 * The page is editorial: it announces the drop and links nowhere else. It carries no product list,
 * so there is nothing to read — and deliberately so, because a listing here would be a second
 * authority over `/shop`'s filtering and ordering. It still goes through the shell, so the drop
 * page is not the one surface missing promotion refresh.
 */

export type NewArrivalsRouteProps = Readonly<Record<string, never>>;

export type NewArrivalsViewModel = Readonly<Record<string, never>>;

export async function loadNewArrivalsRoute(): Promise<RouteHandle<NewArrivalsViewModel>> {
  return sealRoute({
    data: Object.freeze({}),
    // Nothing here is promotion-priced, so it re-reads on the shared default cadence.
    refreshAfterMs: 60_000,
    trackingEvent: null,
    structuredData: [],
    pixelEvents: [],
  });
}
