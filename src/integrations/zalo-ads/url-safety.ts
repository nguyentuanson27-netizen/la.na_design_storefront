/**
 * Which locations the Zalo Ads tracker may observe.
 *
 * ztracker.js reports the full current URL with every beacon and the document referrer with its
 * page view (docs/integrations/zalo-ads-pixel.md). A URL is external input -- the storefront writes
 * shopper input into some (`/shop?q=`, `?order=`), and anyone can edit or share any of them -- so a
 * location is safe only when every part of it beyond the path has a contract tight enough to rule
 * out customer data. This mirrors the page_view boundary in `buildPageViewEvent`, which strips
 * query and fragment for the same reason; here the payload is built by a third-party script, so the
 * only control left is whether that script may run.
 *
 * Fail-closed: anything unparseable, any parameter or anchor not on a list, or any value outside
 * its contract is unsafe.
 */

// The ad-attribution parameters ztracker.js itself reads: Zalo's click redirect writes zaclid and
// zsrcid, and utm_ads/adtid come from the ad configuration. The storefront never writes them.
// Generic utm_* are deliberately absent: utm_term/utm_content are free text.
const ATTRIBUTION_PARAMS: ReadonlySet<string> = new Set(["zaclid", "zsrcid", "utm_ads", "adtid"]);

// Their values are opaque ids, so the contract is an opaque token: ASCII letters, digits, `_` and
// `-` only, which already excludes email addresses, spaces, Vietnamese text and street addresses.
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{1,128}$/;
// Within that charset, refuse the two customer identifiers that still fit: a phone number (digits,
// optionally `+` or separated) and this storefront's order code.
const PHONE_SHAPED = /^\+?[0-9]{8,15}$/;
const ORDER_CODE_SHAPED = /^la-/i;

// The in-page anchors the site itself links to (skip link, policy hub sections). A fragment is
// otherwise free text in the address bar, so every other fragment is unsafe.
export const ZALO_SAFE_ANCHORS: ReadonlySet<string> = new Set([
  "main-content",
  "thanh-toan",
  "dieu-khoan-chung",
  "chinh-sach-gia",
  "bao-mat",
  "dieu-kien-cung-cap",
  "quyen-nghia-vu",
]);

function parse(href: string): URL | null {
  try {
    return new URL(href);
  } catch {
    return null;
  }
}

function isOpaqueAttributionValue(value: string): boolean {
  if (!OPAQUE_TOKEN.test(value)) return false;
  if (PHONE_SHAPED.test(value.replace(/[-_]/g, ""))) return false;
  return !ORDER_CODE_SHAPED.test(value);
}

/** True when `href`, a storefront URL on `origin`, carries nothing that could be customer data. */
export function isZaloSafeLocation(href: string, origin: string): boolean {
  const url = parse(href);
  if (url === null || url.origin !== origin) return false;
  if (url.username !== "" || url.password !== "") return false;
  for (const [key, value] of url.searchParams) {
    if (!ATTRIBUTION_PARAMS.has(key) || !isOpaqueAttributionValue(value)) return false;
  }
  return url.hash === "" || ZALO_SAFE_ANCHORS.has(url.hash.slice(1));
}

/**
 * True when the document referrer may be reported. A same-origin referrer is a storefront URL and
 * gets the same rule as the location; another site's URL is not storefront state (and this site's
 * Referrer-Policy already sends other sites only its origin).
 */
export function isZaloSafeReferrer(referrer: string, origin: string): boolean {
  if (referrer === "") return true;
  const url = parse(referrer);
  if (url === null) return false;
  return url.origin !== origin || isZaloSafeLocation(referrer, origin);
}
