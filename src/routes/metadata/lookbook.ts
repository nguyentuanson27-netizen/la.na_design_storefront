import type { Metadata } from "next";

import { BRAND } from "@/brand";
import { readSearchExposure } from "@/seo/search-exposure";
import { buildStaticPageMetadata } from "@/seo/static-page-metadata";

/** The lookbook's metadata. */

export type LookbookMetadataProps = Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>;

export async function buildLookbookMetadata({
  searchParams,
}: LookbookMetadataProps): Promise<Metadata> {
  const exposure = readSearchExposure();
  return buildStaticPageMetadata({
    origin: exposure.origin,
    indexingEnabled: exposure.indexingEnabled,
    pathname: "/lookbook",
    searchParams: await searchParams,
    title: "Lookbook",
    description: `${BRAND.identity.name} editorial and styling stories for the city uniform.`,
  });
}
