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
