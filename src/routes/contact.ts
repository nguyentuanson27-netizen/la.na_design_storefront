import { buildContactViewModel, type ContactViewModel } from "./evergreen-model.ts";
import { sealRoute, type RouteHandle } from "./core.tsx";

/** The Contact page's loader. Every channel it shows is a fact, so nothing is read per request. */

export type ContactRouteProps = Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>;

export async function loadContactRoute(): Promise<RouteHandle<ContactViewModel>> {
  return sealRoute({
    data: buildContactViewModel(),
    // Nothing here is promotion-priced, so it re-reads on the shared default cadence.
    refreshAfterMs: 60_000,
    trackingEvent: null,
    structuredData: [],
    pixelEvents: [],
  });
}
