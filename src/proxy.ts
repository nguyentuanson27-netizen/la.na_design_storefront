import { type NextRequest, NextResponse } from "next/server";

import { resolveConfiguredStorefrontProductSlug } from "@/commerce/storefront-catalog-runtime";
import { readStorefrontOrigin } from "@/commerce/storefront-origin";
import { adAttributionCookieValue, serializeAdAttributionCookie } from "@/commerce/ad-attribution";
import {
  META_CLICK_ID_COOKIE,
  META_VISITOR_ID_COOKIE,
  isMetaCookieNavigation,
  metaFirstPartySetCookies,
  readMetaFirstPartyCookiesEnabled,
} from "@/integrations/meta/first-party-cookies";
import { VOUCHER_LINK_PATH, VOUCHER_REDIRECT_HEADERS, planVoucherLinkRedirect } from "@/commerce/voucher-marketing-link";
import {
  LISTING_VIEW_COOKIE,
  LISTING_VIEW_REQUEST_HEADER,
  planListingViewRequest,
} from "@/components/headless/listing-view-model";
import {
  DEFAULT_LOCALE,
  LOCALE_REQUEST_HEADER,
  localizeHref,
  splitLocalePath,
} from "@/i18n/locale";
import { readSearchExposure, shouldNoIndexRequest } from "@/seo/search-exposure";
import {
  readStrictScriptPolicyMode,
  strictScriptPolicyHeaders,
  type StrictScriptPolicyHeaders,
} from "@/security/script-nonce-policy";

const SHOP_PRODUCT_PREFIX = "/shop/";
const EXACT_PRODUCT_PATH = /^\/shop\/[^/]+$/;
const NO_INDEX_VALUE = "noindex, nofollow";
/** Deliberately unroutable: it exists to be answered by the app's not-found page, never matched. */
const UNRESOLVED_PRODUCT_PATH = "/__unresolved-product";

const META_PIXEL_CONFIGURED = (process.env.LA_BUILD_FACEBOOK_PIXEL_ID ?? "").length > 0;
/** The baseline policy next.config.mjs sends with every response, inlined at build. */
const BASE_CONTENT_SECURITY_POLICY = process.env.LA_BUILD_CONTENT_SECURITY_POLICY ?? "";

/**
 * A fresh script nonce for this page request (src/security/script-nonce-policy.ts). The request
 * half reaches rendering, where Next stamps the nonce on its own scripts and the site chrome on the
 * analytics snippets; the response half is the stricter policy the browser receives.
 */
function readStrictScriptPolicy(request: NextRequest): StrictScriptPolicyHeaders {
  const mode = BASE_CONTENT_SECURITY_POLICY.length > 0 ? readStrictScriptPolicyMode() : "off";
  return strictScriptPolicyHeaders(request.headers, BASE_CONTENT_SECURITY_POLICY, mode);
}

/**
 * Writes the first-party cookies Meta's events match on: the ad click's `fbclid` as `_fbc`, so a
 * later Purchase still carries it when the pixel never ran or its cookie expired, and this site's
 * visitor ID as `la_vid`, sent as `external_id`. Only a browser's load of a public storefront page
 * counts, only while `LA_META_FIRST_PARTY_COOKIES_ENABLED` is on, and with no pixel configured
 * nothing Meta-related is written at all. Storefront pages are `private, no-store`, so no shared
 * cache can hand one visitor's cookie to another.
 */
function applyMetaFirstPartyCookies(request: NextRequest, response: Response, routePath: string): void {
  if (!META_PIXEL_CONFIGURED) return;
  try {
    const cookies = metaFirstPartySetCookies({
      enabled: readMetaFirstPartyCookiesEnabled(),
      method: request.method,
      pathname: routePath,
      headers: request.headers,
      fbclid: request.nextUrl.searchParams.get("fbclid"),
      clickIdCookie: request.cookies.get(META_CLICK_ID_COOKIE)?.value,
      visitorIdCookie: request.cookies.get(META_VISITOR_ID_COOKIE)?.value,
      nowMs: Date.now(),
      storefrontOrigin: readStorefrontOrigin(),
    });
    for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
  } catch {
    // Measurement never costs a shopper the page.
  }
}

/**
 * Remembers the UTM parameters of an ad landing in `la_utm`, so checkout can put them in the order
 * note (src/commerce/ad-attribution.ts). Last touch wins; a page load without UTM leaves the cookie
 * alone. Same page loads as the Meta cookies, but independent of the pixel and its switch.
 */
function applyAdAttributionCookie(request: NextRequest, response: Response, routePath: string): void {
  try {
    if (!isMetaCookieNavigation({
      method: request.method,
      pathname: routePath,
      headers: request.headers,
    })) return;
    const value = adAttributionCookieValue(request.nextUrl.searchParams);
    if (value === null) return;
    response.headers.append("Set-Cookie", serializeAdAttributionCookie(value, readStorefrontOrigin()));
  } catch {
    // Attribution never costs a shopper the page.
  }
}

/**
 * The shopper's listing view (`?view=` over the `la_listing_view` cookie): the render reads the
 * verdict from a request header, and a view named in the URL is remembered in the cookie so every
 * other listing opens the same way. The header is overwritten whatever the browser sent.
 */
function planListingView(request: NextRequest, requestHeaders: Headers): string | null {
  try {
    const plan = planListingViewRequest({
      method: request.method,
      search: request.nextUrl.searchParams,
      cookie: request.cookies.get(LISTING_VIEW_COOKIE)?.value,
      secure: request.nextUrl.protocol === "https:",
    });
    requestHeaders.set(LISTING_VIEW_REQUEST_HEADER, plan.view);
    return plan.setCookie;
  } catch {
    requestHeaders.delete(LISTING_VIEW_REQUEST_HEADER);
    return null;
  }
}

function applyResponseHeaders(
  request: NextRequest,
  response: Response,
  routePath: string,
  scriptPolicy?: StrictScriptPolicyHeaders,
  listingViewCookie: string | null = null,
): Response {
  if (listingViewCookie !== null) response.headers.append("Set-Cookie", listingViewCookie);
  applyMetaFirstPartyCookies(request, response, routePath);
  applyAdAttributionCookie(request, response, routePath);
  if (scriptPolicy?.response) {
    // In the order given: see `StrictScriptPolicyHeaders.response` for why it matters.
    const { name, values } = scriptPolicy.response;
    response.headers.delete(name);
    for (const value of values) response.headers.append(name, value);
  }
  const exposure = readSearchExposure();
  if (
    shouldNoIndexRequest({
      indexingEnabled: exposure.indexingEnabled,
      pathname: routePath,
      search: request.nextUrl.search,
    })
  ) {
    response.headers.set("X-Robots-Tag", NO_INDEX_VALUE);
  }
  return response;
}

export async function proxy(request: NextRequest) {
  // `/en/...` is the same route tree as `/...`: the prefix is read here, stripped, and the render is
  // told which language it is by a header this function always overwrites. Everything below works
  // on the route path, so no rule in this file has to know a second spelling of any page.
  const { locale, pathname: routePath } = splitLocalePath(request.nextUrl.pathname);

  // A marketing link carrying a voucher code is answered before anything renders: a body-less redirect to the clean
  // URL (by way of the server handler that validates the code), so the code never reaches a document that loads
  // analytics, a Referer header or a cache (Voucher v1 V19, spec §8).
  const voucherLink = planVoucherLinkRedirect({ method: request.method, pathname: routePath, search: request.nextUrl.search });
  if (voucherLink !== null) {
    const handler = new URL(voucherLink.handlerPath, request.nextUrl.origin);
    if (locale !== DEFAULT_LOCALE) {
      if (handler.pathname === VOUCHER_LINK_PATH) handler.searchParams.set("lang", locale);
      else handler.pathname = localizeHref(handler.pathname, locale);
    }
    const redirect = NextResponse.redirect(handler, 307);
    for (const [name, value] of Object.entries(VOUCHER_REDIRECT_HEADERS)) redirect.headers.set(name, value);
    return redirect;
  }

  const scriptPolicy = readStrictScriptPolicy(request);
  const listingViewCookie = planListingView(request, scriptPolicy.request);
  scriptPolicy.request.set(LOCALE_REQUEST_HEADER, locale);
  const forward = { request: { headers: scriptPolicy.request } };

  const respond = (response: Response): Response =>
    applyResponseHeaders(request, response, routePath, scriptPolicy, listingViewCookie);

  /** Lets the request through; an English one is rewritten onto the route its prefix names. */
  const proceed = (): Response => {
    if (locale === DEFAULT_LOCALE) return respond(NextResponse.next(forward));
    const destination = request.nextUrl.clone();
    destination.pathname = routePath;
    return respond(NextResponse.rewrite(destination, forward));
  };

  if (!EXACT_PRODUCT_PATH.test(routePath)) return proceed();

  const slug = routePath.slice(SHOP_PRODUCT_PREFIX.length);
  const resolution = await resolveConfiguredStorefrontProductSlug(slug);

  if (resolution.kind === "CURRENT") return proceed();

  if (resolution.kind === "HISTORICAL") {
    const destination = new URL(readStorefrontOrigin());
    destination.pathname = localizeHref(`${SHOP_PRODUCT_PREFIX}${resolution.currentSlug}`, locale);

    return applyResponseHeaders(
      request,
      new Response(null, {
        status: 301,
        headers: {
          Location: destination.href,
        },
      }),
      routePath,
    );
  }

  // An unresolvable slug is a 404, and it should look like this site saying so. Rewriting to a
  // path the app deliberately does not route hands the response to Next's own not-found
  // rendering, which answers 404 with the site's layout - so there is one 404 page here, not a
  // second one maintained in this file.
  //
  // Rewriting rather than falling through to /shop/[slug] is the point. The product page calls
  // notFound() itself, but src/app/shop/loading.tsx opens a Suspense boundary above it: the
  // response starts streaming before that call is reached and commits status 200, so an unknown
  // slug would answer with a soft 404 - measured on a production build, not assumed. Falling
  // through would also run the product lookup a second time and put the requested slug in the
  // streamed payload. The rewritten path carries neither.
  //
  // Cloning the request URL and replacing the path is Next's own way to build a rewrite target:
  // it keeps the framework's URL semantics rather than reassembling an origin by hand. The
  // pathname is a constant and the query and fragment are dropped, so nothing the visitor sent
  // reaches the rendered 404.
  //
  // Next re-runs this proxy for the rewritten path, and that pass applies the search exposure
  // header too - so the wrapper here is redundant in outcome, and no test can tell the two
  // apart. It stays because all four exits of this function apply the header, and one exit that
  // silently relied on an internal rewrite for it would be the odd one out.
  const destination = request.nextUrl.clone();
  destination.pathname = UNRESOLVED_PRODUCT_PATH;
  destination.search = "";
  destination.hash = "";

  return respond(NextResponse.rewrite(destination, forward));
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)"],
};
