/**
 * Identifier normalization shared by the Conversions API (server) and the pixel's manual advanced
 * matching (browser). Both sides must reduce the same shopper input to the same string before
 * hashing, or Meta sees two different people. Pure string functions only: this file is bundled for
 * the browser, so it must not reach for Node APIs.
 */

const VIETNAM_COUNTRY_CODE = "84";
// Vietnamese mobile subscriber numbers are nine digits once the trunk zero is removed.
const VIETNAM_SUBSCRIBER_DIGITS = 9;

/**
 * Meta requires identifiers lowercased and stripped of formatting before hashing; a value
 * normalized differently hashes differently and simply fails to match.
 */
export function normalizeMetaIdentifier(value: string): string {
  // fn/ln normalization in Meta's current capi-param-builder/stringUtil.js:
  // lowercase, remove whitespace and punctuation, retain Unicode letters/accents.
  return value.toLowerCase().replace(/[\s!-/:-@[-`{-~]/g, "");
}

/**
 * Meta wants digits only, including country code. Vietnamese numbers are usually written with a
 * national trunk "0" that has to become 84, and the +84 / 0084 / 84 forms have to collapse to the
 * same digits or the same subscriber hashes several different ways and matches none of them.
 *
 * The trunk zero is dropped after the country code as well: "+84 0912 345 678" is a common way to
 * write the number people also give as "0912345678", and both have to reach the same digits.
 */
export function normalizeVietnamesePhone(rawPhone: string): string | null {
  const digits = rawPhone.replace(/[^0-9]/g, "");
  if (digits.length === 0) return null;

  const withoutInternationalPrefix = digits.startsWith("00" + VIETNAM_COUNTRY_CODE)
    ? digits.slice(2)
    : digits;

  if (withoutInternationalPrefix.startsWith(VIETNAM_COUNTRY_CODE)) {
    const subscriber = withoutInternationalPrefix.slice(VIETNAM_COUNTRY_CODE.length);
    return VIETNAM_COUNTRY_CODE + (subscriber.startsWith("0") ? subscriber.slice(1) : subscriber);
  }
  if (withoutInternationalPrefix.startsWith("0")) {
    return VIETNAM_COUNTRY_CODE + withoutInternationalPrefix.slice(1);
  }
  // A bare subscriber number, written without the trunk zero. The checkout phone field is free
  // text, so this reaches us as readily as any other spelling and has to land on the same digits.
  if (withoutInternationalPrefix.length === VIETNAM_SUBSCRIBER_DIGITS) {
    return VIETNAM_COUNTRY_CODE + withoutInternationalPrefix;
  }
  return withoutInternationalPrefix;
}

/** The shape Meta accepts for `ph` once normalized: digits only, country code first. */
export function isMetaPhone(normalized: string): boolean {
  return /^[1-9][0-9]{7,14}$/.test(normalized);
}

/**
 * Vietnamese names run family name first and given name last, which is the opposite of the
 * fn/ln split Meta expects: the given name is `fn`, the family name is `ln`.
 */
export function splitVietnameseName(fullName: string): { fn: string; ln: string } | null {
  const parts = fullName.trim().split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  if (parts.length === 1) return { fn: parts[0]!, ln: parts[0]! };
  return { fn: parts[parts.length - 1]!, ln: parts[0]! };
}

/** A name token Meta can match on has at least one letter. */
export function hasMetaNameLetter(token: string): boolean {
  return /[\p{L}]/u.test(token);
}
