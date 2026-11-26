# ADR 0025 — First-visit geo-redirect between `/` and `/en`

Status: implemented. One runtime dependency (`ip3country`); no flag, no migration, no edge change.

## Why

Customers abroad (mostly arriving from ads) land on `/`, which is Vietnamese. Conversely, customers in Vietnam who
open an `/en` link from ads or search would otherwise see English text and USD pricing. The owner asked that a first-time
visitor whose IP is outside Vietnam be sent from `/` to `/en`, and a first-time visitor whose IP is in Vietnam who opens
`/en` or `/en/...` be sent to the matching Vietnamese page (`/` or `/...`).

This refines ADR 0024, which rejected redirecting from `Accept-Language` so that a URL always means one language. That
still holds for Vietnamese deep links, and the redirect below is a one-time, remembered, per-visitor choice rather than a
permanent block: switching language with **VI** or **EN** on the site still works and sticks.

## Decision

`src/proxy.ts` calls `planGeoRedirect` (`src/i18n/geo-redirect.ts`) after the voucher-link rule and before anything
renders (skipping internal rewrite passes where `carriedLocale !== null`). It answers `307` with `Location` (query
string kept, so `utm_*`/`fbclid` still reach the destination page) and sets `la_geo_redirected=1` (1 year, `HttpOnly`,
`SameSite=Lax`, `Secure` on HTTPS) only when **all** of these hold:

- one of the two geo rules matches:
  - the path is exactly `/` in Vietnamese and the country is known and is not `VN` -> `Location: /en` (with query);
  - the request is on an English URL (`/en` or `/en/...`, `locale === "en"`) and the country is `VN` -> `Location` drops
    the `/en` prefix to the corresponding Vietnamese path (`/` or `/...`, with query);
- it is a browser loading a document: `GET`, not a prefetch, `Sec-Fetch-Dest: document` (or `Accept: text/html`), with a
  User-Agent that is not a crawler, link previewer, ad reviewer or HTTP library (an empty UA counts as a bot);
- the visitor has no `la_geo_redirected` cookie, and the `Referer` is not a page of this site. The cookie makes the
  decision once per visitor, so choosing **VI** or **EN** in the switcher afterwards sticks; the Referer rule covers the
  same click for visitors who refuse cookies;
- the country is known. Unknown never redirects.

Vietnamese deep links (`/shop/...`, `/ao-dai/...`) for foreign visitors are still served in Vietnamese as before.
Googlebot and Meta/TikTok/Zalo review and preview crawlers always receive the requested page directly without redirect,
so indexing, `hreflang` and link previews on both `/` and `/en/...` are unaffected.

**Where the country comes from.** The edge (nginx-proxy-manager -> Caddy, Cloudflare DNS-only) adds no country header.
The client IP is the proxy-owned `X-LA-Client-IP` header Caddy already overwrites (`BETTER_AUTH_IP_HEADER`), read with
`readOptionalTrustedClientIp`; `X-Forwarded-For` is never consulted, so a visitor cannot choose their own country. The
IP is mapped to a country by `src/i18n/geo-country.ts` with the table bundled in the `ip3country` package: no network
call, no licence key, no file at request time, expanded once per process on the first home-page request. Any error
leaves the visitor on the Vietnamese page.

## Limits, on purpose

- **IPv4 only.** The table has no IPv6 ranges, so an IPv6 visitor (including an IPv6 visitor abroad) is "unknown" and
  stays on Vietnamese. IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is understood.
- **Country accuracy is that of IP2Location LITE.** Expect occasional wrong answers (mobile carriers, VPNs, Vietnamese
  customers on a foreign VPN go to `/en` and can switch back with VI). The data is a snapshot from the package
  release; bump `ip3country` now and then.
- A visitor with cookies blocked who types the bare domain again is redirected again; one who clicks VI is not.
- If a CDN that supplies a country header is put in front later, replace `lookupCountry` with that header (after the
  trusted-proxy review ADR 0002 requires) and keep `planGeoRedirect` as it is.

## Attribution

The `ip3country` table is compacted from IP2Location LITE (DB1), and the package's own ISC licence does not remove the
data licence's attribution duty. Section 3 of the LITE licence agreement
(<https://www.ip2location.com/lite-terms>, "Version 1.0", no effective date; read 2026-11-18) prescribes, for the LITE
database used on a website: *"[Product Name] uses the IP2Location LITE database for
<a href="https://www.ip2location.com">IP geolocation</a>."*, placed in the site footer, an About page, a credits page or
technical documentation, in a standard body font of at least 10px, not hidden, and as a plain crawlable link (no
`nofollow`/`sponsored`/`ugc`, no redirect). The footer of every page carries exactly that statement, with the product
name from Brand Config, in English on `/en/*` and translated on the Vietnamese pages (`src/components/brand/site-footer.tsx`,
`.footer-meta` is 0.7rem, about 11px). The licence text on the vendor's site is the authority; it is not dated, so whether
a newer version binds the snapshot bundled in `ip3country@5.0.0` is a question the owner can settle with the vendor.
If the data source is ever replaced (a paid IP2Location database, a CDN country header) this line goes with it.

## Tests

- `tests/domain/i18n-geo-redirect.test.ts`: the redirect conditions (country, path, locale, cookie, referer, crawlers
  and link previews including WhatsApp, prefetch, methods, query preservation) and the lookup (IPv4, IPv4-mapped IPv6,
  IPv6, private and malformed input).
- `scripts/geo-redirect-http-smoke.ts` (run by `tests/integrations/geo-redirect-http.test.ts`): a Next dev server with
  `BETTER_AUTH_IP_HEADER=x-la-client-ip`, asserting over HTTP the `307`, the server-owned Location with the query (both
  `/` -> `/en` for foreign visitors and `/en` or `/en/...` -> `/` or `/...` for Vietnamese visitors), the cookie
  attributes, `Cache-Control: private, no-store`, the `la_utm` ad-attribution cookie on the redirect itself, that `/en`
  and `/en/shop` answer 200 for foreign visitors and for Vietnamese visitors with the cookie or a same-site Referer,
  and that none of these are redirected: returning visitors, a click from this site, Vietnamese IPs on `/`, foreign IPs
  on `/en`, IPv6/unknown/malformed IPs, `X-Forwarded-For`/`CF-IPCountry` spoofing, Vietnamese deep links, preview and
  crawler agents (WhatsApp, Facebook, Telegram, Slack, Viber, Google, Bing), prefetch, script fetches, HEAD and POST.

The redirect response goes through the same `applyResponseHeaders` as every other exit, so it carries the search-exposure
header and the ad-attribution and Meta first-party cookies of the landing the visitor made; `/en` then finds them
already set.
