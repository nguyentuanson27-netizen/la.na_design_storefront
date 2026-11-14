import { ENGLISH_DISPLAY_CURRENCY } from "../brand/currency.config.ts";

/**
 * Dong amounts, as the view models write them, shown as dollars.
 *
 * The view models build Vietnamese money text with `Intl.NumberFormat("vi-VN")` before the page
 * sees it, so the English translator converts the *text* rather than every formatter. Four
 * spellings are in use and all four are converted:
 *
 * - `1.290.000 ₫` / `1.200.000₫`: the storefront's `currency` formatters.
 * - `260.000đ`: the voucher formatters (`formatVoucherVnd`, `compactVoucherVnd`).
 * - `80K`, `12,5K`, `1,5TR`: the voucher card's colour block (`compactVoucherVnd`).
 * - `1,5 triệu`: a voucher threshold read in a sentence (`spokenVoucherVnd`).
 *
 * A bare number, a percentage, a quantity or a word that merely starts with `đ` is not an amount.
 * Text that must stay in dong (a price-range input, the amount an order is charged) writes `VND`.
 */
const VND_AMOUNT = /(\d{1,3}(?:\.\d{3})+|\d+)[\s  ]?[₫đ](?![\p{L}\d])/gu;
const COMPACT_AMOUNT = /(?<![\p{L}\d.,])(\d+(?:,\d+)?)[\s  ]?(K|TR|triệu)(?![\p{L}\d])/gu;

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: ENGLISH_DISPLAY_CURRENCY.code,
});

export function formatUsdFromVnd(vnd: number): string {
  return usd.format(vnd / ENGLISH_DISPLAY_CURRENCY.vndPerUsd);
}

const UNIT: Readonly<Record<string, number>> = { K: 1_000, TR: 1_000_000, "triệu": 1_000_000 };

export function vndTextToUsd(text: string): string {
  if (!/[₫đKR]|triệu/.test(text)) return text;
  return text
    .replace(VND_AMOUNT, (_match, digits: string) => formatUsdFromVnd(Number(digits.replaceAll(".", ""))))
    .replace(COMPACT_AMOUNT, (_match, figure: string, unit: string) =>
      formatUsdFromVnd(Number(figure.replace(",", ".")) * UNIT[unit]!),
    );
}
