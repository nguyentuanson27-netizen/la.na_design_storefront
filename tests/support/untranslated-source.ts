import { readFileSync } from "node:fs";

/**
 * A storefront source file as it read before its copy went through `t()`.
 *
 * Several contract tests pin markup by regex over the source -- an `aria-label`, a heading, the
 * order of two controls -- and were written when the Vietnamese sat directly in the JSX. Wrapping
 * that copy for English moved it into `t("…")`; the contract being pinned is unchanged. Rather than
 * rewrite each regex around the wrapper, this puts the literal back: `aria-label={t("Menu")}`
 * reads as `aria-label="Menu"` and `{t("Bộ lọc")}` as `Bộ lọc`. Only a call whose first argument is
 * a plain string literal is unwrapped; one with values (`t("Xem {n}", { n })`) is left as written,
 * which a test that cares about it matches directly.
 */
export function unwrapTranslations(source: string): string {
  return source
    .replace(/=\{t\("((?:[^"\\]|\\.)*)"\)\}/g, '="$1"')
    .replace(/\{t\("((?:[^"\\]|\\.)*)"\)\}/g, "$1");
}

export function readUntranslated(path: string, options: "utf8" = "utf8"): string {
  return unwrapTranslations(readFileSync(path, options));
}
