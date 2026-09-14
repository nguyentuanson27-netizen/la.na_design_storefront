"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import {
  removeStorefrontCartLine,
  updateStorefrontCartLine,
} from "@/commerce/storefront-cart-actions";
import { buildCommerceItemsEvent, buildVariantItem } from "@/tracking/commerce-events";
import { publishBrowserTrackingEvent } from "@/tracking/data-layer";

import {
  CART_LINE_MAX_QUANTITY,
  resolveCartLineQuantity,
  resolveCartLineRemoveOutcome,
  resolveCartLineThrownOutcome,
  resolveCartLineUpdateOutcome,
  type CartLineOutcome,
} from "./cart-line-model.ts";

/**
 * Cart line behaviour for a redrawn editor: the typed quantity, the two mutations, the route
 * refresh that follows them and the reporting.
 *
 * Every decision about what is *true* -- whether a quantity is worth sending, what the shopper is
 * told, whether the route is re-read -- comes from `cart-line-model.ts`, which is pure and tested.
 * This file is the wiring that cannot be: React state, two server actions, the router, and the
 * dataLayer. A brand consumes the returned surface and decides only how it looks.
 */

export type UseCartLineInput = Readonly<{
  variantId: string;
  initialQuantity: number;
  canUpdate: boolean;
  /** Server-resolved: a deployment that publishes no dataLayer must not have one created here. */
  commerceTrackingEnabled?: boolean;
}>;

export function useCartLine({
  variantId,
  initialQuantity,
  canUpdate,
  commerceTrackingEnabled = false,
}: UseCartLineInput) {
  const inputId = useId();
  const router = useRouter();
  const [quantity, setQuantityText] = useState(String(initialQuantity));
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();

  const parsed = resolveCartLineQuantity(quantity);

  /**
   * Applies one settled mutation.
   *
   * The event published is the one the server said the mutation produced. Direction and size were
   * both decided under the cart lock from the committed transition, and the item facts carry the
   * server's own identity, name and current price. Nothing here reads the input box, the rendered
   * price or the quantity this line started with: those are all pre-mutation values, and an event
   * built from them would describe a cart that no longer exists.
   */
  function apply(outcome: CartLineOutcome) {
    setMessage(outcome.message);

    if (commerceTrackingEnabled && outcome.analytics !== undefined) {
      try {
        publishBrowserTrackingEvent(
          buildCommerceItemsEvent(outcome.analytics.event, {
            items: [buildVariantItem(outcome.analytics.item)],
          }),
        );
      } catch {
        // Tracking never interrupts a shopper.
      }
    }

    if (outcome.refreshes) router.refresh();
  }

  function setQuantity(value: string) {
    setQuantityText(value);
    setMessage("");
  }

  function updateLine() {
    if (!canUpdate || !parsed.isValid || isPending) return;
    setMessage("");

    startTransition(async () => {
      try {
        apply(
          resolveCartLineUpdateOutcome(
            await updateStorefrontCartLine({ variantId, quantity: parsed.value }),
          ),
        );
      } catch {
        apply(resolveCartLineThrownOutcome("update"));
      }
    });
  }

  function removeLine() {
    if (isPending) return;
    setMessage("");

    startTransition(async () => {
      try {
        apply(resolveCartLineRemoveOutcome(await removeStorefrontCartLine({ variantId })));
      } catch {
        apply(resolveCartLineThrownOutcome("remove"));
      }
    });
  }

  return {
    /** Stable id for the quantity field, so a brand can label it without inventing one. */
    inputId,
    quantity,
    maxQuantity: CART_LINE_MAX_QUANTITY,
    isPending,
    message,
    canEditQuantity: canUpdate && !isPending,
    canSubmitUpdate: canUpdate && parsed.isValid && !isPending,
    canRemove: !isPending,
    setQuantity,
    updateLine,
    removeLine,
  };
}
