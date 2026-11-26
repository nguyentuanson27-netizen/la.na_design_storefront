/**
 * First-visit geo-redirect between Vietnamese and English storefront pages (ADR 0025).
 *
 * A URL still means one language, so a redirect only happens on a first-time browser load from
 * outside the site, and sets `la_geo_redirected=1` so any subsequent switch sticks:
 *
 * - non-Vietnam IP opening the Vietnamese home page (`/`) -> `/en` (deep links in Vietnamese stay
 *   untouched);
 * - Vietnam IP opening any English page (`/en` or `/en/...`) -> matching Vietnamese path (`/` or
 *   `/...`);
 * - ordinary browser document `GET` only (not a prefetch, not a crawler or link preview such as
 *   Googlebot, Meta/TikTok ad reviewers, or WhatsApp/Viber/Facebook fetchers; empty User-Agent is
 *   treated as a bot);
 * - visitor has not been through this decision before (`la_geo_redirected` cookie absent);
 * - visitor did not arrive from a page of this site (a click on the switcher or logo is an
 *   explicit choice, even when cookies are refused);
 * - country is known (IPv6, private range, or missing trusted IP header leaves the page as it is).
 *
 * Pure: the caller supplies the country, so the rule is testable without the IP table.
 */

import { DEFAULT_LOCALE, localizeHref, type Locale } from "./locale.ts";

export const GEO_REDIRECT_COOKIE = "la_geo_redirected";
const GEO_REDIRECT_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const HOME_COUNTRY = "VN";
const ENGLISH_LOCALE: Locale = "en";

const NON_BROWSER_AGENT =
  /bot|crawl|spider|slurp|facebookexternalhit|facebot|meta-external|whatsapp|viber|pinterest|google-|preview|lighthouse|headless|pagespeed|gtmetrix|zalo(?:bot|url)|curl\/|wget\/|python-requests|go-http-client|okhttp|axios\/|node-fetch|undici/i;

type HeaderReader = Readonly<{ get(name: string): string | null }>;

export type GeoRedirectPlan = Readonly<{
  /** Site-relative target, query kept: `/en`, `/`, `/ao-dai?utm_source=...`. */
  location: string;
  /** A complete `Set-Cookie` value. */
  setCookie: string;
}>;

function redirectPathname(routePath: string, locale: Locale, country: string | null): string | null {
  if (country === null) return null;
  const upperCountry = country.toUpperCase();
  if (locale === DEFAULT_LOCALE && routePath === "/" && upperCountry !== HOME_COUNTRY) {
    return localizeHref("/", ENGLISH_LOCALE);
  }
  if (locale === ENGLISH_LOCALE && upperCountry === HOME_COUNTRY) {
    return localizeHref(routePath, DEFAULT_LOCALE);
  }
  return null;
}

function isBrowserDocumentLoad(method: string, headers: HeaderReader): boolean {
  if (method !== "GET") return false;
  const purpose = `${headers.get("sec-purpose") ?? ""} ${headers.get("purpose") ?? ""}`;
  if (purpose.includes("prefetch")) return false;
  const destination = headers.get("sec-fetch-dest");
  if (destination !== null && destination !== "document") return false;
  if (destination === null && !(headers.get("accept") ?? "").includes("text/html")) return false;
  const agent = headers.get("user-agent") ?? "";
  return agent.length > 0 && !NON_BROWSER_AGENT.test(agent);
}

/** True when the Referer names the same host as the request: the visitor is already browsing here. */
function cameFromThisSite(headers: HeaderReader, host: string | null): boolean {
  const referer = headers.get("referer");
  if (referer === null || host === null) return false;
  try {
    return new URL(referer).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

export function planGeoRedirect(input: Readonly<{
  method: string;
  /** The route path with any language prefix removed. */
  routePath: string;
  /** The language the request is rendered in (the URL's, or one a rewrite carried). */
  locale: Locale;
  search: string;
  headers: HeaderReader;
  /** The request's own `Host`, to recognise a click from inside the site. */
  host: string | null;
  cookie: string | undefined;
  /** ISO country of the client IP, or null when unknown. */
  country: string | null;
  secure: boolean;
}>): GeoRedirectPlan | null {
  const target = redirectPathname(input.routePath, input.locale, input.country);
  if (target === null) return null;
  if (input.cookie !== undefined) return null;
  if (!isBrowserDocumentLoad(input.method, input.headers)) return null;
  if (cameFromThisSite(input.headers, input.host)) return null;

  const cookie = [
    `${GEO_REDIRECT_COOKIE}=1`,
    "Path=/",
    `Max-Age=${GEO_REDIRECT_COOKIE_MAX_AGE_SECONDS}`,
    "SameSite=Lax",
    "HttpOnly",
  ];
  if (input.secure) cookie.push("Secure");
  return {
    location: `${target}${input.search}`,
    setCookie: cookie.join("; "),
  };
}
