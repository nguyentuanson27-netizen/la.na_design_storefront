# Smart Promotion Upsell v1 — implementation evidence

Base: `main@1aefe15a` (merged PR #171). Implementation follows the owner's explicit request to build
UP-00…UP-06 end to end, open a new PR, then request independent review. No deployment or production
flag change is included. Technical decision: [ADR 0017](../docs/decisions/0017-smart-promotion-upsell-implementation.md).

## Delivered behavior

- Default-OFF server gate requires both flags and the shop's verified POS line-level capability.
- All four gift/tier × quantity/subtotal cases use the existing canonical pricing/entitlement chain.
  Quantity must lack one unit; money uses the exact 80% boundary and its own pricing stage. A
  same-value next rung is not advertised as a new benefit.
- Batched, capped fixed/dynamic/global discovery, including descendants, explicit INCLUDE and
  exclusion precedence. Paid product IDs are excluded. Final ranking uses the payable delta with
  actual canonical shipping, then campaign/product/variant IDs. Display ≤5 models for one winner.
- Every offered size has a verified +1 quote. Selecting it re-verifies server-side before CTA becomes
  enabled. The estimate can be negative and never calls the paid item free.
- Atomic +1 verifies cart-bound, expiring intent and monotonic paid revision under cart, global
  promotion, catalog and capacity resource guards. No speculative write/reservation/order/POS call.
- Existing per-campaign line savings are compared on final segment quantities (inherited audit
  appliedQuantity can predate a later split). Gift entitlement/grantability and stored choices are
  preserved. Shared composite resources are checked against whole-cart demand.
- The existing checkout form and gift selection service/picker are reused. Fields remain mounted,
  proofs/totals/acknowledgement refresh, new gifts can be selected inline, skip is UI-only, and the
  same-attempt reload/quote refresh is distinguished from a new attempt or paid-cart revision.
- Aggregate latency/timeout, offered/empty and add/rejection telemetry; flag rollback documented.

## Verification executed locally

Runtime: Node 24.19.0, Next 16.3.3, Prisma 7.9.1; disposable PostgreSQL 18.4. CI uses PostgreSQL 16
and remains the target-version check. Package scripts were executed using pnpm with local dependency
verification/package-manager auto-switch disabled where needed; direct Node equivalents used the
same scripts and files. No application dependency or lockfile changed.

| Check | Evidence |
| --- | --- |
| Prisma generate/validate | Passed; additive migration applied to disposable local databases only. |
| Lint | Passed, 0 errors; 18 existing warnings, no new warnings. |
| Typecheck | Passed. |
| Production build | Passed. |
| Full database regression | 936 passed, 0 failed (484 seconds); PR169/checkout/capacity/admin regressions included. |
| Final focused Upsell DB | 22 passed, 0 failed; includes double click/two tabs/ABA, proof corruption/cross-cart/expiry, stock sync, category reassignment, global promotion and publication-only product locking through commit, recovery-key parity, scope/ranking/rungs/quote parity. |
| Full domain/integration | 3,241 passed, 1 intentionally skipped; one existing HTTP-smoke cleanup failed with ENOTEMPTY on `.next/dev`. That exact HTTP test then passed in isolation (85.7 seconds), without changing the unrelated script. |
| Final focused domain/PR169 | 52 passed, 0 failed; includes exact money boundaries, tied winners, inherited split ledger preservation, proof/context/expiry and the demonstrated old ABA gap. |
| Browser | 6 passed: variant re-quote/add/proof refresh + inline gifts preserve fields; skip/reload/ABA/new attempt; lost-response gift recovery; gift/Upsell mutual locking through delayed refresh; stale rejection; negative payable estimate. Keyboard and axe checks at 320/390/1280px; one checkout form, no horizontal overflow. |

Initial browser harness problems (missing runtime APP_DOMAIN, single-process Chromium context
shutdown, and a mobile selector targeting the hidden desktop summary) were corrected in the harness;
all four scenarios subsequently passed. They are not counted as application acceptance evidence.
The review follow-up runs all six scenarios on the isolated dev server used by CI. Local font
downloads were unavailable, so the final local run used Next's Google Fonts test response hook with
local fallback faces; CI retains its normal font loading. The overlapping-campaign fixture was
corrected to include mutual gift stacking consent before the final six-scenario pass.

### Local budget measurement

33-product fixture with up to 3 sizes; capped discovery 10 products and 20 hypothetical quotes,
5 displayed models. With the final resource guard, three runs were 1,014 / 1,048 / 1,067 ms during
the full DB run. Read transaction deadline 2 seconds; SQL statement deadline 1.8 seconds. A blocked
campaign query is cancelled and returns no Upsell while the original checkout proof remains valid.
These are fixture measurements, not live-catalog or production percentile claims.

## Requirement traceability

| Group | Primary evidence |
| --- | --- |
| TG-01 flags/failure | Gate no-query DB test; cancelled recommendation SQL; stale browser flow. |
| TG-02 quantity | Gift +1, quantity tier +1 and equal-value rung DB tests; existing entitlement/cap tests. |
| TG-03 money | Exact BigInt 80% domain test; gift/order-tier threshold DB tests and PR169 regressions. |
| TG-04 stacking | Gift-loss rejection DB test; split-ledger per-campaign preservation test; PR169 full regression. |
| TG-05 winner | ID tie independent of priorities, winner-only models, canonical 30k→free shipping delta. |
| TG-06 catalog | Dynamic INCLUDE without membership, excluded/sold-out/paid product filters, fixed/descendant scopes, bounded fixture. |
| TG-07 variant price | Read-only variant re-quote DB test; S/M estimates and negative-delta browser tests. |
| TG-08 checkout add | Exactly one committed unit, no order/gift auto-choice; browser fields/proof refresh. |
| TG-09 proof/races | Durable revision and HMAC tests; global publish/catalog locks held through CartItem insert; stale and cross-cart refusals. |
| TG-10 gifts | Existing selection authority regression; new gift picker inside checkout without auto-selection. |
| TG-11 dismissal | Browser reload, A→B→A and client navigation to a new checkout attempt. |
| TG-12 accessibility | Native labelled selectors, keyboard add, explicit type=button, one form, axe at three widths. |

## Review and release handoff

Independent review is requested only after the completed implementation is pushed to the new PR.
Review/CI links and any resulting fixes are recorded on that PR. Local checks are not a substitute
for exact-commit CI or target-environment release acceptance.

### PR #172 review follow-up

- P2 publication race: lock sorted owning ProductMirror rows as well as variant resources through
  commit. DB tests cover disables that win before the re-read and publication-only writers blocked
  at the CartItem insert until commit (both paid and candidate products).
- P2 uncertain outcome: save the expected next opaque paid key and pre-add entitlement counts
  before sending the action. Recovery uses the current server gift model only when that key matches;
  no new schema or write authority is introduced.
- P2 overlapping transitions: track gift and Upsell pending states separately, combine them for COD
  locking, and lock each other's controls through the Server Action refresh. The shared gift hook
  also guards duplicate starts and clears pending notification on unmount.
- P1 CI setup: the Upsell spec now follows the existing `next dev` pattern with its own
  `.next-test/promotion-upsell` directory. It no longer assumes a production build from another job.

The first follow-up DB run had one fixture benchmark exceed the 2-second recommendation deadline
while local compilation was running. The sequential rerun passed all 22 tests; fixture timings were
1,013 / 1,095 / 1,453 ms. The deadline and fail-closed behavior were not relaxed.

Outstanding before production enablement:

- Approve and apply the additive paid-revision migration to the target environment; verify old/new
  application compatibility and the CartItem trigger. No online schema-drop rollback.
- Recheck bounded-pool quality and timing on the real shop catalog in staging.
- Confirm the real Pancake line-level contract for the shop; no live POS acceptance/write was run.
- Staging pilot with add/timeout/rejection metrics and flag rollback; approve rollout separately.

Rollback behavior by setting LA_PROMOTION_UPSELL_ENABLED=false. Keep both flags OFF by default.

### Eligible-offers browse timeout fix (ADR 0022)

Trigger: preview log showed `/offers/eligible` hitting the 2 s deadline (`quoteAttempts` 11–16) while the
checkout banner (6 quotes) took 1.3 s. Local verification on disposable PostgreSQL 16:

| Check | Evidence |
| --- | --- |
| Upsell DB suite | 36 passed, 0 failed (22 existing + 14 new BR-01…BR-14: early stop, soft-deadline partial, retryable timeout, banner-seeded cache + paid-revision invalidation, single-flight, sold-out paid line is empty not retryable, preflight failure is logged, campaign disable via the revision, `endsAt` cap, scheduled `startsAt` with no revision write, and a gift choice or swap through the real selection service each stop a cached listing; a candidate whose +1 cart cannot be evaluated is skipped, not fatal; a list computed under gift choice B is never cached under the key read for A; a transient shipping read failure is retryable while an unquotable cart is not). |
| New domain tests | 14 passed (browse cache TTL/LRU/single-flight, TTL outlives the 60 s page refresh; read memo hit/BigInt key/freeze/pass-through/no replay of failures). |
| Domain + integration | 3,788 passed, 0 failed, 1 skipped. |
| Lint / typecheck | Passed; no new warnings. |
| Profile (33 products × 3 sizes) | Banner 392 → 242 statements, 223 → 163 ms; full 20 quotes 1,162 → 616, 572 → 352 ms; browse after banner: cache hit = 3 single-row reads (cart, revision, gift choices), ~7 ms. |

Still required before enabling a pilot: repeat the preview check on the real catalog and confirm
`browse` events show `durationMs` < 1,500 ms with no `timed_out`.
