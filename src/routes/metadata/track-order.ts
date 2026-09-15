import type { Metadata } from "next";

import { BRAND } from "@/brand";

/**
 * The order-tracking page's metadata. Static, and not a self-canonical evergreen page: `/track-order`
 * is a lookup surface rather than content the search exposure contract lists for indexing.
 */
export function buildTrackOrderMetadata(): Metadata {
  return {
    title: "Tra cứu đơn hàng",
    description: `Tra cứu trạng thái đơn hàng COD của ${BRAND.identity.name} bằng mã đơn và số điện thoại.`,
  };
}
