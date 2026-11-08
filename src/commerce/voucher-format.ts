/**
 * Voucher v1 (UI refresh): short money wording shared by the picker's colour block and the PDP teaser chips. Pure.
 */

const trim = (value: number, digits: number): string => String(Number(value.toFixed(digits))).replace(".", ",");

/** One colour per voucher type: merchandise types take the next tone in application order, free shipping is always teal. */
export type VoucherTone = "clay" | "plum" | "moss" | "navy" | "teal";
const MERCHANDISE_TONES: readonly VoucherTone[] = ["clay", "plum", "moss", "navy"];
/** The tone of the merchandise type at `index` in application order (by priority, then slot key); more types than colours wrap around. */
export const merchandiseToneAt = (index: number): VoucherTone => MERCHANDISE_TONES[index % MERCHANDISE_TONES.length]!;

const fullVnd = new Intl.NumberFormat("vi-VN");

/**
 * "80K", "12,5K", "1,5TR": the figure that fits a ticket's colour block. It is only ever shortened EXACTLY: millions with up to two
 * decimals, thousands with up to one; any other amount is written out in full ("999.999đ"), never rounded to a figure the voucher
 * does not have (a threshold rounded down would promise a lower minimum than the real one).
 */
export function compactVoucherVnd(value: number): string {
  if (value >= 1_000_000 && value % 10_000 === 0) return `${trim(value / 1_000_000, 2)}TR`;
  if (value >= 1_000 && value % 100 === 0) return `${trim(value / 1_000, 1)}K`;
  return `${fullVnd.format(value)}đ`;
}

/** "500K", "1 triệu", "1,5 triệu": a threshold read in a sentence ("Đơn từ 1,5 triệu"), shortened only exactly (see above). */
export function spokenVoucherVnd(value: number): string {
  return value >= 1_000_000 && value % 10_000 === 0 ? `${trim(value / 1_000_000, 2)} triệu` : compactVoucherVnd(value);
}
