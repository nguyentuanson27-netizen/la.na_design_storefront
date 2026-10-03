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

The guide documents **no JavaScript API**: no page-view call, no custom/standard event call, no
value, no event id, no dedupe. Nothing of that kind is implemented here.

## What the storefront does

- `NEXT_PUBLIC_ZALO_ADS_PIXEL_ID`: public, not secret, build-time. It is validated as a bounded
  token (`[A-Za-z0-9_-]{1,128}`) identically in `next.config.mjs` and
  `src/integrations/zalo-ads/pixel-config.ts`. Bad values and leading/trailing whitespace fail
  loudly. Blank means fully disabled.
- `LA_BUILD_ZALO_ADS_PIXEL_ID`: the build-time constant the request path reads. A runtime-only id
  therefore cannot switch the loader on behind a CSP built without it.
- `src/components/analytics/zalo-ads-pixel.tsx`, mounted once in `SiteChrome`, renders the official
  tag through `next/script` (`afterInteractive`, async). It has no inline code and nothing waits
  on it, so a blocked or failed load is a no-op. The only parameter sent is the id. There is no
  `<noscript>`, because the official snippet has none.
- CSP: `script-src https://s.zzcdn.me`, opened only when the id is set at build time.

## Status: one blocker left before an id can be configured

Where `ztracker.js` sends its data is not documented, and the script could not yet be read: the
build environment's network policy denied `s.zzcdn.me`. Opening only `script-src` would load the
tracker and then have every beacon blocked by `connect-src`/`img-src`. That is tracking that looks
installed and reports nothing. So **a non-blank `NEXT_PUBLIC_ZALO_ADS_PIXEL_ID` currently fails the
build** with a message pointing here.

To finish:

1. Read `https://s.zzcdn.me/ztr/ztracker.js` (allow `s.zzcdn.me` in the environment's network
   policy) and list every origin it contacts: XHR/fetch/beacon go to `connect-src`, pixels to
   `img-src`, any further scripts to `script-src`. Also check whether it observes
   `history.pushState` (relevant to SPA navigations, below).
2. Add exactly those origins behind `hasZaloAdsPixel` in `next.config.mjs`, remove the build guard,
   and replace the "refuses to build" test in `tests/integrations/security-headers.test.ts` with a
   "configured → exact origins" test.

After that, going live is: set `NEXT_PUBLIC_ZALO_ADS_PIXEL_ID`, rebuild the image, redeploy.

## Going live (once the blocker is cleared)

1. Zalo Ads → Thư viện → Conversion → Lấy mã pixel. Copy only the `id=` value.
2. Set `NEXT_PUBLIC_ZALO_ADS_PIXEL_ID` in `deploy/vps/env.example`'s live counterpart. Compose
   passes it as a build arg.
3. Rebuild the image and redeploy. Changing the id later also needs a rebuild, because the CSP is
   baked into the build.
4. Verify: open the site, and in DevTools → Network you should see `ztracker.js?id=<id>` load from
   `s.zzcdn.me` with no CSP violation in the console. Then create the conversions below and check
   that Thư viện → Conversion → "Tổng conversion" counts a test visit.

Never commit a real id.

## Conversions to configure in the Zalo Ads dashboard

The storefront emits no client events to Zalo (Zalo documents none). Canonical commerce events
stay the source of truth for GTM/Meta/ChatGPT Ads; for Zalo, configure URL-keyword conversions:

| Canonical event  | Storefront URL                 | Suggested URL keyword |
| ---------------- | ------------------------------ | --------------------- |
| `view_cart`      | `/cart`                        | `/cart`               |
| `begin_checkout` | `/checkout`                    | `/checkout`           |
| `purchase`       | `/checkout/success?order=LA-…` | `/checkout/success`   |

Notes:

- Matching is by substring, so `/checkout` also matches `/checkout/success`. Treat
  `begin_checkout` as "reached checkout or beyond", or leave it out.
- `view_item` (`/shop/<slug>`), `view_item_list`, `select_item`, `add_to_cart` and
  `remove_from_cart` have no URL that distinguishes them well enough, so none is proposed.
  `add_to_cart` and `remove_from_cart` are client-side actions on the same URL.
- Button-id events are **not recommended**. A click on "Đặt hàng COD" is not a confirmed order,
  and the storefront's buttons carry no stable `id`. None was added, to avoid changing storefront
  markup for an unconfirmed signal.

## Known limitations

- **Purchase accuracy.** `/checkout/success` also renders the "Chưa thể xác nhận" state for an
  order that is not confirmed, and every reload renders it again. A URL rule cannot tell these
  apart from a confirmed purchase. Zalo documents no event id or dedupe, so the storefront has
  nothing to offer. The exact confirmed-order count stays in GTM/Meta/ChatGPT Ads and Pancake.
- **SPA navigation.** Checkout reaches `/checkout/success` through a server-action redirect, which
  App Router performs client-side, and most storefront links are client-side too. Zalo documents no
  page-view call for this. Whether `ztracker.js` notices URL changes on its own is unverified (step 1
  above). If it does not, URL conversions only count pages that were loaded as a full document.
- **Order code in URL.** The confirmation URL carries the public order code (`LA-…`), which Zalo
  would see as part of the page URL. It is not personal data, and it is already the event id sent
  to Meta and ChatGPT Ads. No storefront URL carries a name, phone, email, address or account id.
- **Consent.** The official snippet has no consent switch. The tag follows the storefront's current
  policy, like the Meta pixel.
- No server-side/CAPI integration.
