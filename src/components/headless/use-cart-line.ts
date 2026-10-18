"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import {
  removeStorefrontCartLine,
  updateStorefrontCartLine,
} from "@/commerce/storefront-cart-actions";
import { buildCommerceItemsEvent, buildVariantItem } from "@/tracking/commerce-events";
import { publishBrowserTrackingEvent } from "@/tracking/data-layer";
import { trackCommittedMetaAddToCart } from "@/components/analytics/meta-browser-client";

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
  // A refusal reads as a warning beside the stepper; a committed change is a quiet confirmation.
  const [messageIsWarning, setMessageIsWarning] = useState(false);
  // The largest quantity a stock refusal named; "+" is pointless at or above it.
  const [stockLimit, setStockLimit] = useState<number | null>(null);
  const [isPending, startTransition] = useTransition();

  // A refresh after a committed change brings the server's quantity; the field follows it.
  const [committedQuantity, setCommittedQuantity] = useState(initialQuantity);
  if (committedQuantity !== initialQuantity) {
    setCommittedQuantity(initialQuantity);
    setQuantityText(String(initialQuantity));
  }

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

  function submitQuantity(value: number) {
    if (!canUpdate || isPending || !resolveCartLineQuantity(String(value)).isValid) return;
    setQuantityText(String(value));
    setMessage("");

    startTransition(async () => {
      try {
        const result = await updateStorefrontCartLine({ variantId, quantity: value });
        setMessageIsWarning(!result.ok);
        if (result.ok) {
          trackCommittedMetaAddToCart(result.metaEvent);
          setStockLimit(null);
        } else {
          // The server answered no, so the line still holds what it held: show that again.
          setQuantityText(String(initialQuantity));
          if (result.maxQuantity) setStockLimit(result.maxQuantity);
        }
        apply(resolveCartLineUpdateOutcome(result));
      } catch {
        setMessageIsWarning(true);
        apply(resolveCartLineThrownOutcome("update"));
      }
    });
  }

  function updateLine() {
    if (!parsed.isValid) return;
    submitQuantity(parsed.value);
  }

  /** Commits a typed quantity (Enter or leaving the field); an unusable one goes back. */
  function commitTypedQuantity() {
    if (!parsed.isValid) {
      setQuantityText(String(initialQuantity));
      return;
    }
    if (parsed.value !== initialQuantity) submitQuantity(parsed.value);
  }

  const current = parsed.isValid ? parsed.value : initialQuantity;

  function removeLine() {
    if (isPending) return;
    setMessage("");

    startTransition(async () => {
      try {
        setMessageIsWarning(true);
        apply(resolveCartLineRemoveOutcome(await removeStorefrontCartLine({ variantId })));
      } catch {
        setMessageIsWarning(true);
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
    messageIsWarning,
    canEditQuantity: canUpdate && !isPending,
    canSubmitUpdate: canUpdate && parsed.isValid && !isPending,
    canDecrement: canUpdate && !isPending && current > 1,
    canIncrement: canUpdate && !isPending && (stockLimit === null || current < stockLimit),
    canRemove: !isPending,
    setQuantity,
    updateLine,
    commitTypedQuantity,
    decrement: () => submitQuantity(current - 1),
    increment: () => submitQuantity(current + 1),
    removeLine,
  };
}
