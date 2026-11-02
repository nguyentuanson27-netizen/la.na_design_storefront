/**
 * The SKU normalization contract, shared by JavaScript and PostgreSQL (`src/commerce/sku-sql.ts`
 * builds the identical expression), so a SKU is the same SKU wherever it is compared:
 *
 *   1. the characters in `SKU_TRIM_CHARACTERS` are removed from both ends — exactly the set that
 *      `String.prototype.trim()` removes, spelled out because PostgreSQL's `btrim` removes only the
 *      space unless it is given the list;
 *   2. ASCII letters are upper-cased. Nothing else is case-folded: JavaScript's and PostgreSQL's
 *      `upper()` disagree on non-ASCII letters (and PostgreSQL's depends on the database locale), so
 *      folding them could make the two sides compare differently.
 *
 * Inner characters are significant. A SKU that normalizes to nothing is `null`.
 */
export const SKU_TRIM_CHARACTERS =
  "\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003" +
  "\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF";

export const SKU_ASCII_LOWER = "abcdefghijklmnopqrstuvwxyz";
export const SKU_ASCII_UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const TRIM_ENDS = new RegExp(`^[${SKU_TRIM_CHARACTERS}]+|[${SKU_TRIM_CHARACTERS}]+$`, "g");

export function normalizeSku(sku: string | null | undefined): string | null {
  if (!sku) return null;
  const normalized = sku
    .replace(TRIM_ENDS, "")
    .replace(/[a-z]/g, (letter) => letter.toUpperCase());
  return normalized.length > 0 ? normalized : null;
}
