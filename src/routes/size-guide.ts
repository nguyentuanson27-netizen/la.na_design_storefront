import { buildSizeGuideViewModel, type SizeGuideViewModel } from "./evergreen-model.ts";
import { sealRoute, type RouteHandle } from "./core.tsx";

/** The Size Guide's loader. Every measurement it shows is an approved table, read from config. */

export type SizeGuideRouteProps = Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>;

export async function loadSizeGuideRoute(): Promise<RouteHandle<SizeGuideViewModel>> {
  return sealRoute({
    data: buildSizeGuideViewModel(),
    // Nothing here is promotion-priced, so it re-reads on the shared default cadence.
    refreshAfterMs: 60_000,
    trackingEvent: null,
    structuredData: [],
    pixelEvents: [],
  });
}
