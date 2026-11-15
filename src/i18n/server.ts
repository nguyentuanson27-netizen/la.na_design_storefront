import type { ReactNode } from "react";
import { headers } from "next/headers";

import { readCampaignNameMessages } from "../commerce/campaign-name-translation-runtime.ts";
import { EN_CLIENT_MESSAGES, EN_MESSAGES } from "./catalog/en.ts";
import { DEFAULT_LOCALE, LOCALE_REQUEST_HEADER, localizeHref, parseLocale, type Locale } from "./locale.ts";
import { renderRich } from "./rich.tsx";
import { richValues } from "./rich-values.ts";
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

/** The part of the catalog a client component may need; this is what goes to the browser. */
export function clientMessagesFor(locale: Locale): Messages {
  return locale === "en" ? EN_CLIENT_MESSAGES : {};
}

/** One merged object per (catalog, names) pair, so the translator compiles its patterns once. */
const mergedCache = new WeakMap<Messages, WeakMap<Messages, Messages>>();

function withCampaignNames(base: Messages, names: Messages): Messages {
  if (Object.keys(names).length === 0) return base;
  const byNames = mergedCache.get(base) ?? new WeakMap<Messages, Messages>();
  mergedCache.set(base, byNames);
  const found = byNames.get(names);
  if (found !== undefined) return found;
  // An admin's English for a name is deliberate, so it wins over a catalog entry of the same text.
  const merged = Object.freeze({ ...base, ...names });
  byNames.set(names, merged);
  return merged;
}

/**
 * What the request's translator knows: the catalog, plus the English campaign names an admin
 * entered. Vietnamese needs neither, and reads nothing.
 */
export async function requestMessagesFor(locale: Locale): Promise<Messages> {
  if (locale !== "en") return {};
  return withCampaignNames(EN_MESSAGES, await readCampaignNameMessages());
}

/** The same for the browser: the short catalog plus the campaign names, which are short. */
export async function requestClientMessagesFor(locale: Locale): Promise<Messages> {
  if (locale !== "en") return {};
  return withCampaignNames(EN_CLIENT_MESSAGES, await readCampaignNameMessages());
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
  const t = createTranslator(locale, await requestMessagesFor(locale));
  return {
    locale,
    t,
    href: (path) => localizeHref(path, locale),
    rich: (source, values) => renderRich(t(source), richValues(t, values)),
  };
}

export async function getT(): Promise<Translator> {
  return (await getI18n()).t;
}
