# ADR 0023 — `/offers/eligible` lists the whole offer scope as a storefront listing

Status: implementation proposed for review. Supersedes the browse budget (phase 1) and the banner-seeded cache
(phase 2) of [ADR 0022](./0022-upsell-browse-budget-and-read-memo.md); its read memo (phase 3) and quote-error
classification still apply. No schema, flag or dependency change.

## Why

After ADR 0022 the page still looked unlike the rest of the storefront and showed two defects the shopper sees:

1. **No product photographs.** Pancake attaches photographs to variants (`VariantMirror.pancakeImageUrls`); the
   upsell code read `ProductMirror.primaryImageUrl`, which is empty for the whole catalog. Every card fell back to a
   grey box. Category, collection, sale and `/new-arrivals` pages draw their photographs from the storefront catalog
   projection, which resolves them from the variants.
2. **Four products.** Each product shown had to be quoted as a hypothetical +1 cart (about 100 ms on preview, plus
   a fixed cost), so the budget could verify only a handful inside the 1.3 s deadline, and the checkout banner's
   short list was cached and served instead.

Owner decision (2026-10-31): list the **whole offer scope without per-product quotes**, as the category pages do.

## Decision

- `/offers/eligible?campaign=…&page=…` lists every addable product in the scope of the campaign the checkout banner
  named, 24 per page, ordered like `/shop` (name, then id), with crawlable prev/next links. It is drawn with the
  listing chrome (`ListingShell`, header, result count, `ProductCard`, `ListingPagination`) and the same pricing,
  Flash Sale presentation and availability labels as `/new-arrivals`, through one new catalog read
  (`listConfiguredStorefrontListingProductsByIds`). Photographs therefore come from the variants, like everywhere else.
- The cart is still the key. `getScope` runs **one** canonical quote to learn the cart and confirms the campaign is
  currently one unit away from it; otherwise the page says the offer or cart changed. Products already in the cart
  are excluded. The trusted-request check, read gate and both rate-limit buckets are unchanged. The read gate (2 slots a
  process, shared with the banner's POST) admits quote work only: it is released as soon as the scope is known, before
  the catalog hydrates the page's cards, so slow card reads cannot hold both slots and silence the banner.
- "In scope" is one SQL fragment (`promotion-upsell-scope.ts`) shared by this listing and the banner's candidate
  discovery, so the two cannot disagree: whole catalog, a frozen fixed set, or include/exclude/category membership
  with descendants, an explicit exclusion winning over category membership.
- **Public-listing visibility.** The listing applies the default rule of every public listing (`buildBaseProductFilters`):
  a product with a variant that is a component of a combo is not listed. The rule is in the count and page SQL, before the
  page is cut, so counts, cards and pages agree. The banner's candidate discovery applies the **same** rule: the banner
  links to this listing, so an offer whose only candidate is hidden here would lead to an empty page. A campaign whose
  addable products are all component-only is therefore not advertised at checkout (the component can still be bought
  from its own product page; only the upsell no longer proposes it).
- **Rate limits.** Page 1 keeps the existing budgets (10 a minute browse bucket, plus the 20 a minute budget shared with the
  banner's POST), so a GET can never exhaust the banner's POST budget. Page 2 and later use a separate bucket
  (`checkout-upsell-page-client`, 30 a minute): paging through a large scope does not trip the first-page limit or spend the
  banner's budget, and the quotes one client can cause per minute (10 + 30, one each) stay below what the first-page budget alone
  allowed when a view ran up to eight (80). The trusted-request check, the cart check and the read gate apply to every page.
  A scope beyond 30 pages (721 products) cannot be paged through in one minute; that is accepted.
- **No per-product quote, so no budget, soft deadline, cache or cache key.** Cost is one quote plus two indexed SQL
  statements regardless of catalog size. The cards are read fresh on every request, so price and stock are as fresh
  as on any listing; the page refreshes on the catalog's own promotion window.
- The page no longer says each product was "checked against the current cart". It says the products belong to the
  offer and that price, stock and entitlement are recomputed when added. `add` re-verifies under locks, as before, so
  a product that does not actually unlock the offer is refused there with no write.

## Removed

The browse mode of `recommend`, `getBrowse`, the browse cache and its key inputs (gift-choice digest, promotion
revision, next campaign start/end query and its session-time-zone handling), the banner seeding of that cache, and
their tests (BR-01…BR-16). The banner is back to a bounded quote only: it no longer reads cache-key inputs or a
campaign boundary on the checkout path. The ADR 0022 error classification (`UpsellQuoteUnavailable` conversion,
transient read failures staying retryable, a +1 candidate that cannot be evaluated being skipped) is kept and now
also serves `getScope`.

## Consequences and limits

- The page can show a product that will not unlock the offer for this cart (sold out, a stacking conflict, a
  composite sharing stock). It is a listing of the offer's scope, not a promise per product.
- Metrics: `promotion_upsell` gains `event: "scope"` (`offered` / `empty` / `failed` / `timed_out`; quote and SQL only; `offered` only when the page has at least one product, so the rate is the share of listings that show something)
  and `event: "hydrate"` (`offered` / `failed`; the catalog read for the page's cards), so end-to-end latency is the sum
  of the two; the `browse` event and the `partial` / `cached` outcomes no longer exist.
- Product-list analytics events are not emitted for this page (as before); selecting a card still opens the PDP.
- Rollback is unchanged: `LA_PROMOTION_UPSELL_ENABLED=false`.
