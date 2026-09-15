"use client";

import { GuestOrderTrackingForm } from "@/components/commerce/guest-order-tracking-form";

/**
 * The brand layer's order-lookup entry point -- an adapter, on the same grounds as checkout's.
 *
 * The form is one workflow over a server action that is the only authority on what a guest may see:
 * it takes an order code and the phone number used to place it, and the action decides whether that
 * pair identifies an order and which fields of it are safe to return. Re-drawing it means
 * re-deriving that, and the failure mode is a lookup that shows one customer another's order.
 *
 * So the shared form stays the single implementation and this file only names it in brand terms. A
 * brand restyling the lookup should change the shared form's markup rather than fork the workflow.
 */

export function BrandGuestOrderTrackingForm() {
  return <GuestOrderTrackingForm />;
}
