# ADR 0014 — Atomic capacity, reservations and Pancake reconciliation

- Status: **ACCEPTED — architecture owner-approved 2026-09-16; persistence pending Checkpoint B**
- Date: 2026-09-17
- Scope: G5 architecture. No Prisma migration, no reservation implementation, no Pancake live write.
- Implements: master spec §27–§31. Feeds I1, I4, I5, I6a, I6b, I7, I8.

## Context

Master spec §31 forbids `read stock → compare → submit`. G2's controlled probe
(`docs/integrations/pancake-zero-negative-stock-capability-probe.md`) established why, on the
authorized test shop:

- an ordinary order is accepted at stock > 0;
- accepted at stock **0**;
- accepted when stock is **already negative**;
- **two concurrent requests at stock 0 were both accepted**;
- a 1:1 composite fixture decremented its children, and a child sitting at 0 went to **−1**.

Unproven by that run, and therefore not assumed anywhere below: arbitrary composite multipliers, a
component that starts negative, and multi-component atomicity.

The load-bearing conclusion is the concurrency one. **Pancake is not a concurrency or negative-limit
authority.** It will happily accept both halves of a race. So the local database is the only place
the owner's hard limit can actually be enforced, and it must be enforced *before* the external call.

What already exists on `main` and is reused rather than reinvented:

- `WarehouseStock.quantity` + `syncedAt` — mirrored Pancake stock per variant per warehouse.
- `LocalOrderState` — `DRAFT | VALIDATING | POS_SUBMITTING | CONFIRMED | REJECTED | SYNC_UNKNOWN`.
- `pancake-order-submit.ts` — already resolves an ambiguous create to `SYNC_UNKNOWN` with
  `CREATE_OUTCOME_UNKNOWN`, and already has marker-search reconciliation patterns from G2.
- `OrderMirror.pancakeOrderId @unique` — one Pancake order maps to at most one local order.
- `src/commerce/capacity-policy.ts` — the pure predicate this ADR specifies, landed with this ADR.

## Decision

**The local PostgreSQL reservation ledger is the authoritative capacity gate.** Pancake remains the
mirrored external stock truth and the system of record for the order itself, but it is never trusted
to enforce the limit or to serialize concurrent buyers.

---

## 1. Capacity quantity

For one variant, at one instant:

```text
capacity = mirroredStock − activeReservedQuantity
projectedCapacity = capacity − requestedQuantity
```

- `mirroredStock` — `SUM(WarehouseStock.quantity)` for the variant. May already be negative; that is
  a fact to preserve, never to clamp (master spec §29).
- `activeReservedQuantity` — the sum of quantities of reservations that still hold (§4).

**The reservation is allowed iff `projectedCapacity >= floor`**, where:

| Selling mode | Floor |
|---|---|
| `STANDARD` | `0` |
| `OVERSELL` | `negativeStockLimit` |
| `PREORDER` | `negativeStockLimit` |

`STANDARD` ignores the limit entirely — the limit is an oversell/preorder allowance, not a licence
for a standard product to go negative. `negativeStockLimit` is configured per product (default
`−20`) and enforced **independently per variant**.

Worked example from the owner, limit `−20`: at stock `−19`, one more unit is allowed and lands at
exactly `−20`; a second unit is refused. At `−20` nothing more is accepted.

Encoded in `evaluateVariantCapacity()`; every branch above is covered by
`tests/domain/capacity-policy.test.ts`.

---

## 2. Where the gate runs

**At the server-side order commit boundary, inside the reservation transaction.** Not at
add-to-cart, and never from browser-reported availability.

Cart and PDP still show sellability (I4/I5) using the same predicate, but that is *advisory*: the
storefront may show a variant as buyable and the commit may still refuse it. The refusal is correct
and must be surfaced honestly rather than papered over.

---

## 3. Reservation identity and idempotency

A reservation is identified by `(orderId, variantId)`, and the **idempotency key is the order**.

`OrderMirror.id` already exists, is created before submission, and is unique. One logical checkout
attempt therefore reserves at most once by construction: a retry that reuses the same order finds
its own rows and proceeds; it cannot create a second set. Two different orders are two different
attempts and are *meant* to reserve separately.

`(orderId, variantId)` is unique, which is also what forces §7's de-duplication: a basket with the
same variant on two lines must be merged before reserving, or the second insert violates the key.

For the Pancake call itself, `pancake-order-submit.ts` already carries the order identity into the
request; §9 requires that submission be idempotent on the same key so a retry cannot create a
duplicate remote order.

---

## 4. States and what holds capacity

Deliberately parallel to `LocalOrderState` rather than a competing vocabulary:

| Reservation | Corresponds to | Holds capacity? |
|---|---|---|
| `RESERVED` | pre-submit | **yes** |
| `SUBMITTING` | `POS_SUBMITTING` | **yes** |
| `UNKNOWN` | `SYNC_UNKNOWN` | **yes** |
| `COMMITTED` | `CONFIRMED` | **conditionally — see below** |
| `RELEASED` | `REJECTED` / abandoned | no |

```text
RESERVED   ──▶ SUBMITTING ──▶ COMMITTED   (terminal)
    │              │      ╲
    │              │       ╲─▶ UNKNOWN ──▶ COMMITTED   (reconciled: order exists)
    ▼              ▼                   ╲
 RELEASED       RELEASED                ╲─▶ RELEASED   (reconciled: proven absent)
 (terminal)     (terminal)
```

Two properties are structural rather than defensive:

- **`COMMITTED` and `RELEASED` are terminal.** They have no outgoing edges, so double-commit and
  double-release are transitions that *do not exist* — not races to be detected after the fact.
- **`UNKNOWN` has no self-loop, no edge back to `SUBMITTING`, and no timeout edge.** Nothing can
  retry or age an ambiguous hold into releasing. It leaves only by reconciliation proving the order
  exists (`COMMITTED`) or proving it absent (`RELEASED`).

`RESERVED → UNKNOWN` is also absent: ambiguity only exists once a write was actually attempted.

### 4.1 The `COMMITTED` double-count problem

This is the subtle one, and both directions of getting it wrong are real bugs.

Once Pancake confirms, Pancake decrements its own stock, and that decrement reaches us later through
the mirror. So:

- release the hold immediately on commit → between commit and the next sync, the units are counted
  by **neither** side, and a concurrent checkout spends them a second time;
- hold forever → once the mirror catches up, the same units are subtracted **twice** and the variant
  is under-sold permanently.

Rule: a `COMMITTED` reservation keeps holding **until the mirror observably includes the decrement**,
tested as `WarehouseStock.syncedAt > committedAt`. A sync strictly newer than the commit necessarily
read Pancake after the order landed.

Ties, missing and invalid timestamps resolve to **keep holding**, because the failure modes are not
symmetric: over-holding refuses a sale that could have been made, while under-holding breaches the
hard limit the owner set. Encoded in `reservationHoldsCapacity()`.

---

## 5. Threshold rules by mode

- **`STANDARD`** — floor 0. Stock ≤ 0 means disabled and `Hết hàng` (§28).
- **`OVERSELL`** — floor `negativeStockLimit`; no customer-facing label; at the limit, disabled and
  `Hết hàng` (§29).
- **`PREORDER`** — same floor; above 0 sells normally with no preorder marker; at or below 0 but
  above the limit it remains purchasable and **must** show `Đặt trước` through card → PDP → cart →
  checkout → confirmation (§30).

Turning oversell off while stock is negative **preserves** the negative value; it does not reset to
zero, and standard rules then block new sales until stock is sellable again (§29).

---

## 6. Transaction and locking strategy

Not "use a transaction". The concrete rule:

1. One `SERIALIZABLE`-or-row-locked transaction per order commit.
2. Inside it, take `SELECT … FOR UPDATE` on the reservation ledger rows **keyed by `variantId`**,
   ordered by `variantId` ascending.
3. Recompute `activeReservedQuantity` *inside* that transaction — never from a value read before it.
4. Evaluate `evaluateMultiLineReservation()`.
5. Insert all reservation rows, or none.

**Why the invariant holds under interleaving.** The quantity `activeReservedQuantity` is derived by
reading rows that the transaction has locked. A second transaction wanting the same variant blocks
at step 2 until the first commits or rolls back, so it can never read a pre-insert value. Therefore
no two transactions can both observe the same free unit. The last-unit and at-the-limit cases are
pinned by `tests/domain/capacity-policy.test.ts`, which models exactly that: the second caller sees
the first caller's hold in `activeReservedQuantity`.

**Deadlock.** Locks are taken in ascending `variantId` order by every caller, so two multi-line
orders touching the same variants acquire them in the same sequence and cannot form a cycle. Under
`SERIALIZABLE`, serialization failures are retried with bounded attempts and jittered backoff; a
retry re-enters at step 1 and re-reads everything, and because §3 keys reservations to the order it
cannot double-reserve.

---

## 7. Multi-line atomicity

An order reserves **all lines or none** (§31). `evaluateMultiLineReservation()` evaluates every line
— so one refusal explains the whole basket rather than forcing a retry to discover the next problem
— and still fails the order as a unit.

**Precondition:** callers pass one entry per *variant*. Two lines for the same variant would each see
the other excluded from `activeReservedQuantity` and could jointly overshoot, so I6a merges
duplicate variants before evaluating. The `(orderId, variantId)` uniqueness in §3 is the backstop.

An empty basket is not a successful reservation.

---

## 8. Expiration

- `RESERVED` **may** expire automatically. It is a pre-submit hold; if checkout is abandoned before
  any external write, nothing was sent and releasing is safe. The window belongs to I6a; it must be
  long enough to cover a slow legitimate checkout.
- `SUBMITTING` **must not** expire on a timer. A write is in flight; a timer cannot distinguish slow
  from landed. It moves on the call's outcome, or to `UNKNOWN`.
- `UNKNOWN` **must never** expire. Expiring it is exactly the oversell G2 showed Pancake will not
  prevent. It leaves only by reconciliation.
- `COMMITTED` retires by the §4.1 mirror rule, not by a clock.

---

## 9. Retry, crash recovery and submission

All reservation truth is persisted. Process memory holds nothing authoritative, so a crash or
restart resumes by reading the ledger.

On restart, any reservation in `SUBMITTING` is **not** assumed failed. It is treated as ambiguous,
moved to `UNKNOWN`, and handed to reconciliation — the crash destroyed our knowledge of the outcome,
not the outcome itself.

Retries of the Pancake submission reuse the same idempotency key so a retry cannot create a second
remote order; `OrderMirror.pancakeOrderId @unique` is the local backstop if one somehow occurs.

---

## 10. Reconciliation

For each `UNKNOWN` reservation, bounded and evidence-based, reusing the marker-search approach G2
already hardened:

1. **Order exists remotely** (found by marker/identity within the declared, fully-covered search
   window) → `COMMITTED`.
2. **Proven absent** — the search covered its whole declared window, validated its pagination
   metadata, and found nothing → `RELEASED`.
3. **Anything else** — contradictory pagination, a transport failure, an inconclusive read → stays
   `UNKNOWN`, is surfaced to an operator, and is retryable.

Absence is only ever asserted when the search window was fully covered. "Not found on page 1" is not
absence — that is the same fail-closed rule G2's review forced into the probe's marker search.

Case 3 deliberately has no automatic resolution. A stuck `UNKNOWN` holds capacity and is
operator-visible; the safe failure is a variant that stops selling, not one that oversells.

**Total Pancake unavailability** is not an offline-order path. No queue-to-send-later is invented
here: reservations hold, submissions fail safely, `UNKNOWN` is preserved. A durable offline queue is
separate scope and needs its own approval.

---

## 11. Composite products — v1 restriction

`OVERSELL` and `PREORDER` are **disabled for composite parents** until component-aware atomic
capacity accounting exists and is proven.

G2 observed one 1:1 fixture and a child driven to −1. That is not evidence about arbitrary
multipliers, a child that starts negative, or multi-component atomicity. Selling a composite below
zero consumes component capacity this model does not track, so it is refused
(`composite-oversell-unproven`) rather than assumed safe by analogy. Composite in `STANDARD` mode is
unaffected — it never goes below zero, so no component accounting is needed.

---

## 12. Immutable order and preorder snapshot (I7)

Preorder facts are snapshotted onto the order at successful confirmation and never recomputed:

- preparation time **15 calendar days**, clock starting at successful system confirmation;
- shipping added after preparation — Hà Nội `+1–3` days, other provinces `+3–10` days;
- a mixed ready + preorder order is **held whole** and ships in one shipment after the preorder
  items are ready; the customer ETA follows the slowest preorder item plus the shipping window.

A later policy change must not rewrite historical order truth. This mirrors the existing
`OrderLineSnapshot` approach, which already freezes price and promotion facts at commit.

---

## 13. Proposed persistence for I1 — pending Checkpoint B

**Not created or run by this ADR.** The G4 Checkpoint B approval (2026-09-16) covers five
merchandising models and **does not** cover anything below; these need their own authorization.

```prisma
enum SellingMode {
  STANDARD
  OVERSELL
  PREORDER
}

enum ReservationState {
  RESERVED
  SUBMITTING
  COMMITTED
  RELEASED
  UNKNOWN
}

/// Website-owned selling policy. Never overwritten by Pancake catalog sync (master spec §27).
model ProductSellingPolicy {
  productId          String      @id
  sellingMode        SellingMode @default(STANDARD)
  negativeStockLimit Int         @default(-20)
  updatedAt          DateTime    @updatedAt

  product ProductMirror @relation(fields: [productId], references: [id], onDelete: Cascade)
}

/// The capacity ledger. One row per (order, variant).
model VariantCapacityReservation {
  id          String           @id @default(cuid())
  orderId     String
  variantId   String
  quantity    Int
  state       ReservationState @default(RESERVED)
  committedAt DateTime?
  releasedAt  DateTime?
  createdAt   DateTime         @default(now())
  updatedAt   DateTime         @updatedAt

  order   OrderMirror   @relation(fields: [orderId], references: [id], onDelete: Cascade)
  variant VariantMirror @relation(fields: [variantId], references: [id], onDelete: Restrict)

  @@unique([orderId, variantId])
  @@index([variantId, state])
  @@index([state, updatedAt])
}
```

Notes on the shape:

- `@@unique([orderId, variantId])` is the idempotency backstop from §3 and the duplicate-line
  backstop from §7.
- `@@index([variantId, state])` serves the hot path: summing active holds for one variant under lock.
- `@@index([state, updatedAt])` serves the reconciliation sweep and the stuck-`UNKNOWN` operator view.
- `onDelete: Restrict` on the variant is deliberate — a variant with live holds must not vanish and
  silently free capacity.
- `Int`, not `Float`: capacity is a count. `WarehouseStock.quantity` is `Float` today, which is a
  pre-existing mirror shape; the ledger does not inherit it.

Because that mirror is `Float`, a fractional or non-finite `mirroredStock` is reachable from upstream
data. `evaluateVariantCapacity()` refuses it as `invalid-stock` rather than flooring it — flooring
would silently reinterpret stock nobody approved — so the variant stops selling and the reason names
the mirror rather than the shopper's request.

Additional `CHECK` constraints proposed, all intra-row so the database genuinely can enforce them
(unlike the cross-table taxonomy case ADR 0013 §4.5 documents):

- `quantity > 0`;
- `negativeStockLimit <= 0`;
- `committedAt IS NOT NULL` when `state = 'COMMITTED'`;
- `releasedAt IS NOT NULL` when `state = 'RELEASED'`.

**What the database still cannot enforce:** the capacity arithmetic itself. No constraint can express
"the sum of active holds plus mirrored stock stays above a per-product limit", because it spans
tables and depends on the selling mode. That invariant lives at the §6 transaction boundary and is
enforced there — stated plainly here rather than claimed as a schema guarantee.

---

## 14. Migration requirements

Three additive models (two enums + two tables) and back-relations on `ProductMirror`, `OrderMirror`
and `VariantMirror`. No existing column changes meaning. No backfill: every existing product is
`STANDARD` with limit `−20` by column default, which is exactly today's behaviour.

**These are NOT covered by the 2026-09-16 Checkpoint B approval** and require separate owner
authorization before any migration is written.

---

## 15. Rollback and disable

The feature is off by default and reversible without a down-migration:

- with no `ProductSellingPolicy` row, a product is `STANDARD` — today's behaviour exactly;
- setting every product to `STANDARD` disables oversell and preorder while preserving negative stock
  values and the ledger's history;
- the reservation gate itself can be disabled by a server-side flag, following the existing
  `LA_PROMOTION_ACTIVATION_ENABLED` default-off pattern. Disabling it returns checkout to current
  behaviour, and any live `UNKNOWN` rows remain for reconciliation rather than being discarded.

A down-migration that drops the ledger would destroy audit history for orders that consumed capacity
and must not be the rollback path.

---

## 16. What this unblocks

| Task | Contract from this ADR |
|---|---|
| **I1** | §13 persistence |
| **I4** | §1 + §5 — one sellability predicate, `capacity-policy.ts` |
| **I5** | §2 — cart/PDP advisory, commit boundary authoritative |
| **I6a** | §6 locking + §7 multi-line atomicity |
| **I6b** | §2 + §9 checkout integration and retry |
| **I7** | §12 immutable snapshot |
| **I8** | §10 reconciliation |

## Out of scope

Durable offline order queue; component-aware composite capacity; changing `WarehouseStock` to an
integer quantity; any Pancake live write.
