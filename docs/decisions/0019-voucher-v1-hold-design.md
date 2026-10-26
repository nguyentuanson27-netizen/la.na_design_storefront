# ADR 0019: Voucher v1 — 10-minute hold design (input for gate H3-D)

- **Status:** **Accepted** — the owner approved gate **H3-D** on 2026-10-26 ("duyệt adr0019"). This lets V11 (atomic holds) be built to this design. It does **not** approve granting a hold in production: V12 still needs H1-V, V13 needs H3-V, and `LA_VOUCHER_ENABLED` stays OFF until V18 ships.
- **Date:** 2026-10-25
- **Task:** V11/V12 of [`tasks/storefront-voucher-v1-plan.md`](../../tasks/storefront-voucher-v1-plan.md).
- **Builds on:** [ADR 0018](./0018-voucher-v1-accepted-order-architecture.md) (accepted marker, reserve-then-consume), the approved schema (`VoucherHold`, `VoucherCampaign` ledger, migration `20261025100000_voucher_v1_additive`), `voucher-quote-proof.ts` (`lav1`) and `pancake-voucher-projection.ts`.
- **Governs:** spec §5.1, §5.1.1, TG-03, TG-05 A, TG-12, AC-14..16, AC-31..34, AC-42/43, AC-45.

## What is already enforced by the database (so the service cannot get it wrong)

| Rule | Where |
| --- | --- |
| TTL is exactly `createdAt + 10 minutes`; no rolling renewal; identity, amount and expiry never change | `VoucherHold_values_check`, `voucher_hold_guard` |
| One live (`HELD`) hold per `(attemptKey, kind)` | partial unique index `VoucherHold_live_attempt_kind_key` |
| A hold cannot be consumed at or after `expiresAt`, by the database clock; a live hold cannot be marked expired early; a settled hold is final | `voucher_hold_guard` (`clock_timestamp()`) |
| `redeemed + reserved` never exceeds `maxUses` / `maxBudgetVnd`, so a grant that would oversubscribe fails and an Admin cap under the floor fails | `VoucherCampaign_quota_check` |
| A redemption needs a consumed hold of the same order/kind/campaign/amount and an accepted order; refund is one-way | `voucher_redemption_guard` |

The service therefore only has to **sequence** these, not re-implement them.

## Decisions to review

### D-1 Grant transaction and lock order

```text
0  (outside any lock) recompute the preview from the cart, then run the pure POS predicate (V09) on each candidate
   combination; keep only feasible ones. An infeasible combination is never locked, held or signed (AC-20).
1  BEGIN
2  lock the cart row (FOR UPDATE) and read paidRevision        -- the same lock cart and selection writers take
3  lock the chosen VoucherCampaign rows FOR UPDATE, in ascending id order   -- merchandise and shipping together
4  lazily expire: HELD holds of those campaigns with expiresAt <= now() -> EXPIRED, and give their uses/VND back
5  for each chosen voucher: skip the capacity test if THIS attempt already holds it (self-held), else require
   free uses >= 1 and free VND >= discount; then reservedUses += 1, reservedVnd += discount   (CHECK is the backstop)
6  insert the hold(s) with createdAt and expiresAt both taken from ONE database timestamp
7  COMMIT, then sign the HELD `lav1` proof over the new facts
```

- **Ascending id order across both groups** makes two checkouts that pick the same pair of vouchers deadlock-free. Admin edits take the shop advisory lock first and then the campaign row (V06); a grant never takes the advisory lock, so there is no cycle.
- **One database timestamp** (`WITH t AS (SELECT date_trunc('milliseconds', clock_timestamp()) AS now) INSERT … SELECT … t.now, t.now + interval '10 minutes'`) keeps the application clock out of the TTL; the consume guard also uses the database clock, so there is no skew between "granted" and "expired".
- **Lazy expiry in step 4** means an abandoned checkout never blocks capacity, with or without the background sweeper. The sweeper is a convenience that keeps the table small; correctness does not depend on it (spec §5.1: "worker cleanup không là nguồn xác thực TTL").

### D-2 Idempotency, reload and swap

- Key: `(attemptKey, kind)` where `attemptKey` is the HMAC of the cart id (`checkout-attempt-key.ts` style), so the cart id is never stored or logged.
- **Same attempt, same quote digest and campaign revision** → return the existing hold and its original `expiresAt`; nothing is extended (AC-16, AC-33).
- **Same attempt, different quote** (cart changed, voucher swapped) → in the same transaction release the old hold (`RELEASED`, counters returned) and acquire the new one; if the new grant fails, the old hold is **kept**, the buyer is told the new total and must confirm, and the old proof is already stale because `paidRevision` is in the facts (AC-34).
- Two tabs / double submit race on the partial unique index; the loser reads the winner's row.

### D-3 Self-held precedence (EX-08, AC-31)

On submit, a hold is honoured iff it is `HELD`, belongs to the attempt, `now() < expiresAt` (database clock), and its campaign id, **locked revision**, discount and quote digest equal the signed facts. When all match, the campaign being expired, disabled, edited or at zero free quota is **not** consulted (TG-05 A). Anything else is a re-quote. Stock, price base, shipping policy and POS feasibility are still checked; they are not guaranteed by a hold.

### D-4 Read-only GET, intentional POST (TG-12)

`GET /checkout`, RSC, `<Link>` prefetch, hover, reload and the picker preview call only `readVoucherPreview` (a repeatable-read transaction that writes nothing). The only entry that can grant is a **Server Action POST** from a buyer click (cart CTA, picker "Áp dụng", or "Đặt hàng"), which carries the origin check Next gives every Server Action, is idempotent per D-2, and is throttled (below). The UI says "Đã giữ ưu đãi đến HH:MM" only after the action returns a `HELD` proof; before that it says "Dự kiến".

### D-5 Anti-flood

Hold grants share the `rateLimit` table pattern used for codes: a per-cart bucket and a per-shop bucket, counted on every attempt. A cart can hold at most one voucher per group at a time (the partial unique index), so abandoning checkouts cannot stack holds on one cart; a flood of fresh carts is bounded by the shop bucket and by each hold's 10-minute self-expiry.

### D-6 Real holds stay OFF until the POS gate is evidenced (H1-V)

Beyond `LA_VOUCHER_ENABLED`, granting requires the shop to be listed in a new `LA_PANCAKE_VOUCHER_VERIFIED_SHOP_IDS` (same pattern as `LA_PANCAKE_LINE_LEVEL_PRICING_VERIFIED_SHOP_IDS`), set only after the operator-run sandbox probe of [`docs/integrations/pancake-voucher-acceptance.md`](../integrations/pancake-voucher-acceptance.md) §4 passes. Without it the service answers "preview only" and issues no hold and no `HELD` proof.

### D-7 Settle path ignores the flag

Consume, release, expiry and refund of existing holds and redemptions never consult `LA_VOUCHER_ENABLED` (ADR 0018 D-6, AC-47).

## What H3-V must show before checkout exposure (V13/V18)

Real-database tests, not mocks: quota = 1 with two simultaneous grants → exactly one; budget exhaustion; Admin cap edit racing grants (AC-45); natural campaign expiry at T+3 with submit at T+5 honoured, T+10 refused (AC-31/32); reload and two tabs return the same hold and `expiresAt`; a swap that fails keeps the old hold; GET/prefetch/hover/reload leave `reservedUses`, `reservedVnd` and the hold table unchanged and never start a timer, proven in a production-mode browser run (AC-42); POST grants once and is idempotent (AC-43); an infeasible candidate produces zero holds.

## Review checklist for H3-D

- [ ] Lock order (D-1) is acceptable, including "grant never takes the shop advisory lock".
- [ ] Lazy expiry inside the grant transaction is acceptable as the capacity authority.
- [ ] One-database-timestamp insert (D-1) is acceptable for TTL.
- [ ] Swap failure keeps the old hold (D-2).
- [ ] The extra verified-shop gate (D-6) is the right way to keep holds OFF before H1-V.

## Implementation notes (V11, `src/commerce/voucher-hold-service.ts`)

- **Order of locks:** cart row, then campaign rows in ascending id, then the attempt's hold rows. Hold rows are only *peeked* (no lock) to learn which campaigns are in play and are locked after the campaigns, because the sweeper takes campaign then holds; taking hold-then-campaign anywhere would be a cycle. A test with the sort removed produces a real `deadlock detected`.
- **All or nothing per call:** a pair of vouchers is quoted as a pair, so one refusal rolls back the whole call; a failed swap therefore keeps the old hold (D-2) without any compensating write. Explicit `releaseKinds` covers "NONE" / a combination without that group.
- **Self-held credit:** capacity is tested with the attempt's own live hold on the same campaign credited back, so a full campaign can still swap the buyer's own entitlement (D-3).
- **Cart revision:** `paidRevision` is checked on the locked cart row only when something is granted; a pure release does not need it.
- **Gate:** `canIssueNewVouchers` then `LA_PANCAKE_VOUCHER_VERIFIED_SHOP_IDS` for any call that grants; release, the sweeper and the honour read (`findHonourableHold`, for V13) never read either.

## Implementation notes (V12, `voucher-hold-flow.ts` / `voucher-hold-actions.ts`) — revised after the H3-V review

- **Order inside the POST:** gates, per-cart and per-shop throttle (own keys, `voucher-hold-*`, so spending hold budget never spends the code budget), the buyer's **own live holds** are read, the read-only preview is recomputed with them in play, the quote digest is compared, consent is checked, `canProjectExactMoney` runs on the exact vendor lines, then the atomic hold. A refusal at any step leaves no hold, no budget and no proof.
- **Own holds stay in play (review P1-1, TG-05 A / AC-31 / AC-33):** `readVoucherPreview({ ownHolds })` loads each campaign the attempt holds whatever its lifecycle (ended, switched off, full), credits back the use and VND the hold itself reserves, and keeps a PRIVATE one only while the shopper's manual choice still names it. A campaign edited since the hold (new revision) is **not** the held entitlement, so the retry swaps to the new terms instead of silently reusing. The picker read paths pass the same holds (`voucher-own-holds.ts`), so the digest the shopper sees is the digest the POST recomputes. Only a quote that genuinely selects no voucher releases a hold.
- **The buyer consents to a quote, not a total (review P1-2, AC-34):** the picker model carries `quoteDigest` (digest of the voucher ids and revisions, per-line prices, gift slots, shipping and total — `voucher-quote-facts.ts`); the Server Action takes `{ expectedQuoteDigest, acknowledged? }` and the server recomputes. Two different vouchers worth the same are different quotes (`QUOTE_CHANGED`, answered with the current digest and total). A quote that costs a gift or raises the total answers `CONFIRMATION_REQUIRED` with the amounts, and is held only with `acknowledged: true`.
- **No quota without a proof (review P1-3):** the HELD proof is issued by a `finalize` step **inside** the hold transaction. If it cannot be issued (size envelope, bad secret) the call rolls back: nothing is reserved, and a swap keeps its old hold.
- **What a hold's `quoteDigest` is:** the digest of the PREVIEW facts (the same facts without hold ids). A hold cannot name itself, and a submit recomputes the same PREVIEW facts to compare.
- **Gifts in the proof:** the proof binds the retained gift slot COUNT (a synthetic `gift-slots` GIFT line), not the chosen gift variation. **V13 must prove the voucher proof and the checkout/gift proof stay consistent**, including a buyer switching gift A to gift B at the same count, so an acknowledgement for the old gift is never reused.
- **Not covered by the hold:** a catalog price change that does not move the cart's `paidRevision` is caught at submit by recomputation (V13), not by the hold; the hold guarantees the voucher entitlement, not the price base (D-3).
- **H3-V browser evidence (AC-42/43):** done with a test-only harness that exists only in a temporary worktree built from the commit under test (`tests/fixtures/voucher-hold-harness`, `pnpm voucher:hold-harness`); the official build is proved free of the route and of the hold action. See `docs/verification/storefront-voucher-v1-h3v.md`. **H3-V closes after CI is green on the head commit and the owner signs off.**
