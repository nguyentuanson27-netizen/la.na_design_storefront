import type { Metadata } from "next";

import { BRAND } from "@/brand";
import type { StorefrontDiscoverySearchParams } from "@/commerce/storefront-discovery";
import { buildCatalogListingMetadata } from "@/seo/catalog-listing-metadata";
import { readSearchExposure } from "@/seo/search-exposure";

/** The Flash Sale listing's metadata. */

export const FLASH_TITLE = "Flash Sale";
export const FLASH_DESCRIPTION = `Các sản phẩm đang giảm giá trong khung giờ Flash Sale của ${BRAND.identity.name}.`;

export type FlashSaleMetadataProps = Readonly<{
  searchParams: Promise<StorefrontDiscoverySearchParams>;
}>;

export async function buildFlashSaleMetadata({
  searchParams,
}: FlashSaleMetadataProps): Promise<Metadata> {
  const exposure = readSearchExposure();
  return buildCatalogListingMetadata({
    origin: exposure.origin,
    indexingEnabled: exposure.indexingEnabled,
    pathname: "/flash-sale",
    searchParams: await searchParams,
    title: FLASH_TITLE,
    description: FLASH_DESCRIPTION,
  });
}
