# Phase E — route migration as vertical slices: findings and carry-forward

All nineteen storefront routes moved onto `createStorefrontRoute`, one vertical slice at a time:
loader, canonical metadata builder, page wiring and focused tests landing together for each. Seven
landed in the first pass (T19–T25); the remaining twelve and the live gates landed in the recovery
pass (T26–T32B), which §9 covers. What follows is what the work turned up.

## 1. What a slice actually consists of

Phase C left three contracts that only bite once a route migrates, and each one shaped the slices:

- **The boundary.** `src/app` may reach only `src/app`, `src/routes`, `src/brand`,
  `src/components/brand`, `src/components/headless`, plus `react`, `react-dom`, `next`,
  `next/image`, `next/link`. That is what forces `connection()`, `notFound()` and every
  `@/commerce` call into the loader — not a style preference.
- **The metadata contract.** A migrated page's metadata must be a *direct call* to a builder
  imported by name from `@/routes/metadata/*`. I first put the builder next to the loader and the
  verifier rejected it, correctly.
- **The shell.** Promotion refresh, the commerce event and JSON-LD are sealed into the handle and
  mounted unconditionally, so a page cannot forget one.

## 2. Two constants that must not be retyped

The shop form's bounds came out of `STOREFRONT_DISCOVERY_LIMITS`. Because the page cannot import
from `@/commerce`, I first wrote them as literals — and got both wrong (120 and 500,000,000 against
the real 80 and 1,000,000,000), which would have shipped a search field accepting 40 characters the
loader then rejects. They now travel through the view model. Any future slice with a form should do
the same rather than copy a bound into markup.

## 3. Behaviour preserved, including one wart

`/flash-sale` emits `?page=1` when paging back to the first page, while the shop listing's href
builder drops the param. That means page one of Flash Sale has two spellings. It is characterized in
`flash-sale-route-model.test.ts` rather than canonicalised: a migration is not the place to change a
URL search engines already hold. Worth fixing deliberately in a later phase.

## 4. Carry-forward fields, and the migrations they needed

Both landed behind migrations, per the decision to allow them for exactly these fields.

- **Product**: `material` (one editorial sentence) and `craftDetails` (an array, because the notes
  render as a list — splitting a paragraph back into bullets in the reader is how that formatting
  gets lost). Blank entries are dropped at the repository and again at the model, and the notes
  section only opens when some row has content.
- **Collection**: the story stays `description`; no separate story field exists, deliberately. Added
  are `heroImageUrl`, `galleryImageUrls`, `videoSrcUrl`/`videoPosterUrl` and `featuredProductSlugs`.

Two rules worth keeping:

- **Pinning reorders, it never reaches.** `featuredProductSlugs` reorders the page the query already
  returned. Surfacing a pinned product the shopper filtered out would put an item in front of
  someone who asked not to see it.
- **Stored URLs are re-validated on read.** A row written before the validator, or edited by hand,
  must not put an untrusted host in front of a shopper just because it came from the database.

## 5. Video needed a real security decision, not a stub

Shipping `video {src, poster}` as a stored field alone would have shipped something dead:

- CSP had no `media-src`, so it fell through to `default-src 'self'` and any `<video>` from the CDN
  would have been blocked outright. It now names `content.pancake.vn` — the host `img-src` already
  trusts. **This adds a media type, not a place media may come from.**
- `parseTrustedProductVideoUrl` is a separate entry point rather than a widened image parser, so
  nothing asking for a photograph can be handed an `.mp4`. It shares every other rule: HTTPS, the one
  reviewed host, no port, no credentials, no traversal, the reviewed path shape. Tests pin both
  directions.

Anyone adding another media type should follow this shape rather than loosening the existing parser.

## 6. Verifier tests tracked the crossing, then became live gates

During the first pass, three tests derived which side a route was on from whether it imported the
factory, so the split could not rot while slices landed:

- The boundary test held migrated routes to the policy and kept the live gate (T32B) off while any
  route still violated. Not every unmigrated route did — `search/page.tsx` was already clean by
  accident — so the assertion was that *some* still did, which is what made it fail the moment the
  migration finished.
- The metadata-mode test sent migrated routes to the shipped verifier; unmigrated ones kept the
  weaker regex shape.
- The refresher test accepted either the page mounting it or the shell mounting what the loader
  sealed.

**T32B replaced the first two with live gates.** The transitional branches are gone: every route is
held to the shipped metadata verifier, and the boundary scan runs over the repository. §9 has the
details.

Language-inventory tests followed metadata copy into `@/routes/metadata/*`; shopper-facing copy is
still checked on the page.

## 7. One shell change

The shell serialized `structuredData` as a single array in one script. The PDP publishes one
`@graph` document, so that would have turned its JSON-LD from `{…}` into `[{…}]` — an SEO-visible
change for no gain. It now emits one script per document, which is byte-identical for every route
that publishes one.

## 8. Still open after the first pass

- **`colorSwatches` on listing surfaces** still resolve colour-only, because only the PDP carries
  `galleryIndexByVariantId`. Unchanged from Phase D; it needs repository work.
- **No admin surface** writes the new editorial fields yet. The columns and the read path exist and
  are validated; populating them is a separate piece of work.

## 9. The recovery pass (T26–T32B)

The remaining twelve routes — cart, checkout and its confirmation, about, contact, shipping,
returns, size-guide, track-order, search, account, new-arrivals — landed in the same slice shape.
Three things are worth recording.

**The shell gained one field.** `RoutePayload.pixelEvents` carries page-level Meta pixel events,
mirroring `structuredData`. It was opened because the contract genuinely could not carry checkout's
`InitiateCheckout` or the confirmation's `Purchase`: a page may not import `@/components/analytics`,
and mounting them from a brand component would make every redraw responsible for remembering them —
the forgetting the shell exists to prevent. Every loader states `pixelEvents: []` explicitly rather
than the field being optional.

**Both verifiers are live gates now.**

- Boundary: the scan enumerates every `.ts`/`.tsx` under `src/app` except admin, so a new file
  cannot arrive unseen. Route handlers (`route.ts`, `robots.ts`, `sitemap.ts`) and the root layout
  are exempt — the first three are server endpoints a page policy would forbid from their only
  purpose, and the root layout is chrome rather than a brand-redrawn page. Handlers are classified
  **by filename, not by path**: `bootstrap:brand` renames `src/app/<slug>-social-card.png/` per fork,
  so a listed path would break the gate on a valid handler the first time someone forks this
  template. A regression test pins the renamed case.
- Metadata: every route goes to the shipped verifier, plus a provenance check that the default export
  is the `Page` of a binding `createStorefrontRoute` returned. A text match for the factory import
  and for `something.Page` is satisfiable without the shell — an unused import next to a hand-rolled
  `{ Page }` object — and negative fixtures pin that.

**The transitional shims are gone.** `src/components/commerce/{product-purchase-panel, product-gallery,
storefront-product-card, cart-line-controls}` and `src/components/account/account-auth-panel` kept the
pre-Phase-D public surfaces alive while routes still imported them. No route does now. They were
deleted rather than left: `tsconfig` typechecks the whole tree, so a Phase G redraw replacing the
brand layer would have failed through files nothing renders.

## 10. Still open after the recovery pass

- **The root layout is outside the boundary.** It mounts the tracking bootstrap, the site header and
  footer, and the site-level JSON-LD. The scan enumerates it and exempts it by name. Bringing it
  under the boundary is real work and wants its own slice.
- **Checkout's buyer copy has no targeted language test.** It had none before the migration either;
  the repo-wide English/technical inventory still covers it, but no test pins its required
  Vietnamese copy the way the cart's and the PDP's are pinned.
- **`src/components/commerce/product-card.tsx` is unused** but was left in place: unlike the five
  shims above it imports no brand module, so it carries none of the redraw risk that motivated
  removing them.
