/**
 * What the English storefront shows instead of dong.
 *
 * Shoppers pay in dong, always: the cart, the order, the bank transfer and every server-side figure
 * stay in VND. The English pages (`/en/...`) only *display* United States dollars, converted at this
 * one fixed rate, as a courtesy to a reader who does not think in dong. It is a display rate, not a
 * market rate: change the number here when it drifts, and nothing else has to move.
 *
 * Converted amounts are then moved to the nearest price ending in one of `priceEndingsInCents`
 * (49 and 99: $24.99, $64.49), the way a dollar storefront prices. An amount below a quarter of a
 * dollar, and zero, are shown as they are, so "free" never becomes "$0.49".
 */
export const ENGLISH_DISPLAY_CURRENCY = {
  code: "USD",
  /** Dong per one dollar. */
  vndPerUsd: 20_000,
  /** Cents a displayed price may end in: $x.49 and $x.99. */
  priceEndingsInCents: [49, 99],
} as const;
