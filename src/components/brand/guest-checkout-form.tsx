"use client";

import { GuestCheckoutForm } from "@/components/commerce/guest-checkout-form";

/**
 * The brand layer's checkout entry point -- deliberately an adapter, not a split.
 *
 * Every other component in this folder owns its markup while a headless module owns the decisions.
 * Checkout is the one place that split would be wrong. Its form is not presentation over a few
 * rules: it is one workflow -- a quote proof that must still be valid at submit, an address
 * narrowed province to district to commune with each level invalidating the ones under it, and a
 * server action that is the only authority on acceptance. Re-drawing it means re-deriving that
 * order, and the failure mode is an order placed against a stale quote or an address that does not
 * resolve. A second implementation of it is a second set of those bugs.
 *
 * So the shared form stays the single implementation and this file only names it in brand terms.
 * A brand that must restyle checkout should change the shared form's markup rather than fork the
 * workflow behind it; if checkout ever does need a real seam, it wants its own phase and its own
 * characterization tests, not a copy made here.
 */

export function BrandGuestCheckoutForm(
  props: Readonly<{
    quoteProof: string;
    summarySlot?: React.ReactNode;
    totalsSlot?: React.ReactNode;
    preorderSlot?: React.ReactNode;
  }>,
) {
  return <GuestCheckoutForm {...props} />;
}
