import type { Metadata } from "next";

import { BRAND } from "@/brand";

/**
 * The order confirmation's metadata. Static, and deliberately says nothing about the order: the
 * page is reached with an order code in the query string, and a title carrying it would put a
 * customer's order number into browser history and any referrer that follows.
 */
export function buildCheckoutSuccessMetadata(): Metadata {
  return {
    title: "Đặt hàng thành công",
    description: `Xác nhận đơn hàng COD của ${BRAND.identity.name}.`,
  };
}
