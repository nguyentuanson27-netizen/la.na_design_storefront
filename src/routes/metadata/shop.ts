import type { Metadata } from "next";

import { BRAND } from "@/brand";
import type { StorefrontDiscoverySearchParams } from "@/commerce/storefront-discovery";
import { buildCatalogListingMetadata } from "@/seo/catalog-listing-metadata";
import { readSearchExposure } from "@/seo/search-exposure";

/** The shop listing's metadata. Title and description are the route's, not the catalog's. */

export const SHOP_TITLE = "Cửa hàng";
export const SHOP_DESCRIPTION = `Khám phá thời trang nam ${BRAND.identity.name} đang có sẵn tại cửa hàng.`;

export type ShopMetadataProps = Readonly<{
  searchParams: Promise<StorefrontDiscoverySearchParams>;
}>;

export async function buildShopMetadata({ searchParams }: ShopMetadataProps): Promise<Metadata> {
  const exposure = readSearchExposure();
  return buildCatalogListingMetadata({
    origin: exposure.origin,
    indexingEnabled: exposure.indexingEnabled,
    pathname: "/shop",
    searchParams: await searchParams,
    title: SHOP_TITLE,
    description: SHOP_DESCRIPTION,
  });
}
