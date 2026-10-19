import { connection } from "next/server";

import { createCollectionDefinitionRepository } from "@/commerce/collection-definition-repository";
import { parseTrustedProductImageUrl } from "@/commerce/product-media";
import { prisma } from "@/db/prisma";

import { isCollectionRouteReachable } from "./collection-first-page.ts";
import { sealRoute, type RouteHandle } from "./core.tsx";

/** The collection index's loader. */

const MAX_LISTED_COLLECTIONS = 50;

/**
 * Slugs hidden from the public `/collections` index aggregate page.
 * Their products still belong to the collection normally, but the collection card
 * is not rendered in the general collections index.
 */
const HIDDEN_FROM_COLLECTIONS_INDEX_SLUGS = new Set(["special-deals"]);

const repository = createCollectionDefinitionRepository(prisma);

export type CollectionsRouteData = Readonly<{
  collections: readonly Readonly<{
    slug: string;
    title: string;
    description: string | null;
    heroImageUrl: string | null;
  }>[];
}>;

export async function loadCollectionsRoute(): Promise<RouteHandle<CollectionsRouteData>> {
  await connection();
  // A published collection with no story 404s on its own page, so it gets no card here either:
  // the card's only action would be a link to that 404. Both exclusions run in the query, so the
  // cap counts cards rather than rows; the reachability check below is the route's own rule,
  // kept as the last word on what links to `/collections/<slug>`.
  const collections = await repository.listPublished(MAX_LISTED_COLLECTIONS, {
    excludeSlugs: [...HIDDEN_FROM_COLLECTIONS_INDEX_SLUGS],
    withStory: true,
  });
  const visibleCollections = collections.filter(isCollectionRouteReachable);

  return sealRoute({
    data: {
      collections: Object.freeze(
        visibleCollections.map((collection) =>
          Object.freeze({
            slug: collection.slug,
            title: collection.title,
            description: collection.description,
            heroImageUrl: parseTrustedProductImageUrl(collection.heroImageUrl),
          }),
        ),
      ),
    },
    // Nothing on this page is promotion-priced, so it re-reads on the shared default cadence.
    refreshAfterMs: 60_000,
    trackingEvent: null,
    structuredData: [],
    pixelEvents: [],
  });
}
