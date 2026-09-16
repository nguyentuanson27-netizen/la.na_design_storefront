import type { Metadata } from "next";

import { BRAND } from "@/brand";
import { readSearchExposure } from "@/seo/search-exposure";
import { buildStaticPageMetadata } from "@/seo/static-page-metadata";

/**
 * The home route's metadata, in the one module shape the route contract accepts.
 *
 * Every storefront route's metadata is a direct call to a builder imported from here, so the
 * verifier can answer "does this page's metadata go through the canonical builder?" by inspection
 * rather than by trusting a page that assembled a `Metadata` object of its own.
 *
 * The homepage declares the owner-approved homepage title and meta description, which are their own
 * facts in Brand Config rather than the `headline`/`tagline` every other route inherits. The title
 * is absolute: it already carries the brand name, so the root title template must not append it a
 * second time.
 *
 * Binding approved copy is not an indexing decision. The self-canonical is still the builder's, and
 * still gated on the search exposure contract.
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
    title: { absolute: BRAND.identity.homeTitle },
    description: BRAND.identity.homeMetaDescription,
  });
}
