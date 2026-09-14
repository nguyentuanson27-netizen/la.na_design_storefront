import type { Metadata } from "next";

import { readSearchExposure } from "@/seo/search-exposure";
import { buildStaticPageMetadata } from "@/seo/static-page-metadata";

/**
 * The home route's metadata, in the one module shape the route contract accepts.
 *
 * Every storefront route's metadata is a direct call to a builder imported from here, so the
 * verifier can answer "does this page's metadata go through the canonical builder?" by inspection
 * rather than by trusting a page that assembled a `Metadata` object of its own.
 *
 * The homepage declares no title or description: both stay inherited from the root metadata. This
 * adds the self-canonical and nothing else.
 */

export type HomeMetadataProps = Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>;

export async function buildHomeMetadata({ searchParams }: HomeMetadataProps): Promise<Metadata> {
  const exposure = readSearchExposure();
  return buildStaticPageMetadata({
    origin: exposure.origin,
    indexingEnabled: exposure.indexingEnabled,
    pathname: "/",
    searchParams: await searchParams,
  });
}
