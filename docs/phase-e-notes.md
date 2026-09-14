# Phase E — route migration as vertical slices: findings and carry-forward

Seven storefront routes moved onto `createStorefrontRoute`, one vertical slice at a time: loader,
canonical metadata builder, page wiring and focused tests landing together for each. What follows is
what the work turned up.

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

## 6. Verifier tests now track the crossing

Three tests asserted things that were true only before migration. Each now derives which side a
route is on from whether it imports the factory, so the split cannot rot:

- The boundary test holds migrated routes to the policy and keeps the live gate (T32B) off while any
  route still violates. Note that *not* every unmigrated route does — `search/page.tsx` is already
  clean by accident — so the assertion is that some still does.
- The metadata-mode test sends migrated routes to the shipped verifier; unmigrated ones keep the
  weaker regex shape they have today.
- The refresher test accepts either the page mounting it (unmigrated) or the shell mounting what the
  loader sealed (migrated).

Language-inventory tests followed metadata copy into `@/routes/metadata/*`; shopper-facing copy is
still checked on the page.

## 7. One shell change

The shell serialized `structuredData` as a single array in one script. The PDP publishes one
`@graph` document, so that would have turned its JSON-LD from `{…}` into `[{…}]` — an SEO-visible
change for no gain. It now emits one script per document, which is byte-identical for every route
that publishes one.

## 8. Still open

- **12 routes remain**: cart, checkout (+success), about, contact, shipping, returns, size-guide,
  track-order, search, account, new-arrivals. The live boundary gate (T32B) unblocks when they land.
- **`colorSwatches` on listing surfaces** still resolve colour-only, because only the PDP carries
  `galleryIndexByVariantId`. Unchanged from Phase D; it needs repository work.
- **No admin surface** writes the new editorial fields yet. The columns and the read path exist and
  are validated; populating them is a separate piece of work.
