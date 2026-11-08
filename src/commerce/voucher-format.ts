/**
 * Voucher v1 (UI refresh): short money wording shared by the picker's colour block and the PDP teaser chips. Pure.
 */

const trim = (value: number, digits: number): string => String(Number(value.toFixed(digits))).replace(".", ",");

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
