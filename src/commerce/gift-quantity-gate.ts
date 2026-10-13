/**
 * The single server-side gate for Gift & Quantity Promotions v1 (GQ03, ADR 0016).
 *
 * It is independent of `LA_PROMOTION_ACTIVATION_ENABLED`: turning legacy promotions on must never
 * switch gift or quantity-tier pricing on, and the reverse. Default OFF.
 *
 * Exact-match on the string `"true"`, server environment only. A `NEXT_PUBLIC_` value, a request
 * header, a cookie, or a casual `1` / `TRUE` / `yes` cannot enable it; unset, empty, malformed and
 * `"false"` are all OFF. Every consumer (lifecycle service, candidate lookup, cart quote, Admin)
 * calls this one function rather than reading the variable itself, so there is exactly one place
 * that decides, and one place to harden.
 */

export const GIFT_QUANTITY_PROMOTIONS_ENV = "LA_GIFT_QUANTITY_PROMOTIONS_ENABLED";

type GateEnvironment = Readonly<Record<string, string | undefined>>;

export function isGiftQuantityPromotionsEnabled(env: GateEnvironment = process.env): boolean {
  return env[GIFT_QUANTITY_PROMOTIONS_ENV] === "true";
}
