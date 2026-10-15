import {
  buildPreorderFulfillmentNotice,
  PREORDER_LABEL,
  type PreorderFulfillmentNotice,
} from "../commerce/preorder-fulfillment-presentation.ts";
import { hasQuantityTierSegment } from "../commerce/benefit-tier-segment.ts";
import type { StorefrontCartLine } from "../commerce/storefront-cart.ts";
import type { TrustedProductImage } from "../commerce/product-media.ts";
import type { CartGiftState } from "../commerce/cart-gift-selection.ts";
import { buildCartGiftPickerModel, type CartGiftPickerModel } from "./cart-gift-model.ts";

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
  paidSegments?: readonly string[];
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
  gifts?: CartGiftPickerModel;
  benefitsNotice?: string;
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

/** Legacy analytics cannot represent a tier's different paid prices for one variation. */
export function canTrackLegacyCartPrices(input: Readonly<{
  lines: readonly StorefrontCartLine[]; giftState?: CartGiftState; benefitsUnavailable?: boolean;
}>): boolean {
  if (input.benefitsUnavailable) return false;
  if (!input.giftState) return true; // OFF keeps the existing analytics projection exactly.
  const benefits = input.giftState.quote.benefits;
  if (!benefits.enabled || !benefits.ok || benefits.subtotalVnd !== cartAvailableSubtotal(input.lines)) return false;
  // Equal totals alone do not prove equal item prices or quantities.
  const paid = input.lines.filter((line) => line.available && line.price !== null);
  return benefits.groups.every((group) => paid.some((line) => line.variantId === group.lineKey && line.price === group.unitPriceVnd)) &&
    paid.every((line) => benefits.groups.filter((group) => group.lineKey === line.variantId).reduce((sum, group) => sum + group.quantity, 0) === line.quantity);
}

export function buildCartViewModel(
  input: Readonly<{
    lines: readonly StorefrontCartLine[];
    commerceTrackingEnabled: boolean;
    giftState?: CartGiftState;
    benefitsUnavailable?: boolean;
    /** GQ19: checkout can take a cart with gifts or split-price segments (the POS shop is verified for them). */
    benefitCheckoutOpen?: boolean;
  }>,
): CartViewModel {
  const subtotal = cartAvailableSubtotal(input.lines);
  const hasUnavailableLines = input.lines.some((line) => !line.available);
  const state = input.giftState;
  const benefits = state?.quote.benefits;
  const paidBenefits = benefits?.enabled && benefits.ok ? benefits : null;
  // EX-21: a successful recomputation is not buyer acknowledgement of the dropped tier.
  const tierPriceInvalid = paidBenefits?.dropped.some((entry) => entry.reason === "TIER_PRICE_INVALID");
  // GQ19: checkout renders and proves the benefit quote (gifts at 0đ, split paid prices, the non-claim
  // acknowledgement, an EX-21 re-quote), so a consistent benefit cart is no longer held back here --
  // but only where the POS would actually accept such an order. Anything the checkout could not render
  // faithfully (unreadable benefits, a stored gift choice that no longer validates) still stops at the cart.
  const benefitCheckoutOpen = input.benefitCheckoutOpen === true;
  const hasBenefitSegments = Boolean(
    state && (state.selections.length > 0 || state.entitlements.some((entry) => entry.entitled > 0) || (paidBenefits && (hasQuantityTierSegment(paidBenefits.groups) || paidBenefits.subtotalVnd !== subtotal)) || tierPriceInvalid),
  );
  const benefitBlocked = input.benefitsUnavailable || (state && !state.validation.ok) || (hasBenefitSegments && !benefitCheckoutOpen);
  const checkoutPending = Boolean(benefitBlocked);

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
          ...(paidBenefits && paidBenefits.groups.some((group) => group.lineKey === line.variantId && group.unitPriceVnd !== line.price)
            ? { paidSegments: paidBenefits.groups.filter((group) => group.lineKey === line.variantId).map((group) => `${group.quantity} × ${currency.format(group.unitPriceVnd)}`) } : {}),
        }),
      ),
    ),
    subtotalText: input.benefitsUnavailable || subtotal === null ? "Chưa thể tính" : currency.format(paidBenefits?.subtotalVnd ?? subtotal),
    hasUnavailableLines,
    canCheckout: !hasUnavailableLines && subtotal !== null && !checkoutPending,
    commerceTrackingEnabled: input.commerceTrackingEnabled,
    preorderNotice: buildPreorderFulfillmentNotice(input.lines),
    ...(state ? { gifts: buildCartGiftPickerModel(state) } : {}),
    ...(checkoutPending ? { benefitsNotice: input.benefitsUnavailable ? "Chưa thể kiểm tra quyền lợi. Vui lòng thử lại trước khi đặt hàng." : state && !state.validation.ok
      ? "Quà bạn đã chọn không còn hợp lệ. Hãy chọn lại quà trong giỏ hàng trước khi đặt hàng."
      : tierPriceInvalid
        ? "Chương trình giảm giá theo số lượng không còn áp dụng vì mức giảm so với giá hiện tại không hợp lệ. Đơn có quà tặng hoặc ưu đãi theo số lượng hiện chưa thể đặt trực tuyến."
        : "Bạn có thể chọn hoặc bỏ quà trong giỏ. Đơn có quà tặng hoặc ưu đãi theo số lượng hiện chưa thể đặt trực tuyến; vui lòng quay lại sau." } : {}),
  });
}

/**
 * What the chrome needs to say "your cart has something in it": how many pieces and what they come to.
 *
 * Deliberately smaller than {@link CartViewModel}. The header badge and the mobile purchase bar read
 * it on every page, so it carries no lines and no tracking facts, and it is built from the same
 * view model the drawer renders -- the two can never disagree about the total.
 */
export type CartSummary = Readonly<{
  /** Total pieces across every line, unavailable ones included: they are still in the cart. */
  count: number;
  /** The view model's subtotal text; only meaningful when `count` is above zero. */
  totalText: string;
}>;

export const EMPTY_CART_SUMMARY: CartSummary = Object.freeze({ count: 0, totalText: "" });

export function summarizeCartViewModel(model: CartViewModel): CartSummary {
  if (model.isEmpty) return EMPTY_CART_SUMMARY;
  const count = model.lines.reduce((sum, line) => sum + line.quantity, 0);
  if (!Number.isFinite(count) || count < 1) return EMPTY_CART_SUMMARY;
  return Object.freeze({ count, totalText: model.subtotalText });
}
