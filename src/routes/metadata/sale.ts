import type { Metadata } from "next";

export const SALE_TITLE = "Sale";
export const SALE_DESCRIPTION = "Khám phá các sản phẩm đang có ưu đãi và mức giá giảm hiện hành.";

export function buildSaleMetadata(): Metadata {
  return { title: SALE_TITLE, description: SALE_DESCRIPTION };
}
