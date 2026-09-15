import { sealRoute, type RouteHandle } from "./core.tsx";

/**
 * The account page's loader.
 *
 * Session state belongs to the auth panel, which reads it on the client: resolving it here would
 * make the page's cached HTML depend on who requested it.
 */

export type AccountRouteProps = Readonly<Record<string, never>>;

export type AccountViewModel = Readonly<Record<string, never>>;

export async function loadAccountRoute(): Promise<RouteHandle<AccountViewModel>> {
  return sealRoute({
    data: Object.freeze({}),
    // Nothing here is promotion-priced, so it re-reads on the shared default cadence.
    refreshAfterMs: 60_000,
    trackingEvent: null,
    structuredData: [],
    pixelEvents: [],
  });
}
