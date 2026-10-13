import { type NextRequest, NextResponse } from "next/server";

import { resolveConfiguredStorefrontProductSlug } from "@/commerce/storefront-catalog-runtime";
import { readStorefrontOrigin } from "@/commerce/storefront-origin";
import {
  META_CLICK_ID_COOKIE,
  META_CLICK_ID_MAX_AGE_SECONDS,
  META_VISITOR_ID_COOKIE,
  META_VISITOR_ID_MAX_AGE_SECONDS,
  nextMetaClickIdCookie,
  nextMetaVisitorIdCookie,
  serializeMetaFirstPartyCookie,
} from "@/integrations/meta/first-party-cookies";
import { readSearchExposure, shouldNoIndexRequest } from "@/seo/search-exposure";

const SHOP_PRODUCT_PREFIX = "/shop/";
const EXACT_PRODUCT_PATH = /^\/shop\/[^/]+$/;
const NO_INDEX_VALUE = "noindex, nofollow";
/** Deliberately unroutable: it exists to be answered by the app's not-found page, never matched. */
const UNRESOLVED_PRODUCT_PATH = "/__unresolved-product";

const META_PIXEL_CONFIGURED = (process.env.LA_BUILD_FACEBOOK_PIXEL_ID ?? "").length > 0;

/**
 * Writes the first-party cookies Meta's events match on: the ad click's `fbclid` as `_fbc`, so a
 * later Purchase still carries it when the pixel never ran or its cookie expired, and this site's
 * visitor ID as `la_vid`, sent as `external_id`. Only document loads count; with no pixel
 * configured nothing Meta-related is written at all. Storefront pages are `private, no-store`,
 * so no shared cache can hand one visitor's cookie to another.
 */
function applyMetaFirstPartyCookies(request: NextRequest, response: Response): void {
  if (!META_PIXEL_CONFIGURED || (request.method !== "GET" && request.method !== "HEAD")) return;
  // Next runs the proxy again for the 404 rewrite below; the first pass already wrote these.
  if (request.nextUrl.pathname === UNRESOLVED_PRODUCT_PATH) return;
  try {
    const origin = readStorefrontOrigin();
    const clickId = nextMetaClickIdCookie({
      fbclid: request.nextUrl.searchParams.get("fbclid"),
      existing: request.cookies.get(META_CLICK_ID_COOKIE)?.value,
      nowMs: Date.now(),
    });
    if (clickId !== null) {
      response.headers.append("Set-Cookie",
        serializeMetaFirstPartyCookie(META_CLICK_ID_COOKIE, clickId, META_CLICK_ID_MAX_AGE_SECONDS, origin));
    }
    const visitorId = nextMetaVisitorIdCookie(request.cookies.get(META_VISITOR_ID_COOKIE)?.value);
    if (visitorId !== null) {
      response.headers.append("Set-Cookie",
        serializeMetaFirstPartyCookie(META_VISITOR_ID_COOKIE, visitorId, META_VISITOR_ID_MAX_AGE_SECONDS, origin));
    }
  } catch {
    // Measurement never costs a shopper the page.
  }
}

function applyResponseHeaders(request: NextRequest, response: Response): Response {
  applyMetaFirstPartyCookies(request, response);
  const exposure = readSearchExposure();
  if (
    shouldNoIndexRequest({
      indexingEnabled: exposure.indexingEnabled,
      pathname: request.nextUrl.pathname,
      search: request.nextUrl.search,
    })
  ) {
    response.headers.set("X-Robots-Tag", NO_INDEX_VALUE);
  }
  return response;
}

export async function proxy(request: NextRequest) {
  if (!EXACT_PRODUCT_PATH.test(request.nextUrl.pathname)) {
    return applyResponseHeaders(request, NextResponse.next());
  }

  const slug = request.nextUrl.pathname.slice(SHOP_PRODUCT_PREFIX.length);
  const resolution = await resolveConfiguredStorefrontProductSlug(slug);

  if (resolution.kind === "CURRENT") {
    return applyResponseHeaders(request, NextResponse.next());
  }

  if (resolution.kind === "HISTORICAL") {
    const destination = new URL(readStorefrontOrigin());
    destination.pathname = `${SHOP_PRODUCT_PREFIX}${resolution.currentSlug}`;

    return applyResponseHeaders(
      request,
      new Response(null, {
        status: 301,
        headers: {
          Location: destination.href,
        },
      }),
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

  return applyResponseHeaders(request, NextResponse.rewrite(destination));
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)"],
};
