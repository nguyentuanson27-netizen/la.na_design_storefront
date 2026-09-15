import type { Metadata } from "next";

import { BRAND } from "@/brand";

/** The new-arrivals page's metadata. */
export function buildNewArrivalsMetadata(): Metadata {
  return {
    title: "Hàng mới",
    description: `Những sản phẩm mới nhất từ ${BRAND.identity.name}.`,
  };
}
