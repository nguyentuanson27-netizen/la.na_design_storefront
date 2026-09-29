/**
 * What checkout accepts as a Vietnamese phone number, in one place for the browser form and the
 * server action — the form warns with exactly the rule the server enforces.
 *
 * Accepted, after stripping spaces, dots, dashes and brackets:
 *
 * - a mobile number: `0` + one of the mobile prefixes below + 8 digits (10 digits in all);
 * - a landline: `02` + 9 digits (11 digits in all);
 * - either of those written internationally, `+84` / `84` in place of the leading `0`.
 *
 * The configuration is the two lists below. A carrier that opens a new first digit is a one-line
 * change to `MOBILE_SECOND_DIGITS`; landlines can be turned off by emptying `LANDLINE_PREFIXES`.
 */

/** Second digit of a 10-digit mobile number (03x Viettel, 05x Vietnamobile, 07x MobiFone, 08x, 09x). */
export const MOBILE_SECOND_DIGITS: readonly string[] = ["3", "5", "7", "8", "9"];

/** Leading digits of an 11-digit landline (02x area codes). */
export const LANDLINE_PREFIXES: readonly string[] = ["02"];

export const VIETNAM_PHONE_ERROR =
  "Số điện thoại chưa đúng. Vui lòng nhập số Việt Nam gồm 10 chữ số, ví dụ 0912 345 678.";

const SEPARATORS = /[\s.\-()]/g;

/**
 * The number in national form (`0912345678`), or `null` when it is not a Vietnamese phone number.
 * The normalised form is what the order stores and what Pancake receives, so staff always see one
 * shape regardless of how the buyer typed it.
 */
export function normalizeVietnamPhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let compact = value.trim().replace(SEPARATORS, "");
  if (compact.startsWith("+84")) {
    compact = `0${compact.slice(3)}`;
  } else if (compact.startsWith("84") && (compact.length === 11 || compact.length === 12)) {
    compact = `0${compact.slice(2)}`;
  }
  if (!/^0\d+$/.test(compact)) return null;

  if (compact.length === 10 && MOBILE_SECOND_DIGITS.includes(compact[1]!)) {
    return compact;
  }
  if (
    compact.length === 11 &&
    LANDLINE_PREFIXES.some((prefix) => compact.startsWith(prefix))
  ) {
    return compact;
  }
  return null;
}

export function isVietnamPhone(value: unknown): boolean {
  return normalizeVietnamPhone(value) !== null;
}
