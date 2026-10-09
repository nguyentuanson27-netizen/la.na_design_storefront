# GTM-PRZT92JR — review notes behind the audit pins

These are the facts a reviewer read from saved version 4 before the audit was allowed to pin two
things it refuses by default. They are not an approval of anything else in the container, and the
pins are only valid for the exact bytes named here.

## TikTok Base (Custom HTML tag "tiktok ads - pixel")

- It is TikTok's standard pixel snippet. It defines `window.ttq`, loads
  `https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=<id>`, then runs `ttq.load('CRJQE53C77UDCGHCT5U0')`
  and `ttq.page()` (a TikTok PageView).
- It must stay: the reviewed template below can only call functions on a `ttq` that already exists.
- Pinned by the SHA-256 of the exact `html` parameter: `bd07c2254ac662315e3461d0a54993154501dd73c7d9e14e744738698b54e371`.
- The audit additionally requires every `ttq.load('<id>')` in it to be an owner-approved TikTok pixel,
  and refuses the tag if it carries any parameter other than `html` / `supportDocumentWrite`, or if
  `supportDocumentWrite` is enabled.

## TikTok Pixel gallery template (`cvt_MRQN8`, `tiktok/gtm-template-pixel`)

- Source: github.com `tiktok/gtm-template-pixel`, commit `4ec12fa4f950ef1f829255007287ad26d40132a6`,
  signature `50cbfb75f71b7527977e02eff867e564a69edba2db3fe8a9097b1ae252730680`.
- `templateData` SHA-256: `46abd9530d1f1af4f34c44a7f7ce0f986a3d794a81b5515ca7967cf774da5c43`.
- Declared permissions: `logging` (debug only), `access_globals` (read `ttq`, execute `ttq.track` and
  `ttq.identify`), and `read_data_layer` (any key). No script injection, no pixel/network send, no
  cookie or storage access, no DOM access. It cannot reach the network except through the `ttq` that
  the Base tag loaded.
- It reads the dataLayer keys `ecommerce`, `eventModel`, `user_data` and `tt_*` (order id, contents,
  customer type, external id). With `enhance_ecomm` on it can pass hashed email / phone from
  `user_data` to `ttq.identify`.
- The storefront does not currently push `user_data`, or any customer identity, into the dataLayer, so
  there is nothing for `ttq.identify` to hash today. **If `user_data` is ever pushed, TikTok starts
  receiving hashed identifiers; that change needs its own review.**
- The audit reads one destination field from these tags, `pixel_code`, which must be an approved
  TikTok pixel; a tag with no `pixel_code`, or one named through an unresolvable variable, is refused.

## Approved destinations (owner-confirmed)

- GA4: `G-94N0KSJG27`
- Google Ads: `AW-17016425181`, conversion label `Uy3bCLC82ZYdEN2ViLI_`
- TikTok pixel: `CRJQE53C77UDCGHCT5U0`
