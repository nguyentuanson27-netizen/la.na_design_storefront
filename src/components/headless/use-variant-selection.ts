"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { addStorefrontItemToBag } from "@/commerce/storefront-actions";
import type { StorefrontProjectionOption } from "@/commerce/storefront-projection";
import type { DeepLinkedVariantSelection } from "@/commerce/storefront-variant-deep-link";
import { trackCommittedMetaAddToCart } from "@/components/analytics/meta-browser-client";
import { refreshCartSummary } from "@/components/headless/cart-summary-store";
import { buildCommerceItemsEvent, buildVariantItem } from "@/tracking/commerce-events";
import { publishBrowserTrackingEvent } from "@/tracking/data-layer";

import {
  missingPurchaseOptionMessage,
  resolveMissingPurchaseOptions,
  resolveSelectionAfterColorChange,
  resolveSelectionAfterKindChange,
  resolveSelectionAfterSizeChange,
  resolveVariantSelectionView,
  type PurchaseOptionDimension,
  type VariantSelectionState,
} from "./variant-selection-model.ts";

export type { PurchaseOptionDimension } from "./variant-selection-model.ts";

/**
 * Re-exported so a redrawn panel reads the exact §29 word from the layer it already imports,
 * instead of reaching into `@/commerce` (which this markup layer must not) or retyping it.
 */
export { OUT_OF_STOCK_LABEL } from "../../commerce/preorder-fulfillment-presentation.ts";

/** What the status line says after a confirmed add; the panel dresses this one as a confirmation. */
export const ADDED_TO_BAG_MESSAGE = "Đã thêm sản phẩm vào giỏ hàng.";

/**
 * Purchase behaviour for a redrawn panel: selection state, the add-to-cart mutation and the
 * reporting that follows it.
 *
 * Every decision about what is *true* -- price text, whether a strike-through is shown, why a
 * selection cannot be bought -- comes from `variant-selection-model.ts`, which is pure and tested.
 * This file is the wiring that cannot be: React state, a server action, and two analytics
 * destinations. A brand consumes the returned surface and decides only how it looks.
 */

export type UseVariantSelectionInput = Readonly<{
  slug: string;
  productName: string;
  options: readonly StorefrontProjectionOption[];
  productLevelOptions: readonly StorefrontProjectionOption[];
  initialSelection?: DeepLinkedVariantSelection | null;
  /** Server-resolved: a deployment that publishes no dataLayer must not have one created here. */
  commerceTrackingEnabled?: boolean;
  colorDimensionLabel?: string;
}>;

/**
 * Everything the hook hands back: the resolved view, the raw selection, and the four callbacks.
 *
 * Exported so a panel can render this surface without owning the hook. A PDP that must keep one
 * selection state -- the panel and the gallery showing the same colour -- calls `useVariantSelection`
 * once and passes the result to both, which is only possible if the shape has a name.
 */
export type PurchaseAttemptResult =
  | `missing-${PurchaseOptionDimension}`
  | "blocked"
  | "submitted";

/** The sentence beside each group the shopper was asked to choose in; absent groups are fine. */
export type PurchaseOptionValidation = Readonly<Partial<Record<PurchaseOptionDimension, string>>>;

export type VariantSelectionController = ReturnType<typeof useVariantSelection>;

export function useVariantSelection({
  slug,
  options,
  productLevelOptions,
  initialSelection = null,
  commerceTrackingEnabled = false,
  colorDimensionLabel,
}: UseVariantSelectionInput) {
  const router = useRouter();
  const [state, setState] = useState<VariantSelectionState>({
    kindKey: initialSelection?.kindKey ?? null,
    color: initialSelection?.color ?? null,
    size: initialSelection?.size ?? null,
  });
  const [message, setMessage] = useState("");
  const [validation, setValidation] = useState<PurchaseOptionValidation>({});
  const [isPending, startTransition] = useTransition();

  const view = useMemo(
    () =>
      resolveVariantSelectionView({
        options,
        productLevelOptions,
        selection: state,
        colorDimensionLabel,
      }),
    [options, productLevelOptions, state, colorDimensionLabel],
  );

  /** Settles one group's prompt once the shopper has answered it; the others keep theirs. */
  function clearValidation(dimension: PurchaseOptionDimension) {
    setValidation((current) => {
      if (current[dimension] === undefined) return current;
      const next = { ...current };
      delete next[dimension];
      return next;
    });
  }

  function chooseKind(value: string) {
    // A kind's colours and sizes are its own: only what still exists in it carries over.
    setState((current) =>
      resolveSelectionAfterKindChange({ options, selection: current, kindKey: value }),
    );
    setMessage("");
    clearValidation("kind");
  }

  function chooseColor(value: string) {
    setState((current) =>
      resolveSelectionAfterColorChange({ options, selection: current, color: value }),
    );
    setMessage("");
    clearValidation("color");
  }

  function chooseSize(value: string) {
    setState((current) => resolveSelectionAfterSizeChange({ options, selection: current, size: value }));
    setMessage("");
    clearValidation("size");
  }

  /**
   * Reports one accepted add, from the facts the server committed.
   *
   * Everything measurable here comes back from the mutation: the variation's external identity, the
   * price the cart actually accepted, the name and options, and a quantity of exactly the one unit
   * that was added. The price rendered on this panel is deliberately not used — by the time the
   * action returns it is a pre-request value, and a campaign that started or ended in between would
   * make it a report of money nobody was charged.
   *
   * The two destinations fail independently, because they always have.
   *
   * Meta uses the committed mutation's own event ID, product slug and unit price. Missing Meta
   * facts suppress measurement independently of whether the canonical item can be described.
   *
   * The canonical event needs the complete item — identity, name, options, money — so it is the one
   * that goes silent when `analyticsItem` is absent. No fallback: the cart is correct either way.
   */
  function reportAcceptedAdd(result: Awaited<ReturnType<typeof addStorefrontItemToBag>>) {
    if (!result.ok) return;

    trackCommittedMetaAddToCart(result.metaEvent);

    const committed = result.analyticsItem;
    if (!commerceTrackingEnabled || committed === undefined) return;
    try {
      publishBrowserTrackingEvent(
        buildCommerceItemsEvent("add_to_cart", { items: [buildVariantItem(committed)] }),
      );
    } catch {
      // Tracking never interrupts a shopper.
    }
  }

  /*
   * An unfinished selection keeps the buttons live: pressing one says which choice is missing,
   * beside that group, instead of a dimmed button that does nothing and explains nothing. Only a
   * finished selection that cannot be bought (sold out, a combination that does not exist, nothing
   * purchasable at all) disables them, and the status line says why.
   */
  const missingOptions = resolveMissingPurchaseOptions(view, state);
  const canAttemptPurchase =
    !isPending && (view.canAdd || (missingOptions.length > 0 && view.hasPurchasableVariant));

  /** Asks for every missing choice at once and names the first, which the panel moves focus to. */
  function promptMissingOptions(): PurchaseAttemptResult | null {
    const first = missingOptions[0];
    if (first === undefined) return null;
    setMessage("");
    setValidation(
      Object.fromEntries(
        missingOptions.map((dimension) => [dimension, missingPurchaseOptionMessage(dimension, view)]),
      ),
    );
    return `missing-${first}`;
  }

  function attemptPurchase(
    navigateToCheckout: boolean,
    onAccepted?: () => void,
  ): PurchaseAttemptResult {
    const missing = promptMissingOptions();
    if (missing !== null) return missing;
    if (!view.canAdd || !view.selectedVariantId || isPending) return "blocked";

    const variantId = view.selectedVariantId;
    setMessage("");
    setValidation({});
    startTransition(async () => {
      try {
        const result = await addStorefrontItemToBag({ slug, variantId });
        if (result.ok) {
          reportAcceptedAdd(result);
          void refreshCartSummary();
          if (navigateToCheckout) {
            router.push("/checkout");
          } else {
            setMessage(ADDED_TO_BAG_MESSAGE);
            try {
              onAccepted?.();
            } catch {
              // Presentation handoff failure must never rewrite a server-accepted cart mutation.
            }
          }
          return;
        }
        setMessage("Lựa chọn này vừa thay đổi hoặc không còn mua được. Nàng chọn lại nhé.");
      } catch {
        setMessage("Chưa thêm được vào giỏ hàng. Nàng thử lại nhé.");
      }
    });
    return "submitted";
  }

  function addToBag(onAccepted?: () => void): PurchaseAttemptResult {
    return attemptPurchase(false, onAccepted);
  }

  function buyNow(): PurchaseAttemptResult {
    return attemptPurchase(true);
  }

  /**
   * A tap on a size that is locked because no kind is chosen yet. The disabled radio cannot answer
   * it, so the kind group is asked for instead of the tap landing on nothing.
   */
  function promptForKind(): PurchaseAttemptResult | null {
    if (!view.hasKindOptions || state.kindKey !== null) return null;
    return promptMissingOptions();
  }

  return {
    view,
    selection: state,
    isPending,
    canAttemptPurchase,
    /** The add-to-cart outcome message, or "" when there is nothing to say. */
    message,
    /** Client validation only, per group; cart authority still lives in the server action. */
    validation,
    chooseKind,
    chooseColor,
    chooseSize,
    addToBag,
    buyNow,
    promptForKind,
  };
}
