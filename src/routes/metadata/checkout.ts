import type { Metadata } from "next";

import { BRAND } from "@/brand";

/**
 * Checkout's metadata. Static: the title does not vary with the cart behind it, and a checkout page
 * is not something search engines should be indexing a shopper-specific version of.
 */
export function buildCheckoutMetadata(): Metadata {
  return {
    title: "Thanh toán",
    description: `Thanh toán COD không cần tài khoản tại ${BRAND.identity.name}.`,
  };
}
