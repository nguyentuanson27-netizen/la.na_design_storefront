/**
 * What the English storefront shows instead of dong.
 *
 * Shoppers pay in dong, always: the cart, the order, the bank transfer and every server-side figure
 * stay in VND. The English pages (`/en/...`) only *display* United States dollars, converted at this
 * one fixed rate, as a courtesy to a reader who does not think in dong. It is a display rate, not a
 * market rate: change the number here when it drifts, and nothing else has to move.
 */
export const ENGLISH_DISPLAY_CURRENCY = {
  code: "USD",
  /** Dong per one dollar. */
  vndPerUsd: 26_000,
} as const;
