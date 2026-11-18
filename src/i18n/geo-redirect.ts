/**
 * Sends a first-time visitor from outside Vietnam from the Vietnamese home page to the English one.
 *
 * Narrow on purpose (ADR 0025). A URL still means one language, so nothing but the bare home page
 * is ever redirected, and only when every one of these holds:
 *
 * - an ordinary browser is loading the document (`GET`, not a prefetch, not a crawler or link
 *   preview: Googlebot and the Meta/TikTok ad reviewers fetch from the US and must see the
 *   Vietnamese page, and an empty User-Agent is treated as a bot);
 * - the request has not carried a language already (`/en`, or a rewrite onto it);
 * - the visitor has not been through this decision before (cookie `la_geo_redirected`). The cookie is
 *   written when the redirect happens, so a visitor who then switches back to Vietnamese with the
 *   language switcher stays on Vietnamese instead of bouncing, and a returning visitor is not
 *   redirected again;
 * - the visitor did not arrive from a page of this site (a click on the switcher or the logo is a
 *   choice, and works even when cookies are refused);
 * - the country is known and is not Vietnam. Unknown (IPv6, private range, no trusted IP header)
 *   leaves the Vietnamese site as it is.
 *
 * Pure: the caller supplies the country, so the rule is testable without the IP table.
 */

import { DEFAULT_LOCALE, localizeHref, type Locale } from "./locale.ts";

export const GEO_REDIRECT_COOKIE = "la_geo_redirected";
const GEO_REDIRECT_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const HOME_COUNTRY = "VN";
const TARGET_LOCALE: Locale = "en";

const NON_BROWSER_AGENT =
  /bot|crawl|spider|slurp|facebookexternalhit|facebot|meta-external|preview|lighthouse|headless|pagespeed|gtmetrix|zalo(?:bot|url)|curl\/|wget\/|python-requests|go-http-client|okhttp|axios\/|node-fetch|undici/i;

type HeaderReader = Readonly<{ get(name: string): string | null }>;

export type GeoRedirectPlan = Readonly<{
  /** Site-relative target, query kept: `/en` or `/en?utm_source=...`. */
  location: string;
  /** A complete `Set-Cookie` value. */
  setCookie: string;
}>;

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
  /** The route path with any language prefix removed. Only `/` is eligible. */
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
  if (input.routePath !== "/" || input.locale !== DEFAULT_LOCALE) return null;
  if (input.cookie !== undefined) return null;
  if (input.country === null || input.country.toUpperCase() === HOME_COUNTRY) return null;
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
    location: `${localizeHref("/", TARGET_LOCALE)}${input.search}`,
    setCookie: cookie.join("; "),
  };
}
