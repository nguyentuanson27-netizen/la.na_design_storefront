import { getLocale } from "@/i18n/server";
import { localizeHref } from "@/i18n/locale";
import { redirect } from "next/navigation";

import { sealRoute, type RouteHandle } from "./core.tsx";
import { searchRedirectTarget } from "./search-model.ts";

/**
 * The search page's loader.
 *
 * The form submits to `/shop`, which owns the query and the results, so there is nothing to load
 * here. The route still goes through the shell: a page that skips it is a page missing the
 * promotion refresh and the event reporter, and "this one has no data" is how that starts.
 *
 * A visit that already carries a query (`/search?q=ao+dai`, from a link, a bookmark or the
 * search overlay's older callers) goes straight to the results instead of showing an empty form
 * the shopper has to fill in again.
 */

export type SearchRouteProps = Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>;

export type SearchViewModel = Readonly<Record<string, never>>;

export async function loadSearchRoute({ searchParams }: SearchRouteProps): Promise<RouteHandle<SearchViewModel>> {
  const target = searchRedirectTarget(await searchParams);
  if (target !== null) redirect(localizeHref(target, await getLocale()));
  return sealRoute({
    data: Object.freeze({}),
    // Nothing here is promotion-priced, so it re-reads on the shared default cadence.
    refreshAfterMs: 60_000,
    trackingEvent: null,
    structuredData: [],
    pixelEvents: [],
  });
}
