/**
 * Which locations the Zalo Ads tracker may observe.
 *
 * ztracker.js reports the full current URL with every beacon and the document referrer with its
 * page view (docs/integrations/zalo-ads-pixel.md). Storefront URLs can carry shopper input -- the
 * search box writes free text into `/shop?q=` and the order flows put the order code in `?order=`
 * -- so the tracker may only see a URL whose query is limited to reviewed ad-attribution
 * parameters. This mirrors the page_view boundary in `buildPageViewEvent`, which strips query and
 * fragment for the same reason; here the payload is built by a third-party script, so the only
 * control left is whether that script may run.
 *
 * Fail-closed: anything unparseable, or any parameter not on the list, is unsafe.
 */

// Ad-attribution parameters authored by the advertiser or by Zalo's click redirect, never typed by
// a shopper. zaclid/zsrcid/utm_ads/adtid are the ones ztracker.js itself reads; the standard utm_*
// set keeps campaign landing URLs trackable.
const ATTRIBUTION_PARAMS: ReadonlySet<string> = new Set([
  "zaclid",
  "zsrcid",
  "utm_ads",
  "adtid",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
]);

// In-page anchors the site links to (`/shipping#thanh-toan`). Anything else in a fragment is unsafe.
const SAFE_FRAGMENT = /^#[A-Za-z0-9_-]{0,64}$/;

function parse(href: string): URL | null {
  try {
    return new URL(href);
  } catch {
    return null;
  }
}

/** True when `href`, a storefront URL on `origin`, carries no shopper-supplied state. */
export function isZaloSafeLocation(href: string, origin: string): boolean {
  const url = parse(href);
  if (url === null || url.origin !== origin) return false;
  if (url.username !== "" || url.password !== "") return false;
  for (const key of url.searchParams.keys()) {
    if (!ATTRIBUTION_PARAMS.has(key)) return false;
  }
  return url.hash === "" || SAFE_FRAGMENT.test(url.hash);
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
