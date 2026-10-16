import { createHmac } from "node:crypto";

/** UI-only identity. Not a bearer, proof, acknowledgement, or paid-cart revision. */
export function checkoutAttemptKey(cartId: string, secret: string): string {
  return createHmac("sha256", secret).update("checkout-gift-reminder:v1\0").update(cartId).digest("hex");
}
