import type { ReactNode } from "react";
import { headers } from "next/headers";

import { localizeCampaignName, type CampaignNameMap } from "../commerce/campaign-name-translation.ts";
import { readPublicCampaignNames } from "../commerce/campaign-name-translation-runtime.ts";
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

/**
 * The English campaign names the browser may be given on this request: the public ones. Vietnamese
 * has nothing to translate and reads nothing.
 */
export async function requestCampaignNames(locale: Locale): Promise<CampaignNameMap> {
  return locale === "en" ? await readPublicCampaignNames() : {};
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
  /**
   * A campaign's name in the request's language: the English an admin entered, or the name as
   * written. Its own lookup, never the interface's `t`: a campaign called "Ưu đãi" must not change
   * the page's own "Ưu đãi".
   */
  campaignName: (name: string) => string;
}>;

/** Everything a server component or loader needs to speak the request's language. */
/** The admin's English for a campaign name when there is one; otherwise the catalog's reading of the name as written. */
function localizedOr(names: CampaignNameMap, name: string, t: Translator): string {
  const found = localizeCampaignName(names, name);
  return found !== name ? found : t(name);
}

export async function getI18n(): Promise<RequestI18n> {
  const locale = await getLocale();
  const t = createTranslator(locale, messagesFor(locale));
  const names = await requestCampaignNames(locale);
  return {
    locale,
    t,
    href: (path) => localizeHref(path, locale),
    rich: (source, values) => renderRich(t(source), richValues(t, values)),
    campaignName: (name) => localizedOr(names, name, t),
  };
}

export async function getT(): Promise<Translator> {
  return (await getI18n()).t;
}
