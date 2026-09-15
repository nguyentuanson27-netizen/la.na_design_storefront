import type { Metadata } from "next";

import { buildStaticPageMetadata } from "@/seo/static-page-metadata";
import { readSearchExposure } from "@/seo/search-exposure";

/**
 * The shared half of every evergreen page's metadata.
 *
 * Not a route's builder and never imported by a page: the metadata contract requires a page to call
 * a builder named for its own route, and this is what those builders have in common. It exists
 * because reading the search exposure and passing `indexingEnabled` through is the step a new page
 * forgets, and forgetting it publishes a canonical for a URL the same response says not to index.
 */

export type StaticPageMetadataProps = Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>;

export async function buildEvergreenPageMetadata(
  input: Readonly<{
    props: StaticPageMetadataProps;
    pathname: string;
    title: string;
    description: string;
  }>,
): Promise<Metadata> {
  const exposure = readSearchExposure();
  return buildStaticPageMetadata({
    origin: exposure.origin,
    indexingEnabled: exposure.indexingEnabled,
    pathname: input.pathname,
    searchParams: await input.props.searchParams,
    title: input.title,
    description: input.description,
  });
}
