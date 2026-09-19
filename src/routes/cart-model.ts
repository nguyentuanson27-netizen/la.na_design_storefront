import {
  buildPreorderFulfillmentNotice,
  PREORDER_LABEL,
  type PreorderFulfillmentNotice,
} from "../commerce/preorder-fulfillment-presentation.ts";
import type { StorefrontCartLine } from "../commerce/storefront-cart.ts";
import type { TrustedProductImage } from "../commerce/product-media.ts";

/**
 * Everything the cart route decides, as one pure function.
 *
 * Separate from `cart.ts` because that file reaches the cart runtime and `next/server`. What is left
 * is what the page decided inline: the subtotal, why a line cannot be bought, whether a line may
 * still be edited, and whether checkout is reachable at all.
 */

const currency = new Intl.NumberFormat("vi-VN", {
  style: "currency",
  currency: "VND",
  maximumFractionDigits: 0,
});

export type CartLineView = Readonly<{
  variantId: string;
  productName: string;
  productSlug: string | null;
  primaryImage: TrustedProductImage | null;
  /** `Màu / Kích cỡ`, or the fallback when the line resolved to no option pair. */
  optionLabel: string;
  quantity: number;
  priceText: string;
  available: boolean;
  /** "Có thể mua", or the reason it is not. */
  availabilityLabel: string;
  /**
   * Whether the quantity field stays usable. Insufficient stock is editable on purpose: lowering
   * the quantity is the fix, so locking the field would trap the shopper on the row.
   */
  canUpdate: boolean;
  /**
   * F8b / §30 — the exact `Đặt trước` word for this line, or `null` for an ordinary line.
   *
   * Per line rather than per basket, because the marker has to survive the trip from the PDP for
   * the line the shopper actually chose. An `OVERSELL` line is `null` here: it is a ready-stock
   * sale that happens to sit below zero internally, and §31 keeps it visually normal.
   */
  preorderLabel: string | null;
}>;

export type CartViewModel = Readonly<{
  isEmpty: boolean;
  lines: readonly CartLineView[];
  lineCount: number;
  /** Excludes unavailable lines, and is `null` when a total could not be computed. */
  subtotalText: string;
  hasUnavailableLines: boolean;
  /** Checkout is only offered when every line is buyable and a subtotal exists. */
  canCheckout: boolean;
  /** Server-resolved: a deployment that publishes no dataLayer must not have one created here. */
  commerceTrackingEnabled: boolean;
  /**
   * F8b / §30 — the preparation and shipment truth for this basket, or `null` when it holds no
   * preorder line. Decided by the shared projection so cart and checkout say the same thing.
   */
  preorderNotice: PreorderFulfillmentNotice | null;
}>;

/** Why a line cannot be bought, in the shopper's words. */
export function cartUnavailableLabel(line: StorefrontCartLine): string {
  switch (line.unavailableReason) {
    case "OUT_OF_STOCK":
      return "Tạm hết hàng";
    case "INSUFFICIENT_STOCK":
      return "Không đủ tồn kho cho số lượng này";
    case "PRICE_UNRESOLVED":
      return "Giá đang cập nhật";
    case "MAPPING_REQUIRED":
      return "Màu × kích cỡ chưa hoàn tất";
    case "AMBIGUOUS_OPTION":
      return "Màu × kích cỡ đang bị trùng";
    case "PRODUCT_UNAVAILABLE":
    case "VARIANT_UNAVAILABLE":
      return "Sản phẩm không còn khả dụng";
    default:
      return "Chưa thể mua online";
  }
}

/**
 * The total of the lines that can actually be bought.
 *
 * Unavailable lines are excluded rather than counted at zero, and a non-finite intermediate gives up
 * entirely: a subtotal nobody can be charged is worse than saying it cannot be computed yet.
 */
export function cartAvailableSubtotal(lines: readonly StorefrontCartLine[]): number | null {
  let total = 0;
  for (const line of lines) {
    if (!line.available || line.price === null) continue;
    const lineTotal = line.price * line.quantity;
    if (!Number.isFinite(lineTotal)) return null;
    total += lineTotal;
    if (!Number.isFinite(total)) return null;
  }
  return total;
}

export function buildCartViewModel(
  input: Readonly<{
    lines: readonly StorefrontCartLine[];
    commerceTrackingEnabled: boolean;
  }>,
): CartViewModel {
  const subtotal = cartAvailableSubtotal(input.lines);
  const hasUnavailableLines = input.lines.some((line) => !line.available);

  return Object.freeze({
    isEmpty: input.lines.length === 0,
    lineCount: input.lines.length,
    lines: Object.freeze(
      input.lines.map((line) =>
        Object.freeze({
          variantId: line.variantId,
          productName: line.productName ?? "Sản phẩm không còn trong catalog",
          productSlug: line.productSlug,
          primaryImage: line.media.primary,
          optionLabel:
            [line.color, line.size].filter(Boolean).join(" / ") || "Màu / Kích cỡ không khả dụng",
          quantity: line.quantity,
          priceText: line.price === null ? "Giá đang cập nhật" : currency.format(line.price),
          available: line.available,
          availabilityLabel: line.available ? "Có thể mua" : cartUnavailableLabel(line),
          canUpdate: line.available || line.unavailableReason === "INSUFFICIENT_STOCK",
          // The line's own canonical classification. Withheld when the line cannot be bought, for
          // the same reason the cart line withholds it: an unavailable line is not being ordered.
          preorderLabel: line.available && line.isPreorderSale ? PREORDER_LABEL : null,
        }),
      ),
    ),
    subtotalText: subtotal === null ? "Chưa thể tính" : currency.format(subtotal),
    hasUnavailableLines,
    canCheckout: !hasUnavailableLines && subtotal !== null,
    commerceTrackingEnabled: input.commerceTrackingEnabled,
    preorderNotice: buildPreorderFulfillmentNotice(input.lines),
  });
}
