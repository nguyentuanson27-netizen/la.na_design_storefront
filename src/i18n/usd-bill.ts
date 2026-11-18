import type { CartViewModel } from "../routes/cart-model.ts";
import type { CheckoutViewModel } from "../routes/checkout-model.ts";
import type { OrderSummaryView } from "../routes/order-summary-model.ts";
import type { VoucherPickerModel } from "../routes/voucher-picker-model.ts";
import { exactCentsFromVnd, formatCents, priceCentsFromVnd } from "./money.ts";

/**
 * The English bill, recomputed from the prices it shows.
 *
 * Every dong amount the English pages show is moved to a price ending (.49 or .99, `money.ts`). Done
 * to each figure on its own, that breaks the arithmetic of a bill: 2 x $10.49 beside a line total of
 * $20.49. So the English display works the way a dollar storefront does: only *prices* take an ending
 * (a unit price, a struck-through list price, a shipping fee), and everything built from them is
 * calculated from what is displayed, in cents:
 *
 *   line total   = quantity x displayed unit price (summed over a benefit quote's price segments)
 *   subtotal     = the sum of the line totals
 *   order value  = the subtotal plus the discounts taken off it
 *   discounts    = the difference between the two, shared out over the discount rows
 *   total        = subtotal + displayed shipping
 *
 * Display only. The Vietnamese pages, the order, the payment and every server-side figure are in dong.
 * The functions are pure and take the view models the cart already builds (plus the numbers they now
 * carry beside their texts); they return the same shape with the money texts replaced by dollar text,
 * which the translator leaves alone because it contains no dong sign.
 */

const MINUS = "−";
const FREE = "Miễn phí";

/** The cents of the displayed price of `vnd`. */
function price(vnd: number): number {
  return priceCentsFromVnd(vnd);
}

/**
 * Shares `totalCents` over rows whose dong amounts are `rowsVnd`: every row but the last is its own
 * amount converted to the cent, and the last takes what is left, so the rows always add up to the
 * total. When the earlier rows already exceed the total they are cut back from the end.
 */
export function shareAmount(totalCents: number, rowsVnd: readonly number[]): number[] {
  if (rowsVnd.length === 0) return [];
  const amounts = rowsVnd.map((vnd) => Math.max(0, exactCentsFromVnd(vnd)));
  const target = Math.max(0, totalCents);
  const earlier = amounts.slice(0, -1).reduce((sum, cents) => sum + cents, 0);
  amounts[amounts.length - 1] = target - earlier;
  for (let index = amounts.length - 1; amounts[index]! < 0 && index > 0; index -= 1) {
    amounts[index - 1] = amounts[index - 1]! + amounts[index]!;
    amounts[index] = 0;
  }
  return amounts.map((cents) => Math.max(0, cents));
}

/** The shipping line as dollars: the displayed fee, net of a shipping voucher that waived part of it. */
function shippingCents(feeVnd: number, waivedVnd: number): { net: number; waived: number } {
  if (waivedVnd > 0) {
    const waived = price(waivedVnd);
    return { net: Math.max(0, price(feeVnd + waivedVnd) - waived), waived };
  }
  return { net: feeVnd === 0 ? 0 : price(feeVnd), waived: 0 };
}

/**
 * The money block (order value, discounts, shipping, total) over a subtotal that has already been
 * worked out from the lines. `valueCents` is what the lines come to before the cart-level discounts.
 */
export function usdOrderSummary(
  summary: OrderSummaryView,
  bill: Readonly<{ valueCents: number; payableCents: number }>,
): OrderSummaryView {
  const discountTotal = summary.discounts.length === 0 ? 0 : Math.max(0, bill.valueCents - bill.payableCents);
  const discounts = shareAmount(discountTotal, summary.discounts.map((row) => row.amountVnd));
  const shipping = shippingCents(summary.facts.shippingFeeVnd, summary.facts.shippingWaivedVnd);
  return Object.freeze({
    ...summary,
    valueText: formatCents(bill.payableCents + discountTotal),
    discounts: Object.freeze(summary.discounts.map((row, index) => Object.freeze({ ...row, amountText: `${MINUS}${formatCents(discounts[index] ?? 0)}` }))),
    shippingText: shipping.net === 0 ? FREE : formatCents(shipping.net),
    shippingVoucher: summary.shippingVoucher === null
      ? null
      : Object.freeze({ ...summary.shippingVoucher, amountText: `${MINUS}${formatCents(shipping.waived)}` }),
    totalText: formatCents(bill.payableCents + shipping.net),
  });
}

/**
 * The cart's voucher preview over the same subtotal: what the chosen vouchers take off the goods and
 * the shipping, and what is left to pay. Its figures are measured from the displayed subtotal, not
 * from the preview's own dong conversion.
 */
export function usdVoucherSummary(
  summary: VoucherPickerModel["summary"],
  payableCents: number,
): VoucherPickerModel["summary"] {
  const { facts } = summary;
  const merchandiseTotal = Math.min(payableCents, facts.merchandiseDiscountVnd > 0 ? price(facts.merchandiseDiscountVnd) : 0);
  const lineAmounts = shareAmount(merchandiseTotal, summary.discountLines.map((line) => line.amountVnd));
  // The quote's fee is what is left to pay after the shipping voucher; the voucher's part is shown beside it.
  const shipping = shippingCents(facts.shippingFeeVnd, facts.shippingDiscountVnd);
  const total = payableCents - merchandiseTotal + shipping.net;
  const lineText = (cents: number) => `-${formatCents(cents)}`;
  return Object.freeze({
    ...summary,
    paidBeforeText: formatCents(payableCents),
    merchandiseDiscountText: facts.merchandiseDiscountVnd > 0 ? lineText(merchandiseTotal) : null,
    merchandiseLines: Object.freeze(summary.merchandiseLines.length > 1
      ? summary.merchandiseLines.map((line, index) => Object.freeze({ ...line, amountText: lineText(shareAmount(merchandiseTotal, summary.merchandiseLines.map((row) => row.amountVnd))[index] ?? 0) }))
      : []),
    discountLines: Object.freeze(summary.discountLines.map((line, index) => Object.freeze({ ...line, amountText: lineText(lineAmounts[index] ?? 0) }))),
    shippingFeeText: formatCents(shipping.net),
    shippingDiscountText: facts.shippingDiscountVnd > 0 ? lineText(shipping.waived) : null,
    totalText: formatCents(total),
    totalVnd: summary.totalVnd,
    savingText: merchandiseTotal + shipping.waived > 0 ? formatCents(merchandiseTotal + shipping.waived) : null,
  });
}

type CartVouchers = Readonly<{ vouchers: VoucherPickerModel | null }>;

/**
 * The cart, drawer and badge in dollars, recomputed from the prices they show. The cart page passes
 * its `vouchers` along (the preview under the bill); the drawer has none.
 */
export function usdCart<T extends CartViewModel>(model: T): T {
  let payable = 0;
  let value = 0;
  let reference = 0;
  let listReference = 0;
  const lines = model.lines.map((line) => {
    const bill = line.bill;
    if (bill === undefined || line.lineTotalText === undefined) return line;
    const unit = price(bill.unitVnd);
    const segments = bill.segments;
    const total = segments === undefined
      ? line.quantity * unit
      : segments.reduce((sum, segment) => sum + segment.quantity * price(segment.unitVnd), 0);
    payable += total;
    value += line.quantity * unit;
    reference += line.quantity * price(bill.referenceUnitVnd);
    listReference += line.quantity * price(bill.listReferenceUnitVnd);
    const paidSegmentPrices = line.paidSegmentPrices && segments
      ? line.paidSegmentPrices.map((entry, index) => {
          const segment = segments[index];
          if (segment === undefined) return entry;
          return {
            ...entry,
            priceText: formatCents(price(segment.unitVnd)),
            ...(entry.originalPriceText !== undefined && segment.originalUnitVnd !== undefined ? { originalPriceText: formatCents(price(segment.originalUnitVnd)) } : {}),
          };
        })
      : undefined;
    return Object.freeze({
      ...line,
      priceText: formatCents(unit),
      ...(line.originalPriceText !== undefined && bill.originalUnitVnd !== undefined ? { originalPriceText: formatCents(price(bill.originalUnitVnd)) } : {}),
      ...(paidSegmentPrices ? { paidSegmentPrices } : {}),
      ...(line.paidSegments && segments ? { paidSegments: segments.map((segment) => `${segment.quantity} × ${formatCents(price(segment.unitVnd))}`) } : {}),
      lineTotalText: formatCents(total),
    });
  });

  // The subtotal is only a figure when the cart could work one out.
  const priced = model.subtotalText !== "Chưa thể tính";
  const next: { -readonly [K in keyof CartViewModel]?: CartViewModel[K] } = { lines };
  if (priced) {
    next.subtotalText = formatCents(payable);
    if (model.summary) next.summary = usdOrderSummary(model.summary, { valueCents: value, payableCents: payable });
    if (model.savings) {
      const saving = reference - payable;
      next.savings = saving > 0
        ? Object.freeze({ ...model.savings, originalTotalText: formatCents(reference), savingText: formatCents(saving) })
        : undefined;
    }
    if (model.listPriceSavingsText !== undefined) {
      const saving = listReference - payable;
      next.listPriceSavingsText = saving > 0 ? formatCents(saving) : undefined;
    }
  }
  if (model.shippingBaseFeeText !== undefined && model.shippingBaseFeeVnd !== undefined && model.shippingBaseFeeVnd > 0) {
    next.shippingBaseFeeText = formatCents(price(model.shippingBaseFeeVnd));
  }
  const result = { ...model, ...next } as T;
  if (next.savings === undefined && "savings" in next) delete (result as { savings?: unknown }).savings;
  if (next.listPriceSavingsText === undefined && "listPriceSavingsText" in next) delete (result as { listPriceSavingsText?: unknown }).listPriceSavingsText;
  const vouchers = (model as unknown as Partial<CartVouchers>).vouchers;
  if (priced && vouchers) {
    (result as unknown as { vouchers: VoucherPickerModel }).vouchers = Object.freeze({ ...vouchers, summary: usdVoucherSummary(vouchers.summary, payable) });
  }
  return Object.freeze(result);
}

/**
 * Checkout in dollars, by the same rules as the cart: each paid line is its quantity times the unit
 * price shown, the subtotal is their sum, and the total is that plus the displayed shipping. A quote
 * that is not ready, or a line with no unit price, is left as it is.
 */
export function usdCheckout<T extends CheckoutViewModel>(model: T): T {
  if (model.state !== "ready" || model.totals === null) return model;
  if (model.lines.some((line) => line.unitPriceVnd === undefined)) return model;

  let payable = 0;
  let value = 0;
  let listReference = 0;
  const lines = model.lines.map((line) => {
    const unit = price(line.unitPriceVnd!);
    const total = line.quantity * unit;
    payable += total;
    value += line.quantity * price(line.listedUnitVnd ?? line.unitPriceVnd!);
    listReference += line.quantity * price(line.listReferenceUnitVnd ?? line.listedUnitVnd ?? line.unitPriceVnd!);
    return Object.freeze({
      ...line,
      unitPriceText: formatCents(unit),
      lineTotalText: formatCents(total),
      ...(line.originalPriceText !== undefined && line.originalPriceVnd !== undefined ? { originalPriceText: formatCents(price(line.originalPriceVnd)) } : {}),
      ...(line.promotionPriceText !== undefined && line.promotionPriceVnd !== undefined ? { promotionPriceText: formatCents(price(line.promotionPriceVnd)) } : {}),
    });
  });

  const shipping = shippingCents(model.totals.shippingFeeVnd, model.totals.shippingWaivedVnd);
  const totals = Object.freeze({
    ...model.totals,
    subtotalText: formatCents(payable),
    shippingText: shipping.net === 0 ? FREE : formatCents(shipping.net),
    totalText: formatCents(payable + shipping.net),
  });
  const next = {
    ...model,
    lines: Object.freeze(lines),
    totals,
    ...(model.summary ? { summary: usdOrderSummary(model.summary, { valueCents: value, payableCents: payable }) } : {}),
  } as { -readonly [K in keyof CheckoutViewModel]: CheckoutViewModel[K] };
  if (model.listPriceSavingsText !== undefined) {
    const saving = listReference - payable;
    if (saving > 0) next.listPriceSavingsText = formatCents(saving);
    else delete next.listPriceSavingsText;
  }
  return Object.freeze(next) as T;
}
