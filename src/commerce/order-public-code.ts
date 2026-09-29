import { randomInt } from "node:crypto";

/**
 * The order code a buyer is shown, reads back over the phone and types into order lookup.
 *
 * `LA-` plus eight characters from an alphabet with no look-alikes: no 0/O, 1/I/L, and no U. That is
 * 30^8 ≈ 6.6 × 10^11 codes, so a collision between two orders is negligible for any realistic volume
 * (and the unique index refuses one outright), while the code stays short enough to copy by hand.
 *
 * The code is not a secret on its own: guest lookup still requires the phone number the order was
 * placed with, and both lookup inputs are rate limited.
 */

const PREFIX = "LA-";
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const BODY_LENGTH = 8;
const SHORT_CODE = new RegExp(`^${PREFIX}[${ALPHABET}]{${BODY_LENGTH}}$`);

export function generateOrderPublicCode(): string {
  let body = "";
  for (let index = 0; index < BODY_LENGTH; index += 1) {
    body += ALPHABET[randomInt(ALPHABET.length)];
  }
  return `${PREFIX}${body}`;
}

export function isShortOrderPublicCode(value: string): boolean {
  return SHORT_CODE.test(value);
}

/**
 * What a buyer typed, mapped to the stored code when it is recognisably a short code.
 *
 * Forgiving on exactly the things people get wrong when copying a code — letter case, spaces, the
 * dashes, and leaving off the `LA` prefix — so `la 7k3m 9qxd`, `7K3M-9QXD` and `LA-7K3M9QXD` all find
 * the same order. Anything that does not normalise to a short code (codes issued before this format)
 * is returned trimmed but otherwise untouched, because those older codes are case-sensitive.
 */
export function normalizeOrderPublicCodeInput(value: string): string {
  const trimmed = value.trim();
  let compact = trimmed.toUpperCase().replace(/[\s\-_.]/g, "");
  if (compact.length === BODY_LENGTH + 2 && compact.startsWith("LA")) {
    compact = compact.slice(2);
  }
  const candidate = `${PREFIX}${compact}`;
  return isShortOrderPublicCode(candidate) ? candidate : trimmed;
}

/**
 * A Vietnamese phone number reduced to its national digits, so `0901 234 567`, `090.123.4567` and
 * `+84 901 234 567` compare equal. The stored number is left exactly as the buyer entered it; this
 * is only for matching.
 */
export function normalizePhoneForMatch(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.startsWith("84") && digits.length >= 11) {
    return `0${digits.slice(2)}`;
  }
  return digits;
}
