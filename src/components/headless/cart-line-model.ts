import type {
  CartMutationAnalytics,
  StorefrontCartRemoveResult,
  StorefrontCartUpdateResult,
} from "../../commerce/storefront-cart-public-actions.ts";

/**
 * Every decision the cart line editor makes, as pure functions.
 *
 * These are separated from `use-cart-line.ts` because the hook reaches the cart server actions,
 * which import `next/headers` and cannot be loaded outside a Next request, and because it drives
 * the router. What is left here is what a brand redrawing the editor must never have to decide
 * again: which typed quantity is worth sending, what a shopper is told when the server refuses,
 * and when the route is re-read.
 *
 * None of it is new. The quantity bound is the column's, and every message is the one the editor
 * already showed.
 */

/** The largest quantity the cart column can hold. A larger one is refused before any request. */
export const CART_LINE_MAX_QUANTITY = 2_147_483_647;

export type CartLineQuantity = Readonly<{ value: number; isValid: boolean }>;

export type CartLineOutcome = Readonly<{
  /** What to show the shopper, or `""` when there is nothing to say. */
  message: string;
  /** Whether the route should be re-read, because the server may have moved the cart. */
  refreshes: boolean;
  /** The event the server said this mutation produced, if it produced one. */
  analytics: CartMutationAnalytics | undefined;
}>;

export function resolveCartLineQuantity(raw: string): CartLineQuantity {
  const value = Number(raw);
  return Object.freeze({
    value,
    isValid:
      raw.trim().length > 0
      && Number.isSafeInteger(value)
      && value > 0
      && value <= CART_LINE_MAX_QUANTITY,
  });
}

export function resolveCartLineUpdateOutcome(result: StorefrontCartUpdateResult): CartLineOutcome {
  if (result.ok) {
    return Object.freeze({
      message: "Đã cập nhật số lượng.",
      refreshes: true,
      analytics: result.analytics,
    });
  }

  return Object.freeze({
    message:
      result.reason === "LINE_UNAVAILABLE"
        ? "Số lượng này hiện không khả dụng. Hãy thử số lượng thấp hơn."
        : "Không thể cập nhật số lượng lúc này.",
    refreshes: true,
    analytics: undefined,
  });
}

export function resolveCartLineRemoveOutcome(result: StorefrontCartRemoveResult): CartLineOutcome {
  // A committed removal says nothing: the line it would have described is gone after the refresh.
  return Object.freeze({
    message: result.ok ? "" : "Không thể xóa sản phẩm lúc này.",
    refreshes: true,
    analytics: result.ok ? result.analytics : undefined,
  });
}

/**
 * The outcome of a request that never settled.
 *
 * It does not refresh, and that is characterized rather than designed: the editor re-reads the
 * route on every answer the server gave, a refusal included, but there is no committed state to
 * re-read when the call threw -- and refreshing then would replace the shopper's typed quantity
 * with the one the page was rendered with.
 */
export function resolveCartLineThrownOutcome(operation: "update" | "remove"): CartLineOutcome {
  return Object.freeze({
    message:
      operation === "update"
        ? "Không thể cập nhật số lượng lúc này."
        : "Không thể xóa sản phẩm lúc này.",
    refreshes: false,
    analytics: undefined,
  });
}
