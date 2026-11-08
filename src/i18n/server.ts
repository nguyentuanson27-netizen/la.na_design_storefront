import type { ReactNode } from "react";
import { headers } from "next/headers";

import { EN_MESSAGES } from "./catalog/en.ts";
import { DEFAULT_LOCALE, LOCALE_REQUEST_HEADER, localizeHref, parseLocale, type Locale } from "./locale.ts";
import { renderRich } from "./rich.tsx";
import { createTranslator, type Messages, type Translator } from "./translate.ts";

/**
 * The locale of the request being rendered, from the header the proxy sets (and always overwrites,
 * so a browser cannot choose it). Outside a request -- a build step, a script -- it is Vietnamese.
 */
export async function getLocale(): Promise<Locale> {
  try {
    return parseLocale((await headers()).get(LOCALE_REQUEST_HEADER)) ?? DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export function messagesFor(locale: Locale): Messages {
  return locale === "en" ? EN_MESSAGES : {};
}

export type RequestI18n = Readonly<{
  locale: Locale;
  t: Translator;
  /** An in-site href under this request's locale prefix. */
  href: (path: string) => string;
  /**
   * Translated text with inline markup (`<strong>`, `<em>`, `<br/>`) and `{slot}`s filled with React
   * nodes. For prose where a word is bold or a name is a link.
   */
  rich: (source: string, values?: Readonly<Record<string, ReactNode>>) => ReactNode;
}>;

/** Everything a server component or loader needs to speak the request's language. */
export async function getI18n(): Promise<RequestI18n> {
  const locale = await getLocale();
  const t = createTranslator(locale, messagesFor(locale));
  return {
    locale,
    t,
    href: (path) => localizeHref(path, locale),
    rich: (source, values) => renderRich(t(source), values),
  };
}

export async function getT(): Promise<Translator> {
  return (await getI18n()).t;
}
