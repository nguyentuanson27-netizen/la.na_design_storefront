import { DEFAULT_LOCALE, type Locale } from "./locale.ts";

/**
 * A gettext-style translator keyed by the Vietnamese source text.
 *
 * The storefront was written in Vietnamese, with the copy spread over several hundred files. Rather
 * than renaming every string to a key, the Vietnamese sentence *is* the key: `t("Giỏ hàng")` returns
 * "Giỏ hàng" for Vietnamese and "Cart" for English. Three properties follow:
 *
 * - Vietnamese output is the source text itself, so nothing that renders or tests Vietnamese changes.
 * - A string with no English entry falls back to Vietnamese. The page degrades; it never breaks.
 * - Coverage is auditable: `scripts/i18n-audit.ts` lists every `t("...")` source with no entry.
 *
 * Values are interpolated with `{name}` placeholders, in the source and in the translation alike.
 * Numbers and money are formatted by the caller, in the locale's own convention.
 */

export type Messages = Readonly<Record<string, string>>;
export type TranslateValues = Readonly<Record<string, string | number>>;
export type Translator = (source: string, values?: TranslateValues) => string;

const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

export function interpolate(template: string, values?: TranslateValues): string {
  if (values === undefined) return template;
  return template.replace(PLACEHOLDER, (match, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : match,
  );
}

type CompiledTemplate = Readonly<{ pattern: RegExp; names: readonly string[]; target: string; weight: number }>;

const compiledByCatalog = new WeakMap<Messages, readonly CompiledTemplate[]>();

/**
 * A catalog key that contains `{name}` is also a template for text that has already been filled
 * in. The view models build their sentences (`Còn 3`, `Từ 1.200.000₫`) before the page sees them,
 * and the page cannot hand `t` the values separately; so when an exact entry is missing, the keys
 * with placeholders are tried as patterns and the captured values go into the English template.
 * That is what lets a model keep returning Vietnamese -- its tests unchanged -- while the page
 * translates what it renders.
 */
function compileTemplates(messages: Messages): readonly CompiledTemplate[] {
  const cached = compiledByCatalog.get(messages);
  if (cached !== undefined) return cached;

  const compiled: CompiledTemplate[] = [];
  for (const [source, target] of Object.entries(messages)) {
    if (!source.includes("{")) continue;
    const names: string[] = [];
    let literal = 0;
    let pattern = "";
    let cursor = 0;
    for (const match of source.matchAll(PLACEHOLDER)) {
      const before = source.slice(cursor, match.index);
      literal += before.length;
      pattern += escapeRegExp(before) + "(.+?)";
      names.push(match[1]!);
      cursor = match.index! + match[0].length;
    }
    const rest = source.slice(cursor);
    literal += rest.length;
    pattern += escapeRegExp(rest);
    // A template made only of placeholders would match everything.
    if (literal === 0) continue;
    compiled.push({ pattern: new RegExp(`^${pattern}$`, "s"), names, target, weight: literal });
  }
  // Most specific first: the template with the most fixed text wins.
  compiled.sort((a, b) => b.weight - a.weight);
  compiledByCatalog.set(messages, compiled);
  return compiled;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lookup(messages: Messages, source: string): string | undefined {
  if (Object.hasOwn(messages, source)) return messages[source];
  for (const template of compileTemplates(messages)) {
    const match = template.pattern.exec(source);
    if (match === null) continue;
    const captured: Record<string, string> = {};
    template.names.forEach((name, index) => {
      captured[name] = match[index + 1]!;
    });
    return interpolate(template.target, captured);
  }
  return undefined;
}

export function createTranslator(locale: Locale, messages: Messages): Translator {
  if (locale === DEFAULT_LOCALE) {
    return (source, values) => interpolate(source, values);
  }
  const memo = new Map<string, string | undefined>();
  return (source, values) => {
    let found = memo.get(source);
    if (found === undefined && !memo.has(source)) {
      found = lookup(messages, source);
      memo.set(source, found);
    }
    // A hit from a pattern is already filled in; an exact hit still has its own `{name}`s to fill.
    return interpolate(found ?? source, values);
  };
}

/** Picks the text for `locale` from an inline pair; the Vietnamese side is the fallback. */
export function pick<T>(locale: Locale, text: Readonly<{ vi: T; en?: T }>): T {
  return locale === "en" && text.en !== undefined ? text.en : text.vi;
}
