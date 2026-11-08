import type { Metadata } from "next";

import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_LANGUAGE_TAG,
  LOCALE_OPEN_GRAPH,
  localizeHref,
  type Locale,
} from "./locale.ts";
import type { Translator } from "./translate.ts";

/**
 * Metadata for the language the page is served in, applied once on the way out of a route's
 * metadata builder so no builder has to know a second spelling of its own URL.
 *
 * A page that declares a canonical is a page search engines may index, so it is also a page that has
 * a twin: the canonical is moved to this language's URL, and `hreflang` points at every language's
 * (Vietnamese being `x-default`). A page that declares none -- noindex, filtered, private -- gets
 * neither, and is never advertised as an alternate of anything.
 *
 * Titles and descriptions go through the translator: a fixed page's copy is in the catalog and is
 * replaced, and anything that is not (a product title from the catalogue) is left as written.
 */

function translateTitle(title: Metadata["title"], t: Translator): Metadata["title"] {
  if (typeof title === "string") return t(title);
  if (title === null || title === undefined) return title;
  if ("absolute" in title && typeof title.absolute === "string") return { ...title, absolute: t(title.absolute) };
  if ("default" in title && typeof title.default === "string") {
    return { ...title, default: t(title.default), ...(title.template ? { template: t(title.template) } : {}) };
  }
  return title;
}

function languageUrl(canonical: string, locale: Locale): string {
  const url = new URL(canonical);
  const route = url.pathname === "/" ? "/" : url.pathname;
  url.pathname = localizeHref(route, locale);
  return url.pathname === "/" && url.search === "" ? url.origin : url.toString();
}

export function localizeMetadata(metadata: Metadata, locale: Locale, t: Translator): Metadata {
  if (locale === DEFAULT_LOCALE && !hasCanonical(metadata)) return metadata;

  const next: Metadata = { ...metadata };

  if (locale !== DEFAULT_LOCALE) {
    if (next.title !== undefined) next.title = translateTitle(next.title, t);
    if (typeof next.description === "string") next.description = t(next.description);
  }

  const canonical = canonicalOf(metadata);
  if (canonical !== null) {
    const languages: Record<string, string> = {};
    for (const candidate of LOCALES) languages[LOCALE_LANGUAGE_TAG[candidate]] = languageUrl(canonical, candidate);
    languages["x-default"] = languageUrl(canonical, DEFAULT_LOCALE);
    next.alternates = { ...metadata.alternates, canonical: languageUrl(canonical, locale), languages };
  }

  if (next.openGraph) {
    const openGraph = { ...next.openGraph, locale: LOCALE_OPEN_GRAPH[locale] } as NonNullable<Metadata["openGraph"]>;
    if (locale !== DEFAULT_LOCALE) {
      if (typeof openGraph.title === "string") openGraph.title = t(openGraph.title);
      if (typeof openGraph.description === "string") openGraph.description = t(openGraph.description);
    }
    if (canonical !== null && openGraph.url !== undefined) openGraph.url = languageUrl(canonical, locale);
    next.openGraph = openGraph;
  }

  if (locale !== DEFAULT_LOCALE && next.twitter) {
    const twitter = { ...next.twitter } as NonNullable<Metadata["twitter"]>;
    if (typeof twitter.title === "string") twitter.title = t(twitter.title);
    if (typeof twitter.description === "string") twitter.description = t(twitter.description);
    next.twitter = twitter;
  }

  return next;
}

function canonicalOf(metadata: Metadata): string | null {
  const canonical = metadata.alternates?.canonical;
  if (typeof canonical === "string") return canonical;
  if (canonical instanceof URL) return canonical.toString();
  return null;
}

function hasCanonical(metadata: Metadata): boolean {
  return canonicalOf(metadata) !== null;
}
