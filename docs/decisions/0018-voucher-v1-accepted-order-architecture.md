# ADR 0018: Voucher v1 — durable website-accepted state, immutable quote and exactly-once consume

- **Status:** **Accepted** — the owner approved gates **H1-D** (accepted-order / POS design) and **H2** (additive voucher schema, accepted marker, immutable quote, cart selection storage, rollback) on 2026-10-25 ("duyệt H1-D, H2 theo ADR 0018"). It is **not** an approval to call Pancake, to grant holds, or to enable anything; H1-V, H3-D/H3-V, H4 and H5 remain open.
- **Date:** 2026-10-25
- **Task:** V00 of [`tasks/storefront-voucher-v1-plan.md`](../../tasks/storefront-voucher-v1-plan.md).
- **Governs:** [`docs/specs/storefront-voucher-v1.md`](../specs/storefront-voucher-v1.md) §3.2, §5.1–§5.3, TG-01, TG-03, TG-04.
- **Companion:** [`docs/integrations/pancake-voucher-acceptance.md`](../integrations/pancake-voucher-acceptance.md) (POS exact-money fixtures and the operator probe boundary).
- **Does not decide:** column names (the spec says a proposal is not a column approval), POS sandbox probes (separate operator authorization), production enablement (H5 / `/ship`).

## Context (read from main@0b6be20)

| Fact | Where | Consequence |
| --- | --- | --- |
| `OrderMirror.state` is `DRAFT → VALIDATING → POS_SUBMITTING → CONFIRMED / REJECTED / SYNC_UNKNOWN`. A DRAFT is written at validation time and may be repriced and superseded. | `prisma/schema.prisma` `LocalOrderState` | **Inserting or reading a DRAFT cannot be the Q33B "website accepted" moment** (spec §5.2). |
| `OrderQuoteSnapshot` is 1:1 with the order (`orderId @unique`, `onDelete: Restrict`) and already stores digest, totals and `vendorProjection`. | `OrderQuoteSnapshot` | The immutable quote already has a home; what is missing is a rule that nothing may change it once accepted. |
| `VariantCapacityReservation` is unique per `(orderId, variantId)`; the submit service reserves capacity (`reserveOrderCapacity`) before the POS call and moves it `RESERVED → SUBMITTING → COMMITTED / RELEASED / UNKNOWN`. | ADR 0014, `guest-checkout-submit.ts` | Capacity is decided before anything reaches Pancake; the voucher consume must come after a successful reservation, never before. Where exactly the accepted marker sits relative to the `SUBMITTING` transition is an open H1-D item. |
| Pancake status is stored as a raw `pancakeStatus Int` with no mapping to "cancelled". | `pancake-order-status-reconciliation.ts` | A trusted cancel signal does not exist yet (TG-04). |
| Anonymous carts are server-side `Cart` rows (with `expiresAt` and a `paidRevision` ABA guard) reached through an HttpOnly cookie. | `prisma/schema.prisma` `Cart`, `anonymous-cart-*.ts` | Voucher intent (AUTO / manual / NONE / validated code) can be stored against the cart row without a new client token. |

## Decision

### D-1 Accepted marker: a separate, insert-only `OrderAcceptance` record

A new 1:1 record (`orderId @unique`, `acceptedAt`, `quoteDigest`, frozen voucher references) is the **single, durable "website accepted" marker**. Rejected alternatives:

- *New `LocalOrderState.ACCEPTED`*: widens an enum every state reader, the reconciliation worker and the Meta purchase gate switch on; an older deployment meeting the value is a rollback hazard.
- *Nullable `websiteAcceptedAt` on `OrderMirror`*: additive and simple, but it puts a write-once field on the hottest mutable row and makes "was this order accepted" depend on a column that ordinary updates also touch.

A separate table is additive, ignored by old code, rolled back by dropping the table, and its row can be **insert-only by construction** (no `UPDATE` path, `onDelete: Restrict`). Final shape is for H2 to approve; the invariants below are what any shape must satisfy.

### D-2 Immutability is enforced by the database, not by convention

Once an `OrderAcceptance` row exists for an order, the database rejects `UPDATE`/`DELETE` on that order's money-bearing rows: `OrderMirror` money columns (`merchandiseSubtotalVnd`, `shippingFeeVnd`, `totalVnd`, shipping provenance), `OrderLineSnapshot`, `OrderQuoteSnapshot`, `OrderQuoteLine`, `OrderQuoteEntitlement`, and the voucher snapshot. State, Pancake identifiers and sync fields stay writable — the order still has to move through `POS_SUBMITTING → CONFIRMED / REJECTED / SYNC_UNKNOWN`. Before acceptance nothing changes: a DRAFT remains repriceable exactly as today. Application code that tries to reprice an accepted order fails closed instead of silently succeeding (spec §5.2, AC-38). A PRICE_CHANGED answer from Pancake on an accepted order ends in reject/reconcile with a refund and a **new** checkout attempt, never an in-place reprice.

### D-3 Transaction order: reserve stock, then accept + consume in one transaction

```text
1  verify signed submit-capable proof, hold ownership, cart revision        (read-only checks, no writes)
2  reserve capacity (existing VariantCapacityReservation, ADR 0014)         (may fail: out of stock / lock timeout)
3  ── one DB transaction ───────────────────────────────────────────────
   3a re-check hold: HELD, owner, voucher+revision, expiresAt > now() (DB clock)
   3b insert OrderAcceptance (unique orderId)       → replay/2-tab hits the unique key
   3c hold → CONSUMED; insert VoucherRedemption (unique orderId+kind); move reserved→redeemed counters
   3d freeze quote snapshot + voucher snapshot (already written, now protected by D-2)
   ───────────────────────────────────────────────────────────────────
4  after commit: submit the stored vendor projection to Pancake
```

| Failure point | Required outcome |
| --- | --- |
| Step 2 fails (stock, lock timeout) | No acceptance, hold untouched (still `HELD` until its own expiry), voucher not consumed, **no POS write**. |
| Crash/rollback inside step 3 | Whole transaction rolls back: no marker, hold still `HELD`, counters unchanged. Capacity reservation is released by the existing reservation sweeper. |
| Crash after step 3, before step 4 | Order is accepted and consumed; POS submit is retried from the frozen projection by the existing submit/reconcile path. Voucher is **not** refunded. |
| Step 3b unique violation (replay, double-click, two tabs, A→B→A) | The loser reads the winner's order and returns it; exactly one redemption exists. |
| Hold expired at or after `expiresAt` | Step 3a rejects; hold is released idempotently; buyer must re-quote and confirm (spec §5.1, AC-32). Expiry is checked inside the transaction against the database clock, never a cleanup job. |
| Pancake `REJECTED` with evidence the order was not created | Refund once (D-4); buyer starts a new attempt. |
| Pancake timeout / `SYNC_UNKNOWN` | Stays consumed and pending; alertable; **no** refund, **no** purchase analytics until `CONFIRMED`. |

### D-4 Refund is a compare-and-set on the redemption, from a trusted signal only

`VoucherRedemption.refundedAt IS NULL → now()` in one statement; a duplicate or out-of-order event matches zero rows and changes nothing. Triggers: a definitive reject with evidence, a verified cancellation from Pancake reconciliation (after the status mapping in the companion doc is proven, TG-04), or an authenticated Admin cancel with audit. A refund returns quota and budget to the ledger; it never reactivates an expired or disabled campaign. Ambiguous status, network error or an unmapped code means *pending reconciliation*, never refund.

### D-5 Cart-bound selection storage

Voucher intent (AUTO / manual id / explicit NONE / validated PRIVATE code, per group) is stored **server-side against the anonymous cart row**, with an expiry, so it survives PDP → cart → checkout and reload without any code in the URL, a client cookie or analytics (spec §8). It stores intent only: no money, no hold. Selection actions never touch quota or budget. Whether this is a new table or columns on the cart row is an H2 choice; a new table is preferred for the same additive-rollback reason as D-1.

### D-6 Flag OFF settles, it does not strand

`LA_VOUCHER_ENABLED` unset or not exactly `"true"` stops **new** campaign reads, selections and holds. Consume, reconcile and refund of already-granted holds and redemptions keep running (TG-05 A, AC-47). The gate therefore must not wrap the settle path.

## Consequences

- V04 can be written against these invariants once H2 approves a shape, and V13 consumes a marker that already exists instead of inventing one.
- Two database triggers (or an equivalent constraint mechanism) are required by D-2; H2 must approve them explicitly because they are the part most likely to surprise a future maintainer.
- No existing order, enum or reader changes; historical orders have no acceptance row and are simply "not voucher orders".

## Review checklist for H1-D / H2

- [ ] The marker shape (D-1) and the immutability mechanism (D-2) are acceptable, including the writable-column list.
- [ ] Step 2 precedes step 3 against the real submit service: `reserveOrderCapacity` runs before the POS call today; confirm where `beginSubmitting` sits relative to the accepted marker when V13 is scoped (this ADR changes no runtime file).
- [ ] The failure table has no missing row for the current submit service.
- [ ] Rollback: dropping the new tables and triggers leaves old code and historical orders untouched.

## Implementation notes (V04, migration `20261025100000_voucher_v1_additive`)

Where the migration made a choice this ADR left open:

- **Marker shape:** a separate insert-only `OrderAcceptance` table, as recommended (D-1). Its insert trigger additionally requires the order to already have an `OrderQuoteSnapshot` whose `quoteDigest` equals the marker's, so "accepted" always names the immutable quote it froze.
- **Immutability (D-2):** one trigger function guards `OrderMirror` money columns (`merchandiseSubtotalVnd`, `shippingFeeVnd`, `totalVnd`, the shipping provenance columns), `OrderLineSnapshot` and the four quote tables, for INSERT/UPDATE/DELETE once an `OrderAcceptance` row exists, whatever the order state. State, Pancake identifiers and sync fields stay writable. Historical orders have no marker and are untouched (tested).
- **Ledger:** `VoucherCampaign.redeemed*/reserved*` with CHECKs for the committed floor; `VoucherHold` with an absolute-TTL CHECK, a partial unique index for one live hold per attempt and kind, and a guard that consumes only before expiry by the database clock; `VoucherRedemption` append-only with a one-way refund.
- **Selection (D-5):** `CartVoucherSelection`, one row per cart, `ON DELETE CASCADE`, voucher ids deliberately not foreign keys.
- **Campaign rows are complete at rest.** The CHECKs require a fully valid configuration even for an inactive draft (as `ShippingPromotionCampaign` does); the Admin form validates before saving, so an unfinished form is not persisted.
- **Rollback:** the `DROP` list at the top of the migration; safe only while no accepted order references the tables.

## Implementation notes (V13, migration `20261026100000_voucher_order_snapshot`)

- **Where step 3 runs:** inside the existing write-boundary transaction of the submission service (`acceptAtWriteBoundary`), after the order is `POS_SUBMITTING` and as its last statement, not before. The shipping provenance columns are written by that same update and are part of what freezes, so acceptance cannot come earlier. A refusal throws to roll the transaction back; the order is then closed `REJECTED` with `VOUCHER_REQUOTE_REQUIRED` and its reservations released (nothing was sent).
- **Step 3d, "voucher snapshot (already written)":** the first migration had no storage for it. `OrderVoucherSnapshot` (insert-only, DRAFT-only, immutable from acceptance) holds the V10 snapshot and is the order's declaration of what it carries. A HELD hold cannot be bound to an order (`VoucherHold_state_check` requires `orderId` NULL until CONSUMED), so the declaration lives on the order side; acceptance matches it to the attempt's live holds by campaign, revision and amount.
- **Plain orders** (no declaration) pass through untouched and never read the secret; a declared order is either consumed or refused, never accepted as plain.
- **Consistency link:** acceptance recomputes the PREVIEW digest from the order's frozen quote rows and compares it with the digest every hold stored. It covers paid segments, the number of gift slots (not the gift variation), money, vouchers and `paidRevision`.
- **Held entitlements survive campaign edits (TG-05 A):** the hold's own campaign revision and amount are consumed, whatever the campaign says now; the flag and verified-shop list are never read.

## Implementation notes (V18 server core, migration `20261026120000_order_quote_step_voucher`)

- **One derivation.** Checkout applies exactly the live holds of the cart's own attempt, inside `resolveBenefitCheckoutQuote`, which the checkout render, the DRAFT step and the POS re-derivation already share. Holds whose promise (voucher ids and revisions, amounts, quote digest, `paidRevision`, shipping fee) no longer matches the freshly derived quote are never applied; the cart is priced without them and flagged `voucherStale`.
- **Representation.** A merchandise voucher is the last step (`source: VOUCHER`) of each paid line it touched, so the stored ledger still walks base price to paid price and the vendor projection needs no new code. The gifts and entitlements are evaluated again on the post-voucher groups by the same authority the cart uses. A shipping voucher is `shippingWaivedVnd`, applied after the shipping engine's decision.
- **Schema.** One check constraint (`OrderQuoteDiscountStep_source_check`) now admits `VOUCHER`. Rollback is only safe while no such step exists.
