# ADR 0025 — First-visit redirect from the Vietnamese home page to `/en` for visitors outside Vietnam

Status: implemented. One runtime dependency (`ip3country`); no flag, no migration, no edge change.

## Why

Customers abroad (mostly arriving from ads) land on `/`, which is Vietnamese. The owner asked that a visitor whose IP
is not in Vietnam be sent to `/en` when they open the main page.

This refines ADR 0024, which rejected redirecting from `Accept-Language` so that a URL always means one language. That
still holds for every page except the bare home page, and the redirect below is a one-time, remembered, per-visitor
choice rather than a rule about the URL.

## Decision

`src/proxy.ts` calls `planGeoRedirect` (`src/i18n/geo-redirect.ts`) after the voucher-link rule and before anything
renders. It answers `307` with `Location: /en` (query string kept, so `utm_*`/`fbclid` still reach the English page) and
sets `la_geo_redirected=1` (1 year, `HttpOnly`, `SameSite=Lax`, `Secure` on HTTPS) only when **all** of these hold:

- the path is exactly `/` and the request's language is Vietnamese (so `/en`, `/shop`, and the internal rewrite pass of
  `/en` are never touched);
- it is a browser loading a document: `GET`, not a prefetch, `Sec-Fetch-Dest: document` (or `Accept: text/html`), with a
  User-Agent that is not a crawler, link previewer, ad reviewer or HTTP library (an empty UA counts as a bot);
- the visitor has no `la_geo_redirected` cookie, and the `Referer` is not a page of this site. The cookie makes the
  decision once per visitor, so choosing **VI** in the switcher afterwards sticks; the Referer rule covers the same click
  for visitors who refuse cookies;
- the country is known and is not `VN`. Unknown never redirects.

Everything else is unchanged: no other page redirects, and a deep link (`/shop/...`, an ad landing on a product) is
served in Vietnamese as before. Googlebot and Meta/TikTok/Zalo review and preview crawlers always get the Vietnamese
home page, so indexing, `hreflang` and link previews are unaffected.

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

The `ip3country` table is compacted from IP2Location LITE (DB1, CC BY 4.0), which requires this notice wherever the
product is described: *This site or product includes IP2Location LITE data available from
<https://lite.ip2location.com>.* Add it to a public page (for example the footer or a credits line in the policies)
before launch if the owner wants to stay inside the licence.

## Tests

`tests/domain/i18n-geo-redirect.test.ts`: the redirect conditions (country, path, locale, cookie, referer, crawlers,
prefetch, methods, query preservation) and the lookup (IPv4, IPv4-mapped IPv6, IPv6, private and malformed input).
Verified by hand on `next dev` and on a production build with `X-LA-Client-IP` set to a US, a JP and a VN address.
