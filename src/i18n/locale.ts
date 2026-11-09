/**
 * Locales and the URL shape that carries them.
 *
 * Vietnamese is the site's own language and keeps the URLs it has always had (`/shop/ao-dai-...`).
 * English lives under a `/en` prefix (`/en/shop/ao-dai-...`). The prefix exists only in the browser's
 * URL: the proxy strips it, rewrites to the one route tree under `src/app`, and tells the render
 * which locale it was by a request header. No route is duplicated.
 *
 * This file is pure -- no `next/*`, no DOM -- so the proxy, the server render, the browser and
 * `tests/domain` share one definition.
 */

export const LOCALES = ["vi", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "vi";

/** The order the switcher lists them in: the site's own language first. */
export const LANGUAGE_SWITCHER_ORDER: readonly Locale[] = ["vi", "en"];

/** The proxy's verdict for this request. Always overwritten there, so a browser cannot choose it. */
export const LOCALE_REQUEST_HEADER = "x-la-locale";

/** Locales that live under a URL prefix (everything but the default). */
const PREFIXED_LOCALES = LOCALES.filter((locale) => locale !== DEFAULT_LOCALE);

/** BCP 47 tags for `<html lang>`, `hreflang` and `og:locale`. */
export const LOCALE_LANGUAGE_TAG: Readonly<Record<Locale, string>> = {
  vi: "vi",
  en: "en",
};
export const LOCALE_OPEN_GRAPH: Readonly<Record<Locale, string>> = {
  vi: "vi_VN",
  en: "en_US",
};
/** The name a locale gives itself, shown in the switcher. */
export const LOCALE_NATIVE_NAME: Readonly<Record<Locale, string>> = {
  vi: "Tiếng Việt",
  en: "English",
};

export function parseLocale(value: unknown): Locale | null {
  if (typeof value !== "string") return null;
  return (LOCALES as readonly string[]).includes(value) ? (value as Locale) : null;
}

/**
 * Splits a pathname into the locale its prefix names and the route path underneath.
 * `/en` -> en, `/`; `/en/shop` -> en, `/shop`; `/shop` -> vi, `/shop`. `/english` is not a prefix.
 */
export function splitLocalePath(pathname: string): Readonly<{ locale: Locale; pathname: string }> {
  for (const locale of PREFIXED_LOCALES) {
    const prefix = `/${locale}`;
    if (pathname === prefix) return { locale, pathname: "/" };
    if (pathname.startsWith(`${prefix}/`)) return { locale, pathname: pathname.slice(prefix.length) };
  }
  return { locale: DEFAULT_LOCALE, pathname };
}

/**
 * Paths that are not pages and never carry a locale prefix: route handlers, framework assets,
 * feeds and files. The proxy matcher already skips most of them; links to them must not be
 * prefixed either, or an `/en/api/...` call would 404.
 */
const UNPREFIXED_ROOTS = ["/api", "/_next", "/feeds", "/voucher-link", "/admin"] as const;
const FILE_EXTENSION = /\.[A-Za-z0-9]{2,5}$/;

function isUnprefixedPath(pathname: string): boolean {
  if (UNPREFIXED_ROOTS.some((root) => pathname === root || pathname.startsWith(`${root}/`))) return true;
  return FILE_EXTENSION.test(pathname.split("/").pop() ?? "");
}

/**
 * Puts `href` under `locale`'s prefix when it is an in-site page link. Absolute URLs, protocol-
 * relative ones, `mailto:`/`tel:`, bare fragments and non-page paths come back untouched. Query
 * and fragment are kept. Already-prefixed input is returned as is, so applying it twice is safe.
 */
export function localizeHref(href: string, locale: Locale): string {
  if (locale === DEFAULT_LOCALE) return href;
  if (!href.startsWith("/") || href.startsWith("//")) return href;

  const cut = href.search(/[?#]/);
  const pathname = cut === -1 ? href : href.slice(0, cut);
  const tail = cut === -1 ? "" : href.slice(cut);

  if (splitLocalePath(pathname).locale !== DEFAULT_LOCALE) return href;
  if (isUnprefixedPath(pathname)) return href;
  return `/${locale}${pathname === "/" ? "" : pathname}${tail}`;
}

/** The same page in another locale, from a pathname that may already carry a prefix. */
export function switchLocalePath(pathname: string, target: Locale): string {
  return localizeHref(splitLocalePath(pathname).pathname, target);
}
