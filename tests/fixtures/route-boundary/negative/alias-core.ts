// Real module, deliberately outside the allowed roots: the rejection must be about the boundary,
// not about the path being a typo.
import { readGuestShippingPolicy } from "@/commerce/guest-shipping-policy";
export const a = readGuestShippingPolicy;
