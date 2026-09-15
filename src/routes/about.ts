import { buildAboutViewModel, type AboutViewModel } from "./evergreen-model.ts";
import { sealRoute, type RouteHandle } from "./core.tsx";

/** The About page's loader. No request-time data: every fact on it is owner-approved and static. */

export type AboutRouteProps = Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>;

export async function loadAboutRoute(): Promise<RouteHandle<AboutViewModel>> {
  return sealRoute({
    data: buildAboutViewModel(),
    // Nothing here is promotion-priced, so it re-reads on the shared default cadence.
    refreshAfterMs: 60_000,
    trackingEvent: null,
    structuredData: [],
    pixelEvents: [],
  });
}
