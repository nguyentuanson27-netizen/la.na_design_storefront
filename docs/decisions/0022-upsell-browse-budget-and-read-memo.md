# ADR 0022 — Upsell browse budget, banner-seeded cache and read memo

Status: implementation proposed for review. Amends the "U-03 budget and measurement boundary" section of
[ADR 0017](./0017-smart-promotion-upsell-implementation.md). No schema, flag, dependency or checkout-path change.

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

Timeout with nothing verified returns `retryable: true`; the page then says the suggestion is loading
slowly and offers a plain-anchor retry (a full server render) instead of "offer changed". An empty
result with no failure keeps the old message. Metrics gain `event: "browse"` and `outcome: "partial" |
"cached"`, so banner and browse are separable in logs. `get` and `getBanner` are unchanged.

### Phase 2 — the banner seeds a short-lived, cart-scoped browse cache

- Key: `paidCartKey:campaignId`. `paidCartKey` is the existing HMAC over the cart id and paid revision, so
  any paid-line change (including A→B→A) is a different key and no cart id is held in memory.
- Value: the already-public browse view (offer name, slug, name, image, option labels). The banner
  response shape is unchanged; seeding happens inside the service.
- TTL 60 s, 500 entries, single-flight for identical concurrent loads, per-process (a second instance
  simply misses and computes). Partial (soft-deadline) and failed results are not stored, so a retry
  recomputes. A browse result that computed fully is stored for later visits and refreshes.
- Staleness is bounded by the TTL and cannot move money or entitlements: the page is read-only and
  `add` re-verifies everything under locks. Disable with `browseCache: null`.

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
| Browse after banner | recompute | 1 statement, ~1 ms (cache) |

About 29 statements per quote remain. They are candidate-specific (the cart changes), plus empty `IN (NULL)`
reads Prisma issues for empty id lists and the stock/held reads in `verifyCandidate`. Removing them needs a
refactor of `readCartGiftState`/`resolveBenefitCheckoutQuote` with full money-parity coverage; that is
deliberately out of this PR.

## Not claimed

Fixture numbers are not live-catalog numbers. The ~700 ms fixed cost and the per-quote cost on the real
catalog must be re-measured in staging with `promotion_upsell` logs before any pilot: expect browse
`durationMs` < 1,500 ms, `quoteAttempts` 3–8 and no `timed_out`. Rollback is the existing
`LA_PROMOTION_UPSELL_ENABLED=false`; the cache and memo carry no state outside the process.
