import { computeListPriceVnd } from "../commerce/list-price.ts";
import { readListPriceConfig } from "../commerce/list-price-config.ts";
import type { StorefrontCartLine } from "../commerce/storefront-cart.ts";
const currency = new Intl.NumberFormat("vi-VN", {
  style: "currency",
  currency: "VND",
  maximumFractionDigits: 0,
});
/** Goods only; gifts never enter the paid cart lines. Does not mutate checkout totals. */
export function describeListPriceSavings(
  lines: readonly StorefrontCartLine[],
  payableVnd: number | null,
): string | null {
  if (
    !readListPriceConfig().display ||
    payableVnd === null ||
    !Number.isSafeInteger(payableVnd) ||
    payableVnd < 0
  )
    return null;
  let reference = 0;
  for (const line of lines) {
    if (!line.available || line.price === null) return null;
    reference +=
      (computeListPriceVnd(line.basePrice ?? line.price) ??
        line.basePrice ??
        line.price) * line.quantity;
  }
  const saving = reference - payableVnd;
  return Number.isSafeInteger(reference) &&
    Number.isSafeInteger(saving) &&
    saving > 0
    ? currency.format(saving)
    : null;
}
