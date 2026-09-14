import type { Metadata } from "next";

import { BRAND } from "@/brand";
import { readSearchExposure } from "@/seo/search-exposure";
import { buildStaticPageMetadata } from "@/seo/static-page-metadata";

/** The collection index's metadata. */

export type CollectionsMetadataProps = Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>;

export async function buildCollectionsMetadata({
  searchParams,
}: CollectionsMetadataProps): Promise<Metadata> {
  const exposure = readSearchExposure();
  return buildStaticPageMetadata({
    origin: exposure.origin,
    indexingEnabled: exposure.indexingEnabled,
    pathname: "/collections",
    searchParams: await searchParams,
    title: "Bộ sưu tập",
    description: `Khám phá các bộ sưu tập từ ${BRAND.identity.name}.`,
  });
}
