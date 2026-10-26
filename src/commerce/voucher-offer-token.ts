import { createHmac } from "node:crypto";

import { readAuthServerConfig } from "../auth/config.ts";

/**
 * An opaque handle on one marketing-link offer: an HMAC of the code under the server's secret, truncated to 32 hex. The code stays in the
 * HttpOnly cookie on the server; the page and the browser only ever hold this handle. The handle is bound to the offer the shopper was
 * SHOWN when the cart rendered, and it is sent back to apply (so another tab's newer link can never be applied by this tab's click) and to
 * dismiss (so a tab never clears an offer it did not use).
 */
export function voucherOfferToken(code: string): string {
  return createHmac("sha256", readAuthServerConfig().secret).update(`voucher-offer:${code}`).digest("hex").slice(0, 32);
}
