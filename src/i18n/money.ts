import { ENGLISH_DISPLAY_CURRENCY } from "../brand/currency.config.ts";

/**
 * Dong amounts, as the view models format them (`1.290.000 ₫`, `Từ 1.200.000₫`), shown as dollars.
 *
 * The view models build Vietnamese money text with `Intl.NumberFormat("vi-VN")` before the page
 * sees it, so the English translator converts the *text* rather than every formatter. Only an
 * amount written with the dong sign is touched; a bare number, a percentage or a quantity is not.
 * Text that must stay in dong (a price-range input, a bank-transfer amount) writes `VND` instead.
 */
const VND_AMOUNT = /(\d{1,3}(?:\.\d{3})+|\d+)[\s  ]?₫/g;

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: ENGLISH_DISPLAY_CURRENCY.code,
});

export function formatUsdFromVnd(vnd: number): string {
  return usd.format(vnd / ENGLISH_DISPLAY_CURRENCY.vndPerUsd);
}

export function vndTextToUsd(text: string): string {
  if (!text.includes("₫")) return text;
  return text.replace(VND_AMOUNT, (_match, digits: string) =>
    formatUsdFromVnd(Number(digits.replaceAll(".", ""))),
  );
}
