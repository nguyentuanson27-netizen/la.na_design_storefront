import type { Metadata } from "next";

import { BRAND } from "@/brand";
import { readSearchExposure } from "@/seo/search-exposure";
import { buildStaticPageMetadata } from "@/seo/static-page-metadata";
import type { NewArrivalsRouteProps } from "../new-arrivals.ts";

/** The new-arrivals page's metadata. */
export async function buildNewArrivalsMetadata({
  searchParams,
}: NewArrivalsRouteProps): Promise<Metadata> {
  const exposure = readSearchExposure();
  return buildStaticPageMetadata({
    origin: exposure.origin,
    indexingEnabled: exposure.indexingEnabled,
    pathname: "/new-arrivals",
    searchParams: await searchParams,
    title: "Hàng mới",
    description: `Những sản phẩm mới nhất từ ${BRAND.identity.name}.`,
  });
}
