# Zalo Ads Pixel

## Official contract

Source: Zalo Ads, [Thiết lập Zalo Ads Pixel](https://ads.zalo.me/business/huong-dan-thiet-lap-zalo-ads-pixel/),
including its "Hướng dẫn lấy mã pixel" screenshot. Reviewed 2026-10-03.

- Pixel: ad account → **Thư viện → Conversion → Lấy mã pixel**. For a hand-built site, copy the
  code into `<head>`. The code is exactly one tag:

  ```html
  <script async="" src="https://s.zzcdn.me/ztr/ztracker.js?id=<PIXEL_ID>"></script>
  ```

  The guide's example ids are 19 digits (`7242087840828522496`), but it publishes no format rule.
- Conversions: **Tạo conversion** → name, conversion type (for example "Hoàn tất mua hàng"),
  landing website, then events measured in one of two ways:
  - **Thêm sự kiện nút bấm**: the HTML `id` of a button on the site, up to 10.
  - **Thêm sự kiện đường dẫn URL**: keywords that appear in the destination URL, up to 10, at most
    90 characters each. The event is recorded when any one of the keywords appears in the URL.
- Campaigns use them under **Chọn nguồn dữ liệu → Pixel của tôi**.
- Reporting: **Thư viện → Conversion** ("Conversion từ QC" and "Tổng conversion").

The guide documents **no JavaScript API**: no page-view call, no event call, no value, no event id,
no dedupe. `ztracker.js` does expose an undocumented `window.ztrq(...)` queue (`track`,
`pageview`, `order`). The storefront deliberately does **not** call it.

## What the tracker does (read off `ztracker.js` v1.2.0, 2026-10-03)

Zalo does not document this. It was read off the served script and confirmed in Chromium against
those exact bytes. Re-check it if Zalo ships a new version.

| Request                            | Mechanism | CSP directive |
| ---------------------------------- | --------- | ------------- |
| `s.zzcdn.me/ztr/ztracker.js`       | script    | `script-src`  |
| `log.adtimaserver.vn/ptrck/events` | `fetch`, loads the account's conversion rules | `connect-src` |
| `log.adtimaserver.vn/tracklp`      | 1x1 image: page view, heartbeat, scroll, click | `img-src` |
| `log.adtimaserver.vn/ptrck/log`    | 1x1 image: a conversion that matched           | `img-src` |

- Parameters sent: pixel id, current URL (`curl`), `document.referrer`, event type, scroll
  percentage, timings, and Zalo's own click ids (`zaclid`, `zsrcid`) when an ad link carried them.
  `uid` is sent empty. The tracker reads no form fields. The only cookies it looks for are
  LadiPage's `_ladi_trck*`, which this site does not set. It reads element text only to match the
  configured rules.
- It also contains a `za.zdn.vn/v3/za.js` loader (`getUID`), but nothing calls it in the web build.
  That origin stays closed.
- Debug helpers load from `s.zzcdn.me` (already admitted) only when a `_ztrdebug` query parameter is
  present.
- It stores Zalo click ids and its rule cache in `sessionStorage` (`_zaclid`, `_zsrcid`, `_eztrk`).

## What the storefront does

- `NEXT_PUBLIC_ZALO_ADS_PIXEL_ID`: public, not secret, build-time. It is validated as a bounded
  token (`[A-Za-z0-9_-]{1,128}`) identically in `next.config.mjs` and
  `src/integrations/zalo-ads/pixel-config.ts`. Bad values and leading/trailing whitespace fail
  loudly. Blank means fully disabled: no tag and no Zalo origin in the CSP.
- `LA_BUILD_ZALO_ADS_PIXEL_ID`: the build-time constant the request path reads. A runtime-only id
  therefore cannot switch the tag on behind a CSP built without it.
- `src/components/analytics/zalo-ads-pixel.tsx`, mounted once in `SiteChrome`, renders
  `zalo-ads-pixel-loader.tsx`, which inserts the official tag (async, into `<head>`, id as its only
  parameter) under the privacy boundary below. It has no inline tracking code and nothing waits on
  it, so a blocked or failed load is a no-op. There is no `<noscript>`, because the official snippet
  has none.
- CSP, only when the id is set at build time: `script-src https://s.zzcdn.me`, and
  `img-src` + `connect-src https://log.adtimaserver.vn`.

## Privacy boundary

The tracker builds its own payload: the full current URL with every beacon (including the 5 s
heartbeat, which reads the *live* URL) and `document.referrer` with its page view. Storefront URLs
can carry shopper input: the search box writes free text into `/shop?q=`, and order flows put the
order code in `?order=`. The app cannot sanitize a third-party payload, so it controls only whether
the tracker may run (`src/integrations/zalo-ads/url-safety.ts`):

- A URL is safe only if everything beyond the path has a contract tight enough to rule out
  customer data. Anything else is unsafe (fail-closed), including filter parameters:
  - **Query:** only the four attribution parameters the tracker itself reads (`zaclid`, `zsrcid`,
    `utm_ads`, `adtid`). Each value must be an opaque token (`[A-Za-z0-9_-]{1,128}`, so no email,
    space, Vietnamese text or address) that is neither phone-shaped (8–15 digits, optionally `+`
    or `-`/`_`-separated) nor an order code (`LA-…`). Generic `utm_*` are not allowed, because
    `utm_term`/`utm_content` are free text. So do not put UTM parameters on Zalo ad URLs.
  - **Fragment:** only the anchors the site itself links to (`#main-content`, `#thanh-toan` and
    the `/policies` sections), kept honest by a test that scans the source for in-page links.
  - Residual: an opaque-looking token cannot be proven not to be, say, an unaccented name typed
    into `zaclid` by hand. These four parameters are written by Zalo's click redirect or the ad
    configuration, never by a storefront form.
- **At load**, the tag is inserted only if the address and the referrer are both safe. A
  same-origin referrer gets the address rule. Another site's referrer must be origin-only (no path,
  query, fragment or credentials): the referring page's own Referrer-Policy decides how much it
  sends, and this site's policy has no say over what arrives. Otherwise the tracker never loads in
  that document.
- **After load**, every URL change is checked against both the router's target and the live
  address (which carries the fragment). App Router navigations are checked in a layout effect in
  the same commit as the router's history update. Same-document changes the router does not surface
  are watched directly: `hashchange`, `popstate`, and, where the browser has the Navigation API, its
  `navigate` event, which fires before the new URL commits. The first unsafe URL (for example the
  header search's client-side `router.push('/shop?q=…')`, the checkout redirect to
  `/checkout/success?order=…`, or `location.hash = "<anything but a listed anchor>"`) adds a `<meta>`
  CSP. That policy is the header's `img-src` and `connect-src` minus `log.adtimaserver.vn`, derived
  in `next.config.mjs` and shipped as `LA_BUILD_ZALO_ADS_QUARANTINE_CSP`. A page can tighten its CSP
  but never loosen it, so the browser blocks every Zalo beacon for the rest of that document
  whatever the tracker does. Expect CSP violation messages for those blocked beacons in the console.
- The DOM logic lives in `src/integrations/zalo-ads/pixel-guard.ts` (unit-tested). The end-to-end
  behaviour is covered by `tests/a11y-runtime/zalo-ads-pixel.spec.ts`, which stands in for the
  tracker with a live-URL heartbeat.
- Without a quarantine policy the loader does not run at all.

Effect on measurement: a visit stops reporting to Zalo once the shopper searches, filters, or
reaches an order page. A new full page load on a safe URL starts it again.

## Going live

1. Zalo Ads → Thư viện → Conversion → Lấy mã pixel. Copy only the `id=` value.
2. Set `NEXT_PUBLIC_ZALO_ADS_PIXEL_ID` in the VPS env file (`deploy/vps/env.example` documents it).
   Compose passes it as a build arg.
3. Rebuild the image and redeploy. Changing the id later also needs a rebuild, because the CSP is
   baked into the build.
4. Verify: open the site with DevTools → Network. `ztracker.js?id=<id>` loads from `s.zzcdn.me`,
   then `log.adtimaserver.vn/ptrck/events` and a `/tracklp?type=pageview` image follow, with no CSP
   errors in the console. Then create the conversions below and check that Thư viện → Conversion →
   "Tổng conversion" counts a test visit.

Never commit a real id.

## Conversions: what works and what does not

The storefront emits no client events to Zalo, because Zalo documents none. Canonical commerce
events stay the source of truth for GTM/Meta/ChatGPT Ads.

**SPA limitation (observed).** `ztracker.js` runs once per full document load. It sends one page
view, and it matches URL-keyword rules once, against the URL the document was loaded at. App
Router navigations do not reload it, so a URL rule fires only when the matching page is the first
page of a visit (or is reloaded or opened directly). Button-id rules do work across client
navigations, because they listen for clicks document-wide.

Consequences:

| Canonical event  | Zalo mechanism | Works? |
| ---------------- | -------------- | ------ |
| `page_view`      | automatic `pageview`         | First page of each visit only |
| `view_item`      | URL keyword `/shop/`         | Only when a product page is the landing page |
| `view_cart`, `begin_checkout` | URL keyword `/cart`, `/checkout` | Rarely: these pages are reached by client navigation |
| `purchase`       | URL keyword `/checkout/success` | **No.** The confirmation URL carries `?order=`, so the privacy boundary keeps the tracker off it at load and quarantines it after the client-side checkout redirect. |
| `add_to_cart`, `select_item`, `remove_from_cart`, `view_item_list` | none distinguishable | No |

Recommendation: use Zalo for landing-page traffic and engagement, and URL-keyword conversions only
for landing pages (for example a campaign's product URL). Do **not** configure a
`/checkout/success` purchase conversion for optimization. Measuring purchases in Zalo would need
one of these, each a separate decision:

1. A confirmation step whose URL carries no order data, reached by a full document load (touches
   checkout).
2. Adopt the undocumented `ztrq` API (no contract, no dedupe).
3. A Zalo server-side API (not requested).

Button-id rules are not recommended either. A click on "Đặt hàng COD" is not a confirmed order, and
the storefront's buttons carry no stable `id`.

## Other limitations

- No event id or dedupe exists in the documented contract.
- Shopper input in URLs (search text, order codes) is kept from Zalo by the privacy boundary above,
  at load and after client navigation.
- Consent: the official snippet has no consent switch. The tag follows the storefront's current
  policy, like the Meta pixel.
- No server-side/CAPI integration.
