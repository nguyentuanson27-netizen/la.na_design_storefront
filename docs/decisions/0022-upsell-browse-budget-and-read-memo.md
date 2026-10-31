# ADR 0022 — Upsell browse budget, banner-seeded cache and read memo

Status: **phases 1 and 2 (browse budget, banner-seeded cache) are superseded by
[ADR 0023](./0023-eligible-offers-scope-listing.md)**, which lists the whole offer scope instead and removes that
code. Phase 3 (read memo) and the quote-error classification below still apply. Amends the "U-03 budget and
measurement boundary" section of [ADR 0017](./0017-smart-promotion-upsell-implementation.md). No schema, flag,
dependency or checkout-path change.

## Evidence that triggered this

Container log `la-na-design-app-preview`, 22:28–22:32. On `/checkout` the banner (`quoteAttempts: 6`) was
offered in 1,322 ms. On `/offers/eligible` the browse read (`quoteAttempts: 11–16`) ended at the 2,000 ms
deadline with `outcome: 'timed_out'` every time, and the page showed "offer changed". ADR 0017 had already
flagged that fixture latency (~25 ms per quote) was not a live-catalog measurement; the preview showed
~100 ms per quote plus ~700 ms fixed cost, about 4× the fixture.

Root causes, all in the browse path only:

1. Browse spent a 20-quote budget against the same 2 s deadline the checkout path uses.
2. At the deadline the loop `throw`ed and discarded every candidate already verified.
3. The transaction timeout equalled the deadline, leaving no margin.
4. The page re-renders every 60 s (`StorefrontPromotionRefresher`), repeating the full computation.
5. Every quote re-read campaign, target, policy and option rows that cannot change inside the snapshot
   (a profile showed ~58 SQL statements per quote on the fixture).

## Decision

### Phase 1 — browse reads stop early and degrade to a shorter list (`mode === "browse"` only)

| Setting | Before | After |
| --- | --- | --- |
| Quote budget | 20 | `UPSELL_BROWSE_MAX_QUOTES = 8` |
| Early stop | none | `UPSELL_BROWSE_TARGET_PRODUCTS = 3` distinct verified products |
| Deadline | 2,000 ms, throw | `UPSELL_BROWSE_SOFT_DEADLINE_MS = 1,300`: stop and return what is verified |
| Transaction / statement timeouts | 2,000 / 1,800 ms | unchanged (≥ 500 ms margin) |

Three products fit one row of the three-column grid. The loop still visits one size per product before a
second size, so early stop means a product may list only its first verified size. Every listed size
still has its own server quote; nothing unverified is shown.

Timeout or a transient failure with nothing verified returns `retryable: true`, and the page then says the
suggestion is loading slowly and offers a plain-anchor retry (a full server render) instead of "offer
changed". A cart with no valid quote (sold-out paid line, invalid gift setup) is a normal empty result
(`retryable: false`, outcome `empty`): retrying cannot change it and costs rate limit. `readCartGiftState`
refuses carts it cannot price or evaluate with three plain `Error`s ("Quote unavailable", "Invalid gift
configuration", "Options bound exceeded"); `snapshot` re-throws them as `UpsellQuoteUnavailable`. For the paid
cart that is the empty result above. For one hypothetical +1 cart, `verifyCandidate` already skips on
`UpsellQuoteUnavailable`, so that candidate is dropped and the loop goes on instead of discarding candidates
already verified (BR-12). On `add`, such a +1 cart is now rejected as `QUOTE_CHANGED` (no write) rather than the
generic `OFFER_UNAVAILABLE` failure.

`resolveBenefitCheckoutQuote` also turns any exception from its data reads (state, vouchers, shipping) into
`UNAVAILABLE`, which on its own cannot tell a dropped connection from a cart that cannot be quoted. It now takes an
optional, observation-only `onError` callback, invoked just before those `UNAVAILABLE` returns; it never changes a
returned value, and checkout and the POS submit pass nothing. `snapshot()` uses it: a `RangeError`/`TypeError`
(the cart's own shape) or one of the three known messages stays `UpsellQuoteUnavailable` (empty, not retryable);
any other exception is rethrown as itself, so browse reports `retryable: true` and logs `failed`. Unknown errors
therefore default to retryable, a bounded cost since reads are rate-limited (BR-14). A failure before
the cache lookup is logged as `event: "browse", outcome: "failed"`, so staging logs account for every
request. An empty result with no failure keeps the old message. Metrics gain `event: "browse"` and
`outcome: "partial" | "cached"`, so banner and browse are separable in logs. `get` and `getBanner` are
unchanged.

### Phase 2 — the banner seeds a short-lived, cart-scoped browse cache

- Key: `paidCartKey : promotionPricingRevision : giftChoicesDigest : campaignId`.
  - `paidCartKey` is the existing HMAC over the cart id and paid revision, so any paid-line change
    (including A→B→A) is a different key and no cart id is held in memory.
  - `PromotionPricingRevision.current` advances on every effective campaign edit, enable or disable (the
    same row `add` locks), so those are a different key too.
  - The cart's gift choices do not advance `paidRevision`, yet a "+1" candidate must preserve them, so a
    short digest of `CartGiftSelection` rows is part of the key (BR-11).
  - The banner reads the inputs inside the quote's snapshot. `getBrowse` reads them with the cart before the
    lookup (three single-row/indexed reads), but that is a different transaction from the quote. Gift choices
    can return to an earlier value (A→B→A), so a key that is merely older than the data is not harmless: the
    quote's own snapshot recomputes the key, and the list is stored only if it equals the key looked up
    (otherwise the request is still answered with the fresher list, just not cached) (BR-13).
- The banner seeds the cache only when its verified list already has the browse target (3 products). It spends 6
  quotes where browse may spend 8, so a shorter list is not pinned for the TTL when browse could fill the row
  (the same rule as for a partial run); the cost is a recompute on that visit, bounded by phase 1 (BR-16).
- Each entry also expires at the next campaign **start or end** among enabled gift/tier, flash-sale price and
  shipping campaigns (one query per computed list). Nothing is written when a scheduled campaign becomes
  active, so no revision can signal it (BR-10 asserts the start writes nothing); a list never outlives the
  campaign set it was verified against. Gift/price campaigns store `timestamp(3)` (a UTC wall clock) and shipping
  `timestamptz(3)`; a plain UNION of the two is converted in the database session's TimeZone, and with the old SQL a
  `Asia/Bangkok` session missed a shipping campaign's start (BR-15 failed with it, 25 s early boundary reported as
  40 s). The query now declares the `timestamp` columns UTC with `AT TIME ZONE 'UTC'` and exchanges "now" and the
  result as epoch milliseconds, so it depends on neither the session TimeZone nor the driver's date parsing. Other
  raw SQL in the codebase still assumes a UTC session; that is out of scope here.
- Value: the already-public browse view (offer name, slug, name, image, option labels). The banner
  response shape is unchanged; seeding happens inside the service.
- TTL 150 s (2.5× `MAX_STOREFRONT_PROMOTION_REFRESH_MS`), 500 entries, single-flight for identical
  concurrent loads, per-process (a second instance simply misses and computes). A TTL equal to the 60 s
  page refresh would expire just before every periodic render, so the first two refreshes of an open page
  hit and only every third recomputes. Partial (soft-deadline) and failed results are not stored, so a
  retry recomputes.

#### Freshness contract

- **Campaign state** (disabled, edited, published, ended, or a scheduled campaign starting) and **gift choices**:
  the next render recomputes, so a visible page stops introducing products within one refresh (≤ 60 s, the
  storefront bound). Tested by BR-08 (admin path advancing the revision), BR-09 (`endsAt`), BR-10 (`startsAt`
  with no revision write) and BR-11 (gift choice on unchanged paid lines).
- **Catalog drift** (stock, product publication, price sync) is the only thing the key cannot see. It is
  bounded by the TTL: an entry is at most 150 s old when served, and a page that shows it is replaced at
  its next refresh, so a visible list can reflect catalog state up to ~210 s old in the worst case (served
  at 149 s, replaced one 60 s refresh later). This is a deliberate exception to the 60 s bound for a
  names-and-links list; the page copy already says price, stock and entitlement are recomputed on add, and
  `add` re-verifies under locks, so it cannot move money or entitlements. **Accepted by the repository
  owner on 2026-10-30 (PR review of this change): keep TTL 150 s**, so an open page recomputes once in
  three refreshes. Should catalog drift ever need to fit inside 60 s, set `UPSELL_BROWSE_CACHE_TTL_MS` to
  60 s: every periodic refresh then recomputes (bounded by phases 1 and 3), which is the pre-cache
  behaviour.

### Phase 3 — transaction-scoped read memo for the read-only paths

`memoizeTransactionReads` wraps the interactive transaction in `recommend` and `requote` (never `add`).
Inside a REPEATABLE READ snapshot an identical Prisma model read returns identical rows, so the second and
later candidate quotes skip the campaign/policy reads and only issue candidate-specific queries.
Results are deep-frozen: a caller that mutates a shared row throws, the optional read fails closed and a
test fails, instead of corrupting another quote. Raw SQL and writes pass through untouched.

Fixture measurement (33 products, 3 sizes; same machine, before → after):

| Path | SQL statements | Duration |
| --- | --- | --- |
| Banner, 6 quotes | 392 → 242 | 223 → 163 ms |
| Full model, 20 quotes | 1,162 → 616 | 572 → 352 ms |
| Browse after banner | recompute | 3 single-row reads (cart, revision, gift choices), ~7 ms, plus the route's own rate-limit reads |

About 29 statements per quote remain. They are candidate-specific (the cart changes), plus empty `IN (NULL)`
reads Prisma issues for empty id lists and the stock/held reads in `verifyCandidate`. Removing them needs a
refactor of `readCartGiftState`/`resolveBenefitCheckoutQuote` with full money-parity coverage; that is
deliberately out of this PR.

## Not claimed

Fixture numbers are not live-catalog numbers. The ~700 ms fixed cost and the per-quote cost on the real
catalog must be re-measured in staging with `promotion_upsell` logs before any pilot: expect browse
`durationMs` < 1,500 ms, `quoteAttempts` 3–8 and no `timed_out`. Rollback is the existing
`LA_PROMOTION_UPSELL_ENABLED=false`; the cache and memo carry no state outside the process.
