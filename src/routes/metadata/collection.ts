import type { Metadata } from "next";
import { connection } from "next/server";

import { CollectionDefinitionError } from "@/commerce/collection-definition";
import { createCollectionDefinitionRepository } from "@/commerce/collection-definition-repository";
import { prisma } from "@/db/prisma";
import { buildCatalogListingMetadata } from "@/seo/catalog-listing-metadata";
import { readSearchExposure } from "@/seo/search-exposure";

/**
 * The collection detail's metadata.
 *
 * A collection with no story yields empty metadata, matching the page's own `notFound()`: a
 * published collection that has not been written up is not a page worth indexing.
 */

const repository = createCollectionDefinitionRepository(prisma);

export type CollectionMetadataProps = Readonly<{
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>;

export async function readPublishedCollection(slug: string) {
  try {
    return await repository.findPublishedBySlug(slug);
  } catch (error) {
    // A malformed slug is a bad URL, not a server fault.
    if (error instanceof CollectionDefinitionError) return null;
    throw error;
  }
}

export async function buildCollectionMetadata({
  params,
  searchParams,
}: CollectionMetadataProps): Promise<Metadata> {
  await connection();
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const collection = await readPublishedCollection(slug);
  const description = collection?.description?.trim();
  if (!collection || !description) return {};

  const exposure = readSearchExposure();
  return buildCatalogListingMetadata({
    origin: exposure.origin,
    indexingEnabled: exposure.indexingEnabled,
    pathname: `/collections/${collection.slug}`,
    searchParams: query,
    title: collection.seoTitle?.trim() || collection.title,
    description: collection.seoDescription?.trim() || description,
  });
}
