"use client";

import { useEffect, useMemo, useState, useTransition } from "react";

import { buildMetaAddToCartPixelParameters } from "@/commerce/meta-pixel-parameters";
import { addStorefrontItemToBag } from "@/commerce/storefront-actions";
import type { StorefrontProjectionOption } from "@/commerce/storefront-projection";
import type { DeepLinkedVariantSelection } from "@/commerce/storefront-variant-deep-link";
import { trackFacebookPixelEvent } from "@/components/analytics/facebook-pixel-client";
import { buildCommerceItemsEvent, buildVariantItem } from "@/tracking/commerce-events";
import { publishBrowserTrackingEvent } from "@/tracking/data-layer";

import {
  resolveSelectionAfterSizeChange,
  resolveVariantSelectionView,
  type VariantSelectionState,
} from "./variant-selection-model.ts";

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
}>;

export function useVariantSelection({
  slug,
  productName,
  options,
  productLevelOptions,
  initialSelection = null,
  commerceTrackingEnabled = false,
}: UseVariantSelectionInput) {
  const [state, setState] = useState<VariantSelectionState>({
    kindKey: initialSelection?.kindKey ?? null,
    color: initialSelection?.color ?? null,
    size: initialSelection?.size ?? null,
  });
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();

  const view = useMemo(
    () => resolveVariantSelectionView({ options, productLevelOptions, selection: state }),
    [options, productLevelOptions, state],
  );

  const entryPrice = view.entryPrice;
  useEffect(() => {
    trackFacebookPixelEvent("ViewContent", {
      content_ids: [slug],
      content_name: productName,
      content_type: "product",
      currency: "VND",
      ...(entryPrice === null ? {} : { value: entryPrice }),
    });
  }, [entryPrice, productName, slug]);

  function chooseKind(value: string) {
    // Picking a kind restarts the choice: its sizes and colours are its own.
    setState({ kindKey: value, color: null, size: null });
    setMessage("");
  }

  function chooseColor(value: string) {
    setState((current) => ({ ...current, color: value }));
    setMessage("");
  }

  function chooseSize(value: string) {
    setState((current) => resolveSelectionAfterSizeChange({ options, selection: current, size: value }));
    setMessage("");
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
   * Meta reports on every accepted add, as it did before this unit existed. Its value now comes
   * from `committedUnitPriceVnd` instead of the rendered price, and is omitted when the server has
   * no usable price — which is exactly the shape the previous code had for an unresolved price.
   * Making Meta's delivery depend on the newer canonical item would silently narrow a success
   * boundary that is not this unit's to change.
   *
   * The canonical event needs the complete item — identity, name, options, money — so it is the one
   * that goes silent when `analyticsItem` is absent. No fallback: the cart is correct either way.
   */
  function reportAcceptedAdd(result: Awaited<ReturnType<typeof addStorefrontItemToBag>>) {
    if (!result.ok) return;

    trackFacebookPixelEvent(
      "AddToCart",
      buildMetaAddToCartPixelParameters({
        slug,
        productName,
        committedUnitPriceVnd: result.committedUnitPriceVnd,
      }),
    );

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

  function addToBag() {
    if (!view.canAdd || !view.selectedVariantId || isPending) return;
    const variantId = view.selectedVariantId;
    setMessage("");
    startTransition(async () => {
      try {
        const result = await addStorefrontItemToBag({ slug, variantId });
        if (result.ok) {
          setMessage("Đã thêm sản phẩm vào giỏ hàng.");
          reportAcceptedAdd(result);
          return;
        }
        setMessage("Lựa chọn này vừa thay đổi hoặc không còn mua được. Vui lòng chọn lại.");
      } catch {
        setMessage("Không thể thêm vào giỏ hàng lúc này. Vui lòng thử lại.");
      }
    });
  }

  return {
    view,
    selection: state,
    isPending,
    /** The add-to-cart outcome message, or "" when there is nothing to say. */
    message,
    chooseKind,
    chooseColor,
    chooseSize,
    addToBag,
  };
}
