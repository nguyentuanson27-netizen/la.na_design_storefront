import type { Metadata } from "next";

import { BRAND } from "@/brand";
import { buildCatalogListingMetadata } from "@/seo/catalog-listing-metadata";
import { readSearchExposure } from "@/seo/search-exposure";
import type { NewArrivalsRouteProps } from "../new-arrivals.ts";

/**
 * The route's public name, used by its metadata and by the tracking list the loader seals. One
 * constant so the analytics list name and the page title cannot drift apart.
 */
export const NEW_ARRIVALS_TITLE = "Hàng mới";

/**
 * The new-arrivals page's metadata.
 *
 * Built by the catalog listing builder rather than the static one: this route pages now, and the
 * static builder withholds a canonical the moment any query appears -- correct for a page with no
 * paginated form, and wrong for one whose page 2 is a real URL a crawler should reach.
 */
export async function buildNewArrivalsMetadata({
  searchParams,
}: NewArrivalsRouteProps): Promise<Metadata> {
  const exposure = readSearchExposure();
  return buildCatalogListingMetadata({
    origin: exposure.origin,
    indexingEnabled: exposure.indexingEnabled,
    pathname: "/new-arrivals",
    searchParams: await searchParams,
    title: NEW_ARRIVALS_TITLE,
    description: `Những sản phẩm mới nhất từ ${BRAND.identity.name}.`,
  });
}
