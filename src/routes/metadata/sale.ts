import type { Metadata } from "next";

import { saleListingByKind, type SaleListingKind } from "@/brand/sale.config";
import type { StorefrontDiscoverySearchParams } from "@/commerce/storefront-discovery";
import { buildCatalogListingMetadata } from "@/seo/catalog-listing-metadata";
import { readSearchExposure } from "@/seo/search-exposure";

export const SALE_TITLE = "Sale";
export const SALE_DESCRIPTION = "Khám phá các sản phẩm đang có ưu đãi và mức giá giảm hiện hành.";

/** Copy for each sale sub-listing, keyed by the campaign kind it lists. */
export const SALE_LISTING_DESCRIPTIONS: Readonly<Record<SaleListingKind, string>> = {
  PROMOTION: "Các sản phẩm đang được giảm giá trong chương trình ưu đãi hiện hành.",
  FLASH_SALE: "Giá tốt nhất trong thời gian giới hạn — nhanh tay trước khi Flash Sale kết thúc.",
  CLEARANCE: "Những thiết kế chỉ còn lẻ size, số lượng có hạn — giá tốt để chọn ngay size vừa với bạn.",
};

export type SaleMetadataProps = Readonly<{
  searchParams: Promise<StorefrontDiscoverySearchParams>;
}>;

export async function buildSaleMetadata(
  { searchParams }: SaleMetadataProps,
  kind?: SaleListingKind,
): Promise<Metadata> {
  const exposure = readSearchExposure();
  const listing = kind ? saleListingByKind(kind) : null;
  return buildCatalogListingMetadata({
    origin: exposure.origin,
    indexingEnabled: exposure.indexingEnabled,
    pathname: listing?.href ?? "/sale",
    searchParams: await searchParams,
    title: listing?.label ?? SALE_TITLE,
    description: kind ? SALE_LISTING_DESCRIPTIONS[kind] : SALE_DESCRIPTION,
  });
}
