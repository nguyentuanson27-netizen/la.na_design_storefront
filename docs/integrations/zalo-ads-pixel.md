# Zalo Ads Pixel

## Status: configuration only — loader blocked on the official snippet

What exists:

- `NEXT_PUBLIC_ZALO_ADS_PIXEL_ID`, a public build-time value, validated as a bounded token
  (`[A-Za-z0-9_-]{1,128}`) in both `next.config.mjs` and
  `src/integrations/zalo-ads/pixel-config.ts`. Zalo publishes no id format, so no numeric width is
  guessed.
- `LA_BUILD_ZALO_ADS_PIXEL_ID`, the build-time constant the request path reads, so a runtime-only
  id cannot switch the integration on behind a CSP that was built without it (same contract as
  Meta and ChatGPT Ads).
- Docker build arg + VPS compose passthrough.

What does **not** exist yet, deliberately:

- No Zalo script, `<noscript>` beacon, CSP origin or `SiteChrome` mount. The official snippet in
  Zalo's setup guide could not be read from the build environment (its network policy denies
  `ads.zalo.me`), and this repository does not ship third-party loaders or CSP holes copied from
  blogs or guessed from memory.
- No SPA page-view call and no client conversion events: Zalo has not been confirmed to document a
  JavaScript API for either.

Because a pixel that looks installed but reports nothing is worse than none, **a non-blank
`NEXT_PUBLIC_ZALO_ADS_PIXEL_ID` currently fails the build**. Leave it blank until the loader is
wired.

## What Zalo's official guide says (as far as verified)

Source: <https://ads.zalo.me/business/huong-dan-thiet-lap-zalo-ads-pixel/>. Only search-engine
summaries of this page were available, not the page itself, so treat this as a pointer, not the
contract:

- The pixel is created in the ad account under **Thư viện → Conversion → Lấy mã pixel**.
- For a hand-built site, the advertiser copies the generated code into the site's `<head>`.
- Zalo offers a Universal pixel and a Personal pixel.
- Conversions are created and saved in the Zalo Ads library, then chosen in campaign setup under
  **Chọn nguồn dữ liệu → Pixel của tôi**.

## Remaining work to finish the integration

1. Obtain the exact current snippet, either by allowing `ads.zalo.me` in the build environment's
   network policy or by pasting the code shown under **Lấy mã pixel** (the id can be redacted).
2. Read from that snippet: the loader URL, any beacon/XHR endpoints, and whether it exposes a
   documented call for page views or events.
3. Add `src/components/analytics/zalo-ads-pixel.tsx` (rendered only when
   `readZaloAdsPixelConfig()` is non-null, `next/script` `afterInteractive`, load failure a no-op),
   mount it once in `src/routes/site-chrome.tsx`, open exactly those origins in `next.config.mjs`
   behind `hasZaloAdsPixel`, and remove the build guard.
4. Only if Zalo documents it: a route tracker modelled on `FacebookPixelRouteTracker`, and event
   mappings from the canonical commerce events (value and order code from the canonical event,
   never recomputed).
5. Extend `tests/integrations/security-headers.test.ts` (configured → exact origins) and add a
   browser spec modelled on `tests/a11y-runtime/facebook-pixel*.spec.ts`.

After that, going live is: set `NEXT_PUBLIC_ZALO_ADS_PIXEL_ID`, rebuild the image, redeploy.

## Configuration

- `.env.example` / `deploy/vps/env.example`: `NEXT_PUBLIC_ZALO_ADS_PIXEL_ID`. Not a secret, but do
  not commit a real id. It is a build input: changing it requires rebuilding the image.

## Conversion mapping to configure in Zalo Ads (proposal)

If Zalo conversions are URL rules configured in the dashboard, these routes are the candidates:

| Canonical event   | Route                                       |
| ----------------- | ------------------------------------------- |
| `view_item`       | `/shop/<slug>`                              |
| `view_cart`       | `/cart`                                     |
| `begin_checkout`  | `/checkout`                                 |
| `purchase`        | `/checkout/success?order=LA-…`              |

Known limitations of URL rules here, to confirm against Zalo's behaviour once the snippet is known:

- `/checkout/success` also renders the "Chưa thể xác nhận" state for an order that is not
  confirmed, and every reload re-renders it. A URL rule cannot tell those apart from a confirmed
  purchase, and the storefront has no documented Zalo dedupe mechanism to offer.
- Checkout reaches `/checkout/success` through a server-action redirect, which App Router performs
  as a client-side navigation. A base pixel that only observes full document loads may not see it.
- The confirmation URL carries the public order code (`LA-…`), which Zalo would receive as part of
  the page URL. It is not personal data and is already the event id sent to Meta and ChatGPT Ads.

No PII (name, phone, email, address, checkout form data, customer/auth ids) may be sent to Zalo.
