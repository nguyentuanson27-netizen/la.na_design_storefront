"use server";

import { readStorefrontShippingPromotion } from "./storefront-shipping-promotion.ts";

/** Bounded, public, read-only advertising projection. No caller-supplied shop, query or pricing input. */
export async function getStorefrontShippingPromotion() {
  return readStorefrontShippingPromotion();
}
