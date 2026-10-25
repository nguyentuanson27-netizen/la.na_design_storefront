# ADR 0018 — Meta Pixel manual advanced matching at checkout

Status: Accepted; amends the "user data remain server-only" line of ADR 0015.
Date: 2026-10-25

## Decision

When a shopper submits guest checkout, the browser pixel is told who they are, so the pixel's own events from that checkout carry the same match keys the Conversions API already sends with Purchase.

- Keys: `ph`, `fn`, `ln` only, SHA-256 hashed in the browser. The pixel never receives the plain phone number or name. There is no `em`: checkout collects no email.
- Delivery: a repeat `fbq('init', pixelId, data)` for the same pixel, which fires no event. The snippet leaves its own `init` data on `window.laMetaPixelUserData`, and the update merges into it, so `external_id` is not dropped (a repeat `init` replaces, it does not merge).
- Normalization is shared with the server (`src/integrations/meta/identity-normalization.ts`, Node-free) so both sides hash identically; a test pins the parity.
- Gate: `ad_user_data` from `src/tracking/consent.ts`. Changing the consent policy there switches this off with no other edit. Under the current `granted-on-entry` policy it is on.
- Nothing is stored. Not in `localStorage`/`sessionStorage`/cookies; a reload starts without it. Nothing is read before submit, so PageView, ViewContent and InitiateCheckout (which fire before the shopper has typed anything) gain nothing; the benefit is to events after submit.
- Failure never reaches the shopper: the call is fire-and-forget, wrapped, and runs before, not inside, the order action.

## Why this overrides ADR 0015's "server-only"

ADR 0015 kept user data off the browser to keep PII out of third-party script reach. Hashing before the call keeps the plain values out of `fbq`; the hash is still personal data, so the consent gate is required, not optional.

## Not done

- Meta's *automatic* advanced matching is an Events Manager setting for the dataset, not code; it is independent of this change and unverified.
- No `em`, no `ct`/`st`/`zp`/`country`: not collected as clean fields, and not needed to reach the keys Meta scores.
- Measured baseline before this change (Events Manager, 2026-10-25): EMQ 6.1 for PageView/ViewContent/AddToCart/InitiateCheckout, 7.8 for Purchase. Re-read after deploy; expect no change on the first four, since they fire before submit.
