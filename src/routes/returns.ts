import { buildReturnsViewModel, type ReturnsViewModel } from "./evergreen-model.ts";
import { sealRoute, type RouteHandle } from "./core.tsx";

/** The Returns page's loader. Every clause it shows is a reviewed fact, so nothing is read here. */

export type ReturnsRouteProps = Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>;

export async function loadReturnsRoute(): Promise<RouteHandle<ReturnsViewModel>> {
  return sealRoute({
    data: buildReturnsViewModel(),
    // Nothing here is promotion-priced, so it re-reads on the shared default cadence.
    refreshAfterMs: 60_000,
    trackingEvent: null,
    structuredData: [],
    pixelEvents: [],
  });
}
