import type { Metadata } from "next";

import { BRAND } from "@/brand";

/**
 * The search page's metadata. Static, and not a self-canonical evergreen page: `/search` is an entry
 * form rather than content the search exposure contract lists for indexing.
 */
export function buildSearchMetadata(): Metadata {
  return {
    title: "Tìm kiếm",
    description: `Tìm sản phẩm và bộ sưu tập ${BRAND.identity.name}.`,
  };
}
