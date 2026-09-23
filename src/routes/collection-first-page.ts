import { parseCollectionDiscoverySearchParams } from "../commerce/collection-discovery-url.ts";
import type { StorefrontDiscoveryQuery } from "../commerce/storefront-discovery.ts";

/**
 * What `/collections/<slug>` publishes, stated once so a second surface can reproduce it.
 *
 * The collection route owns these rules. They live here rather than in `collection.ts` only because
 * that module reaches `next/navigation` and the catalog runtime, which the domain test runner cannot
 * load -- and the homepage's SPECIAL DEALS fallback and collection CTAs must agree with the route
 * exactly, not with a copy of it. A homepage that re-typed the literal `24` or its own "is this
 * collection a page?" test would drift the first time either rule changed here.
 */

/** One page of a collection listing. The route and every surface that mirrors its first page. */
export const COLLECTION_PAGE_SIZE = 24;

type PublishedCollectionFacts = Readonly<{ description: string | null }>;

/**
 * Whether the public collection route would render this collection rather than 404.
 *
 * `readPublishedCollection()` has already enforced `isPublished`; a published collection with no
 * story is still not a page (it would render a heading over nothing), so the route 404s it. Any
 * link to `/collections/<slug>` must pass this same gate, or it publishes a CTA that lands on a 404.
 */
export function isCollectionRouteReachable<T extends PublishedCollectionFacts>(
  collection: T | null | undefined,
): collection is T & Readonly<{ description: string }> {
  return Boolean(collection && collection.description?.trim());
}

/** The unfiltered first page a shopper lands on at `/collections/<slug>` with no query string. */
export function buildCollectionFirstPageDiscovery(slug: string): StorefrontDiscoveryQuery {
  return parseCollectionDiscoverySearchParams(slug, {});
}
