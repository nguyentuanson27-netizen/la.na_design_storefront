import type { PromotionSavingRow } from "./cart-promotion-model.ts";

/**
 * The money block of the drawer, the cart page and checkout, in the order the shopper reads a bill:
 *
 *   Tổng giá trị đơn hàng   what the lines add up to (per-product promotions are already on the lines)
 *   <each discount>         one named line per cart-level campaign, taken off
 *   Vận chuyển
 *   Tổng thanh toán
 *
 * Pure, and built from facts the server already decided. It never prices anything itself: it receives the
 * goods total *after* the discounts, the discount rows, and the shipping fee, and shows the sum they make --
 * and where the page already has an authoritative total (checkout's signed quote) the two must agree or no
 * summary is returned at all, so a shopper is never shown a bill whose lines do not add up.
 */

const currency = new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 });

export type OrderSummaryRow = Readonly<{ id: string; label: string; amountText: string }>;

export type OrderSummaryView = Readonly<{
  /** Tổng giá trị đơn hàng. */
  valueText: string;
  /** Each discount that was taken off, named by its campaign. */
  discounts: readonly OrderSummaryRow[];
  /** Free gifts on the order (they cost 0 ₫); 0 when there are none. */
  giftQuantity: number;
  /** "Miễn phí" or the fee. */
  shippingText: string;
  /** Tổng thanh toán. */
  totalText: string;
}>;

export function buildOrderSummary(input: Readonly<{
  /** Paid goods after every cart-level discount, whole VND. */
  goodsAfterDiscountsVnd: number;
  discounts: readonly PromotionSavingRow[];
  shippingFeeVnd: number;
  giftQuantity?: number;
  /** An authoritative total to check the sum against (checkout's quote); a mismatch returns `null`. */
  expectedTotalVnd?: number;
  /** An authoritative "Tổng giá trị đơn hàng" (the lines at their listed prices); a mismatch returns `null`. */
  expectedValueVnd?: number;
}>): OrderSummaryView | null {
  const { goodsAfterDiscountsVnd, discounts, shippingFeeVnd } = input;
  if (![goodsAfterDiscountsVnd, shippingFeeVnd].every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
  const discountVnd = discounts.reduce((sum, row) => sum + row.amountVnd, 0);
  const valueVnd = goodsAfterDiscountsVnd + discountVnd;
  const totalVnd = goodsAfterDiscountsVnd + shippingFeeVnd;
  if (!Number.isSafeInteger(valueVnd) || !Number.isSafeInteger(totalVnd)) return null;
  if (input.expectedTotalVnd !== undefined && input.expectedTotalVnd !== totalVnd) return null;
  if (input.expectedValueVnd !== undefined && input.expectedValueVnd !== valueVnd) return null;
  return Object.freeze({
    valueText: currency.format(valueVnd),
    discounts: Object.freeze(discounts.map((row) => Object.freeze({ id: row.id, label: row.label, amountText: `−${row.amountText}` }))),
    giftQuantity: input.giftQuantity ?? 0,
    shippingText: shippingFeeVnd === 0 ? "Miễn phí" : currency.format(shippingFeeVnd),
    totalText: currency.format(totalVnd),
  });
}
