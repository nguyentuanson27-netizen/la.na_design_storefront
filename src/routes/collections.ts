import { connection } from "next/server";

import { createCollectionDefinitionRepository } from "@/commerce/collection-definition-repository";
import { prisma } from "@/db/prisma";

import { sealRoute, type RouteHandle } from "./core.tsx";

/** The collection index's loader. */

const MAX_LISTED_COLLECTIONS = 50;

const repository = createCollectionDefinitionRepository(prisma);

export type CollectionsRouteData = Readonly<{
  collections: readonly Readonly<{
    slug: string;
    title: string;
    description: string | null;
  }>[];
}>;

export async function loadCollectionsRoute(): Promise<RouteHandle<CollectionsRouteData>> {
  await connection();
  const collections = await repository.listPublished(MAX_LISTED_COLLECTIONS);

  return sealRoute({
    data: {
      collections: Object.freeze(
        collections.map((collection) =>
          Object.freeze({
            slug: collection.slug,
            title: collection.title,
            description: collection.description,
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
