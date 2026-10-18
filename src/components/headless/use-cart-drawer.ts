"use client";

import { useCallback, useEffect, useState, useTransition } from "react";

import {
  getStorefrontCartView,
  removeStorefrontCartLine,
  updateStorefrontCartLine,
} from "@/commerce/storefront-cart-actions";
import { publishCartSummary } from "@/components/headless/cart-summary-store";
import { cartStockLimitText, summarizeCartViewModel, type CartViewModel } from "@/routes/cart-model";
import { trackCommittedMetaAddToCart } from "@/components/analytics/meta-browser-client";

export type CartDrawerLineNotice = Readonly<{
  variantId: string;
  message: string;
  /** Known only on a stock refusal: the largest quantity that would sell right now. */
  maxQuantity?: number;
}>;

export function useCartDrawer(isOpen: boolean) {
  const [cart, setCart] = useState<CartViewModel | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // A refused quantity change is about one line, so it is said next to that line's stepper and the
  // drawer keeps showing the cart. `error` is reserved for a cart that could not be read at all.
  const [lineNotice, setLineNotice] = useState<CartDrawerLineNotice | null>(null);

  // The drawer is where quantities change and lines are removed, so it keeps the chrome's cart
  // summary (header badge, mobile purchase bar) in step with what it just rendered.
  useEffect(() => {
    if (cart) publishCartSummary(summarizeCartViewModel(cart));
  }, [cart]);

  const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
  if (isOpen && !prevIsOpen) {
    setPrevIsOpen(true);
    setIsLoading(true);
    setError(null);
    setLineNotice(null);
  } else if (!isOpen && prevIsOpen) {
    setPrevIsOpen(false);
  }

  const loadCart = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      setCart(await getStorefrontCartView());
    } catch {
      setError("Chưa tải được giỏ hàng. Nàng thử lại nhé.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Refresh cart when drawer opens
  useEffect(() => {
    if (!isOpen) return;
    let isMounted = true;

    void (async () => {
      try {
        const view = await getStorefrontCartView();
        if (isMounted) setCart(view);
      } catch {
        if (isMounted) {
          setError("Chưa tải được giỏ hàng. Nàng thử lại nhé.");
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      isMounted = false;
    };
  }, [isOpen]);

  const refreshAfterRefusal = useCallback(async () => {
    try {
      setCart(await getStorefrontCartView());
    } catch {
      // The notice already says what happened; a stale cart is corrected on the next open.
    }
  }, []);

  const updateQuantity = useCallback(
    async (variantId: string, quantity: number): Promise<boolean> => {
      if (quantity < 1) return false;
      setLineNotice(null);
      return new Promise((resolve) => {
        startTransition(async () => {
          try {
            const result = await updateStorefrontCartLine({ variantId, quantity });
            if (result.ok) {
              trackCommittedMetaAddToCart(result.metaEvent);
              setCart(await getStorefrontCartView());
              resolve(true);
            } else {
              setLineNotice(
                result.reason === "LINE_UNAVAILABLE"
                  ? result.maxQuantity
                    ? { variantId, message: cartStockLimitText(result.maxQuantity), maxQuantity: result.maxQuantity }
                    : { variantId, message: "Số lượng này hiện không đủ hàng." }
                  : { variantId, message: "Chưa cập nhật được số lượng. Nàng thử lại nhé." },
              );
              await refreshAfterRefusal();
              resolve(false);
            }
          } catch {
            setLineNotice({ variantId, message: "Chưa cập nhật được số lượng. Nàng thử lại nhé." });
            resolve(false);
          }
        });
      });
    },
    [refreshAfterRefusal],
  );

  const removeItem = useCallback(
    async (variantId: string): Promise<boolean> => {
      setLineNotice(null);
      return new Promise((resolve) => {
        startTransition(async () => {
          try {
            const result = await removeStorefrontCartLine({ variantId });
            if (result.ok) {
              setCart(await getStorefrontCartView());
              resolve(true);
            } else {
              setLineNotice({ variantId, message: "Chưa xóa được sản phẩm. Nàng thử lại nhé." });
              await refreshAfterRefusal();
              resolve(false);
            }
          } catch {
            setLineNotice({ variantId, message: "Chưa xóa được sản phẩm. Nàng thử lại nhé." });
            resolve(false);
          }
        });
      });
    },
    [refreshAfterRefusal],
  );

  return {
    cart,
    isLoading,
    isPending,
    error,
    lineNotice,
    loadCart,
    updateQuantity,
    removeItem,
  };
}
