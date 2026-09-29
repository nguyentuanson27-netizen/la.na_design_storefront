import { sealRoute, type RouteHandle } from "./core.tsx";
import { parsePrefilledOrderCode, type TrackOrderViewModel } from "./track-order-model.ts";

export type { TrackOrderViewModel } from "./track-order-model.ts";

/**
 * The order-tracking page's loader.
 *
 * The lookup itself is a server action the form owns, so the page loads nothing from the database:
 * it renders a form and the copy explaining what the result will and will not show. The only input
 * is an optional `?order=` code — the confirmation page links here with it so the buyer only has to
 * type their phone number.
 */

export type TrackOrderRouteProps = Readonly<{
  searchParams: Promise<{ order?: string | string[] }>;
}>;

export async function loadTrackOrderRoute({
  searchParams,
}: TrackOrderRouteProps): Promise<RouteHandle<TrackOrderViewModel>> {
  const prefilledOrderCode = parsePrefilledOrderCode((await searchParams).order);
  return sealRoute({
    data: Object.freeze({ prefilledOrderCode }),
    // Nothing here is promotion-priced, so it re-reads on the shared default cadence.
    refreshAfterMs: 60_000,
    trackingEvent: null,
    structuredData: [],
    pixelEvents: [],
  });
}
