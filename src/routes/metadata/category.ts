import type { Metadata } from "next";

import { buildCatalogListingMetadata } from "@/seo/catalog-listing-metadata";
import { readSearchExposure } from "@/seo/search-exposure";
import type { CategoryDestination, CategoryRouteProps } from "../category.tsx";

export async function buildCategoryMetadata(
  destination: CategoryDestination,
  { searchParams }: CategoryRouteProps,
): Promise<Metadata> {
  const exposure = readSearchExposure();
  return buildCatalogListingMetadata({
    origin: exposure.origin,
    indexingEnabled: exposure.indexingEnabled,
    pathname: destination.href,
    searchParams: await searchParams,
    title: destination.label,
  });
}
