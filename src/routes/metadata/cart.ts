import type { Metadata } from "next";

import { BRAND } from "@/brand";

/**
 * The cart's metadata. Static: the title does not vary with the cart's contents, and a cart page is
 * not something search engines should be indexing a shopper-specific version of.
 */
export function buildCartMetadata(): Metadata {
  return {
    title: "Giỏ hàng",
    description: `Giỏ hàng mua sắm tại ${BRAND.identity.name}.`,
  };
}
