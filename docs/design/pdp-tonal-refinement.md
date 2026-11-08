# PDP tonal refinement

Direction: a quiet frame, so the photographs carry the colour. The storefront's colour already lives in
its imagery (pastel pinks, soft greens, reds); the interface stays warm brown and cream and gains depth from
tone, type and space rather than new hues. Master spec §9 (warm brown primary, cream support, feminine,
refined, image-first) and the homepage's own headings are the references.

## What changed (product page only)

| Area | Change | Where |
| --- | --- | --- |
| Promotion offers | Ticket in the voucher-chip family: discount in the neutral ink tone, gift in mocha (`--olive`). | `shop/[slug]/page.tsx`, `.voucher-tone--mocha` |
| Voucher group label | Small display-face label, wide tracking, mocha. | `.pdp-voucher-label` |
| Discount tag | Solid, in the price's own colour: Flash red `#9A3324`, otherwise ink `#3B2219`. | `purchase-panel.tsx` |
| Option chips (size, colour, kind) | Same 32px chip and 44px target; unselected is warm white with a brown hairline (was a 5% tint, no border). Unavailable chips are dashed, dimmed and struck through. | `SELECTABLE_CHIP`, `UNAVAILABLE_CHIP` |
| Size guide / try-on | Two outlined buttons that share one row while they fit (down to 360px at the default text size), and wrap instead of clipping when they do not (larger text, 320px). 44px minimum height. Try-on sits on a stone tint with an ink "Beta" tag. Below 390px the ruler icon is dropped. | `.pdp-action-chip` |
| Reading blocks | Desktop titles one step larger, a 24px caramel (`#B8825F`, the logo's colour) hairline above each, ink-tinted dividers. Phone fold-away rows are unchanged. | `.pdp-section-title`, `PdpDisclosure` |
| Customer photographs | Full-bleed linen band (`--linen`), heading centred in small capitals like the homepage's. | `.pdp-feedback-band` |
| Related products | Heading centred, same voice. | `.section-heading-row--center` |

## Unchanged on purpose

The Flash Sale strip and its gradient, the purchase panel's flat layout (no surrounding card), the primary and
outline buttons, the typefaces, and every selection, pricing and voucher behaviour.

## Listing pages (same direction)

The product page's colour pass carried over to every listing (`/shop`, `/sale`, `/new-arrivals`, `/collections`,
category and collection pages). Quiet, no new hues, no size or layout change.

| Area | Change | Where |
| --- | --- | --- |
| Filter chips, size chips, view toggle | Unselected is warm white with a visible brown hairline (was transparent with a 20% line). Selected stays solid ink. | `plp-filter-panel`, `collection-filter-panel`, `listing-view` |
| Inputs and sort select | Warm white fill, 30% brown line. | `shop-controls`, `plp-filter-panel`, `shop/page`, `LISTING_ACTION_BAR_CLASSES` |
| Active-filter tags | Stone tint (`#D4C7B8` at 45%), the same tint as the try-on button. | filter components |
| Sibling-listing tabs | Current underline is the logo's caramel (`#B8825F`); the label stays ink. | `.listing-subnav-link` |
| Listing heading | A 24px caramel hairline above the eyebrow, only where `ListingHeader` is used (`PageHeader mark`). Account, checkout and content pages are unchanged. | `page-chrome`, `listing-chrome` |

Unchanged on purpose: the Flash Sale and discount tags, the product cards, the photographs, the grid and every filter's behaviour.
