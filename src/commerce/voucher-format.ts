/**
 * Voucher v1 (UI refresh): short money wording shared by the picker's colour block and the PDP teaser chips. Pure.
 */

const trim = (value: number, digits: number): string => String(Number(value.toFixed(digits))).replace(".", ",");

/** One colour per voucher type: merchandise types take the next tone in application order, free shipping is always teal. */
export type VoucherTone = "clay" | "plum" | "moss" | "navy" | "teal";
const MERCHANDISE_TONES: readonly VoucherTone[] = ["clay", "plum", "moss", "navy"];
/** The tone of the merchandise type at `index` in application order (by priority, then slot key); more types than colours wrap around. */
export const merchandiseToneAt = (index: number): VoucherTone => MERCHANDISE_TONES[index % MERCHANDISE_TONES.length]!;

/** "80K", "1,5TR": the figure that fits a ticket's colour block. Exact thousands only lose their zeros; anything else keeps one decimal. */
export function compactVoucherVnd(value: number): string {
  if (value >= 1_000_000) return `${trim(value / 1_000_000, 2)}TR`;
  if (value >= 1_000) return `${trim(value / 1_000, 1)}K`;
  return `${value}đ`;
}

/** "500K", "1 triệu", "1,5 triệu": a threshold read in a sentence ("Đơn từ 1,5 triệu"). */
export function spokenVoucherVnd(value: number): string {
  return value >= 1_000_000 ? `${trim(value / 1_000_000, 2)} triệu` : compactVoucherVnd(value);
}
