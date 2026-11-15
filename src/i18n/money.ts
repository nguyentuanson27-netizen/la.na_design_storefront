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
 * `K`, `TR` and `triệu` are also ordinary letters ("Video 4K", "Size 2K"), so those three are
 * converted only where the text says it is money: the whole string is the figure (the ticket's
 * colour block), or a word that introduces an amount comes right before it ("Giảm 200K",
 * "Đơn từ 1,5 triệu", "tối đa 200K"). `đ` and `₫` need no such care: a digit run followed by one
 * of them, and not by a letter, is an amount.
 *
 * A bare number, a percentage, a quantity or a word that merely starts with `đ` is not an amount.
 * Text that must stay in dong (a price-range input, the amount an order is charged) writes `VND`.
 */
const VND_AMOUNT = /(\d{1,3}(?:\.\d{3})+|\d+)[\s  ]?[₫đ](?![\p{L}\d])/gu;
const COMPACT_FIGURE = String.raw`(\d+(?:,\d+)?)[\s\u00a0\u202f]?(K|TR|triệu)`;
/** The whole text is one compact amount: a voucher ticket's colour block ("80K", "1,5TR"). */
const COMPACT_ALONE = new RegExp(String.raw`^\s*${COMPACT_FIGURE}\s*$`, "iu");
/** Words that introduce an amount: "Giảm 200K", "Đơn từ 1,5 triệu", "tối đa 200K". */
const AMOUNT_WORDS = String.raw`(?:giảm|từ|tối đa|thêm|thiếu|trị giá|đạt|dưới|trên|hơn)`;
const COMPACT_AFTER_WORD = new RegExp(
  String.raw`(?<![\p{L}\d])(${AMOUNT_WORDS}[\s\u00a0\u202f]+)${COMPACT_FIGURE}(?![\p{L}\d])`,
  "giu",
);

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: ENGLISH_DISPLAY_CURRENCY.code,
});

export function formatUsdFromVnd(vnd: number): string {
  return usd.format(vnd / ENGLISH_DISPLAY_CURRENCY.vndPerUsd);
}

const UNIT: Readonly<Record<string, number>> = { k: 1_000, tr: 1_000_000, "triệu": 1_000_000 };

function compactToUsd(figure: string, unit: string): string {
  return formatUsdFromVnd(Number(figure.replace(",", ".")) * UNIT[unit.toLowerCase()]!);
}

export function vndTextToUsd(text: string): string {
  if (!/[₫đKkRr]|triệu/i.test(text)) return text;
  const alone = COMPACT_ALONE.exec(text);
  if (alone !== null) return compactToUsd(alone[1]!, alone[2]!);
  return text
    .replace(VND_AMOUNT, (_match, digits: string) => formatUsdFromVnd(Number(digits.replaceAll(".", ""))))
    .replace(COMPACT_AFTER_WORD, (_match, word: string, figure: string, unit: string) => `${word}${compactToUsd(figure, unit)}`);
}
