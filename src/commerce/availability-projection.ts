/**
 * I9 — the single external availability decision (ADR 0011 § Structured-data parity).
 *
 * ADR 0011 is explicit that Merchant output and product JSON-LD must consume **one** projection:
 * "a consumer must not independently translate internal selling-mode names." Before I9 they did
 * exactly that — the feed classified raw mirrored stock while JSON-LD read the page projection — so
 * the two could disagree about the same variant, which is the parity failure Google penalises.
 *
 * This module is that one decision. It is pure, it takes the already-resolved shopper state rather
 * than selling-mode names, and it returns a **paired** Merchant/schema.org answer so the two
 * vocabularies cannot drift apart by construction.
 *
 * The other half of ADR 0011 is what it refuses to do. `backorder` is the one Google value that
 * requires `availability_date`, so an unusable date is never smoothed over: the offer is withheld.
 * Relabelling it `out_of_stock` instead would contradict a checkout that is still accepting the
 * order, which ADR 0011 rejected by name.
 */

import { isAvailabilityDateExpired, type VietnamCalendarDate } from "./availability-cycle.ts";
import type { CapacityDecisionReason } from "./capacity-policy.ts";
import type { StorefrontVariantUnavailableReason } from "./storefront-product.ts";

/** Google Merchant `availability`. ADR 0011 adds `backorder`; `preorder` is deliberately absent. */
export type MerchantAvailability = "in_stock" | "out_of_stock" | "backorder";

/** schema.org `ItemAvailability`, paired one-to-one with the Merchant value above. */
export type StructuredDataAvailability = "InStock" | "OutOfStock" | "BackOrder";

export type ExternalAvailabilityBlockedReason =
  /** The catalog cannot state an availability for this variant at all. */
  | "AVAILABILITY_UNRESOLVED"
  /** Purchasable on preorder, but with no valid, current date to publish beside `backorder`. */
  | "BACKORDER_DATE_UNAVAILABLE";

export type ExternalAvailability =
  | Readonly<{
      published: true;
      merchant: MerchantAvailability;
      schema: StructuredDataAvailability;
      /** Set only for `backorder`, which is the only published state Google allows a date on. */
      availabilityDate: VietnamCalendarDate | null;
    }>
  | Readonly<{ published: false; reason: ExternalAvailabilityBlockedReason }>;

export type ExternalAvailabilityInput = Readonly<{
  /** The shared I4 answer to "may one more unit be sold". */
  purchasable: boolean;
  /** Master spec §30 `Đặt trước`: purchasable on `PREORDER` with no ready stock. */
  isPreorderSale: boolean;
  unavailableReason: StorefrontVariantUnavailableReason | null;
  /**
   * Why capacity refused, when it did. Needed because the storefront collapses every refusal into
   * `OUT_OF_STOCK` for the shopper — a distinction a page can ignore and a feed cannot.
   */
  capacityReason: CapacityDecisionReason;
  /** The persisted cycle date for this variant, or null when no cycle is open. */
  availabilityDate: VietnamCalendarDate | null;
  /** Today in Vietnam. `null` when it could not be determined, which fails closed. */
  today: VietnamCalendarDate | null;
}>;

/**
 * Refusals that are evidence of being sold out, rather than evidence the catalog is unreadable.
 *
 * The distinction is the fail-closed line. "Selling one more would go negative" and "the owner's
 * negative limit is reached" are real, publishable out-of-stock facts. An unreadable stock number,
 * a malformed stored limit, or an unproven composite is **not**: the catalog does not know, and
 * publishing `out_of_stock` on that basis would state a fact it cannot support.
 */
const SOLD_OUT_CAPACITY_REASONS: readonly CapacityDecisionReason[] = [
  "standard-would-go-negative",
  "negative-limit-reached",
];

const blocked = (reason: ExternalAvailabilityBlockedReason): ExternalAvailability =>
  Object.freeze({ published: false, reason });

export function projectExternalAvailability(
  input: ExternalAvailabilityInput,
): ExternalAvailability {
  if (!input.purchasable) {
    // Only a genuine sold-out state is publishable. Mapping, ambiguity and pricing failures were
    // already withheld before I9; the capacity reasons join them on the same principle.
    if (
      input.unavailableReason !== "OUT_OF_STOCK" ||
      !SOLD_OUT_CAPACITY_REASONS.includes(input.capacityReason)
    ) {
      return blocked("AVAILABILITY_UNRESOLVED");
    }
    return Object.freeze({
      published: true,
      merchant: "out_of_stock",
      schema: "OutOfStock",
      availabilityDate: null,
    });
  }

  if (!input.isPreorderSale) {
    // Ready and purchasable. Google's `in_stock` is a statement that orders are accepted and can be
    // fulfilled in a timely manner, not that an internal warehouse integer is positive — which is
    // why oversell within its approved limit belongs here too (ADR 0011 § Oversell rationale).
    return Object.freeze({
      published: true,
      merchant: "in_stock",
      schema: "InStock",
      availabilityDate: null,
    });
  }

  const { availabilityDate, today } = input;
  if (availabilityDate === null || today === null) return blocked("BACKORDER_DATE_UNAVAILABLE");
  if (isAvailabilityDateExpired(availabilityDate, today)) {
    // Owner rule 8: the cycle is not extended and the listing stops. The shopper may still be
    // offered `Đặt trước` under the capacity policy — the storefront and the feed are allowed to
    // differ here, because only one of them is making a dated public promise.
    return blocked("BACKORDER_DATE_UNAVAILABLE");
  }

  return Object.freeze({
    published: true,
    merchant: "backorder",
    schema: "BackOrder",
    availabilityDate,
  });
}
