"use client";

import { holdStorefrontVouchers } from "@/commerce/voucher-hold-actions";

/**
 * The checkout's only door to a voucher hold (Voucher v1, V18). One Server Action: POST-only, origin-checked, driven by
 * the HttpOnly cart cookie. The browser names the quote it was shown (a digest) and whether it accepted an extra cost;
 * the server recomputes everything and answers "held" or why not. Rendering the checkout never calls it.
 */
export function useVoucherHold() {
  return { hold: holdStorefrontVouchers } as const;
}
