import { sealRoute, type RouteHandle } from "./core.tsx";

/**
 * The search page's loader.
 *
 * The form submits to `/shop`, which owns the query and the results, so there is nothing to load
 * here. The route still goes through the shell: a page that skips it is a page missing the
 * promotion refresh and the event reporter, and "this one has no data" is how that starts.
 */

export type SearchRouteProps = Readonly<Record<string, never>>;

export type SearchViewModel = Readonly<Record<string, never>>;

export async function loadSearchRoute(): Promise<RouteHandle<SearchViewModel>> {
  return sealRoute({
    data: Object.freeze({}),
    // Nothing here is promotion-priced, so it re-reads on the shared default cadence.
    refreshAfterMs: 60_000,
    trackingEvent: null,
    structuredData: [],
    pixelEvents: [],
  });
}
