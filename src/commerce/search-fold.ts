/**
 * Accent-insensitive storefront search.
 *
 * Shoppers on a phone often type Vietnamese without marks ("ao dai", "vay", "dam"). The catalog
 * stores names with marks, so a plain substring test finds nothing. Both sides are folded the same
 * way -- marks removed, `đ` to `d`, lower-cased -- the query in JavaScript and the stored text in
 * SQL with `translate()`, which is built into PostgreSQL (no extension, no migration).
 *
 * The SQL fold is driven by the same two strings the JavaScript fold is tested against, so the two
 * sides cannot drift.
 */

const FOLD_GROUPS: ReadonlyArray<readonly [string, string]> = [
  ["a", "àáạảãâầấậẩẫăằắặẳẵ"],
  ["e", "èéẹẻẽêềếệểễ"],
  ["i", "ìíịỉĩ"],
  ["o", "òóọỏõôồốộổỗơờớợởỡ"],
  ["u", "ùúụủũưừứựửữ"],
  ["y", "ỳýỵỷỹ"],
  ["d", "đ"],
];

function buildFoldTables(): Readonly<{ from: string; to: string }> {
  let from = "";
  let to = "";
  for (const [base, accented] of FOLD_GROUPS) {
    // Both cases, so the fold does not depend on how the database lower-cases non-ASCII text.
    for (const char of [...accented, ...accented.toUpperCase()]) {
      from += char;
      to += base;
    }
  }
  return { from, to };
}

/** `translate(text, FOLD_FROM, FOLD_TO)` removes Vietnamese marks; the lengths are equal by construction. */
export const { from: FOLD_FROM, to: FOLD_TO } = buildFoldTables();

/** Upper bound on distinct words a query is split into; the rest are ignored. */
export const MAX_SEARCH_TERMS = 6;

/** Lower-case, marks removed, `đ` as `d`. Accepts either composed or decomposed input. */
export function foldVietnamese(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/đ/g, "d")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/g, "d");
}

/**
 * The words a query must all contain. Folded, de-duplicated and bounded, so one long paste cannot
 * turn into an unbounded number of SQL conditions.
 */
export function searchTerms(query: string): string[] {
  const seen = new Set<string>();
  for (const word of foldVietnamese(query).split(/\s+/)) {
    if (word.length > 0) seen.add(word);
    if (seen.size >= MAX_SEARCH_TERMS) break;
  }
  return [...seen];
}

/** Escapes `%`, `_` and `\` so a term is matched literally by `LIKE ... ESCAPE '\'`. */
export function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}
