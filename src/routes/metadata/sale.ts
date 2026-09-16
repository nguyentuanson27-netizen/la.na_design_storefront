import type { Metadata } from "next";

import type { StorefrontDiscoverySearchParams } from "@/commerce/storefront-discovery";
import { buildCatalogListingMetadata } from "@/seo/catalog-listing-metadata";
import { readSearchExposure } from "@/seo/search-exposure";

export const SALE_TITLE = "Sale";
export const SALE_DESCRIPTION = "Khám phá các sản phẩm đang có ưu đãi và mức giá giảm hiện hành.";

export type SaleMetadataProps = Readonly<{
  searchParams: Promise<StorefrontDiscoverySearchParams>;
}>;

export async function buildSaleMetadata({
  searchParams,
}: SaleMetadataProps): Promise<Metadata> {
  const exposure = readSearchExposure();
  return buildCatalogListingMetadata({
    origin: exposure.origin,
    indexingEnabled: exposure.indexingEnabled,
    pathname: "/sale",
    searchParams: await searchParams,
    title: SALE_TITLE,
    description: SALE_DESCRIPTION,
  });
}
