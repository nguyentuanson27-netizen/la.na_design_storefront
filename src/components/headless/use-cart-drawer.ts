"use client";

import { useCallback, useEffect, useState, useTransition } from "react";

import {
  getStorefrontCartLines,
  removeStorefrontCartLine,
  updateStorefrontCartLine,
} from "@/commerce/storefront-cart-actions";
import { publishCartSummary } from "@/components/headless/cart-summary-store";
import { buildCartViewModel, summarizeCartViewModel, type CartViewModel } from "@/routes/cart-model";
import { trackCommittedMetaAddToCart } from "@/components/analytics/meta-browser-client";

export function useCartDrawer(isOpen: boolean) {
  const [cart, setCart] = useState<CartViewModel | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

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
  } else if (!isOpen && prevIsOpen) {
    setPrevIsOpen(false);
  }

  const loadCart = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const lines = await getStorefrontCartLines();
      const model = buildCartViewModel({ lines, commerceTrackingEnabled: false });
      setCart(model);
    } catch {
      setError("Không thể tải thông tin giỏ hàng. Vui lòng thử lại.");
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
        const lines = await getStorefrontCartLines();
        if (isMounted) {
          setCart(buildCartViewModel({ lines, commerceTrackingEnabled: false }));
        }
      } catch {
        if (isMounted) {
          setError("Không thể tải thông tin giỏ hàng. Vui lòng thử lại.");
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

  const updateQuantity = useCallback(
    async (variantId: string, quantity: number): Promise<boolean> => {
      if (quantity < 1) return false;
      return new Promise((resolve) => {
        startTransition(async () => {
          try {
            const result = await updateStorefrontCartLine({ variantId, quantity });
            if (result.ok) {
              trackCommittedMetaAddToCart(result.metaEvent);
              const lines = await getStorefrontCartLines();
              setCart(buildCartViewModel({ lines, commerceTrackingEnabled: false }));
              resolve(true);
            } else {
              setError("Không thể cập nhật số lượng sản phẩm.");
              resolve(false);
            }
          } catch {
            setError("Lỗi kết nối khi cập nhật giỏ hàng.");
            resolve(false);
          }
        });
      });
    },
    [],
  );

  const removeItem = useCallback(
    async (variantId: string): Promise<boolean> => {
      return new Promise((resolve) => {
        startTransition(async () => {
          try {
            const result = await removeStorefrontCartLine({ variantId });
            if (result.ok) {
              const lines = await getStorefrontCartLines();
              setCart(buildCartViewModel({ lines, commerceTrackingEnabled: false }));
              resolve(true);
            } else {
              setError("Không thể xóa sản phẩm khỏi giỏ hàng.");
              resolve(false);
            }
          } catch {
            setError("Lỗi kết nối khi xóa sản phẩm.");
            resolve(false);
          }
        });
      });
    },
    [],
  );

  return {
    cart,
    isLoading,
    isPending,
    error,
    loadCart,
    updateQuantity,
    removeItem,
  };
}
