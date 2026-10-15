/**
 * How a per-product promotion (Flash Sale, clearance...) reads on the line it applies to.
 *
 * Pure and shared by the cart, the drawer and checkout so a struck-through price and its percentage
 * can never be worded differently on two surfaces. It only describes two numbers the server already
 * decided -- the catalog price and the price the line is actually charged -- and claims nothing when
 * they do not show a real reduction.
 */

const currency = new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 });

export type LineDiscountView = Readonly<{
  /** The catalog price, to be struck through. */
  originalPriceText: string;
  /** Whole percent off, or `null` when it rounds to under 1% (the strike-through alone is honest then). */
  percent: number | null;
}>;

export function describeLineDiscount(basePriceVnd: number | null | undefined, priceVnd: number | null | undefined): LineDiscountView | null {
  if (basePriceVnd === null || basePriceVnd === undefined || priceVnd === null || priceVnd === undefined) return null;
  if (!Number.isFinite(basePriceVnd) || !Number.isFinite(priceVnd) || priceVnd < 0 || basePriceVnd <= priceVnd) return null;
  const percent = Math.round((1 - priceVnd / basePriceVnd) * 100);
  return Object.freeze({ originalPriceText: currency.format(basePriceVnd), percent: percent >= 1 ? percent : null });
}
