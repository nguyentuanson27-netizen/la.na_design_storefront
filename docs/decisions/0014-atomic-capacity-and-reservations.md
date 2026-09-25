# ADR 0014 — Atomic capacity, reservations and Pancake reconciliation

- Status: **ACCEPTED.** Architecture owner-approved 2026-09-16; §13 persistence separately
  authorized and applied 2026-09-17 (migration `20260917080000_add_atomic_capacity_persistence`).
  The §4.2 stock-observation marker is enforced. I6a reservation writes are implemented. The
  component-resource extension for STANDARD composite capacity is implemented 2026-09-25 by
  `20260925003000_add_composite_capacity_resources`.
- Date: 2026-09-17; component-resource amendment 2026-09-25.
- Scope: the current local capacity authority, including line reservations, component-resource
  snapshots, locking, and reconciliation. **No Pancake live stock write.** The §12 order/preorder
  snapshot remains a separate immutable order-history concern.
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

That Pancake probe did **not** prove arbitrary composite multipliers, a component that starts
negative, or multi-component atomicity. The local STANDARD reservation implementation now has
database regressions for a multiplier greater than 1 and for multi-component all-or-none refusal;
those are local transaction guarantees, not retroactive claims about Pancake's own behaviour.

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

- `mirroredStock` — `SUM(WarehouseStock.quantity)` for the **capacity resource**. For a standalone
  line the resource is the purchased variant itself. For a STANDARD composite line the parent is
  expanded to each component resource, and the consumed quantity is
  `lineQuantity × CompositeComponentMirror.quantity`. Parent `WarehouseStock` is never rewritten
  or substituted as composite capacity.
- `activeReservedQuantity` — the sum of quantities in `CapacityReservationResource` whose owning
  reservation still holds (§4).

**The reservation is allowed iff `projectedCapacity >= floor`**, where:

| Selling mode | Floor |
|---|---|
| `STANDARD` | `0` |
| `OVERSELL` | `negativeStockLimit` |
| `PREORDER` | `negativeStockLimit` |

`STANDARD` ignores the limit entirely — the limit is an oversell/preorder allowance, not a licence
for a standard product to go negative. `negativeStockLimit` is configured per product (default
`−20`). The floor is enforced independently per capacity resource; for a standalone line that is
the variant itself, while a STANDARD composite checks every component resource it consumes.

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
  This holds *in the state machine*, which is the whole scope of the claim: the database cannot
  enforce it, so §6.4 requires every transition to be a guarded compare-and-set with this table
  choosing the expected state.
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

Rule: a `COMMITTED` reservation keeps holding **until the mirror observably includes the decrement**.

The test must be about **when the stock observation started**, not when its result was stored:

> `stockObservationStartedAt > committedAt`

where `stockObservationStartedAt` is the instant captured **before** the Pancake stock read was
issued. A read that starts after the commit cannot miss the decrement; a read that starts before it
can, no matter how late it lands.

**Why the earlier rule was wrong.** This section previously said
`WarehouseStock.syncedAt > committedAt`, justified as "a sync strictly newer than the commit
necessarily read Pancake after the order landed". That does not follow, and review `5230768526`
gave the interleaving that breaks it:

1. catalog sync begins a Pancake stock read;
2. the checkout commits on Pancake, which decrements;
3. the in-flight read returns a **pre-commit** snapshot;
4. that snapshot is persisted locally, stamping a marker later than `committedAt`.

The mirror then holds stock without the decrement while carrying a timestamp newer than the commit.
A persist-time test retires the hold there, the units are counted by neither side, and the next
checkout spends them again — breaching the hard limit this ledger exists to enforce. The regression
case is pinned by `tests/domain/capacity-policy.test.ts` ("a stock read that started before the
commit does not retire the hold, however late it lands").

### 4.2 The stock-observation marker — ENFORCED (I1, 2026-09-17)

`reservationHoldsCapacity()` names its input `stockObservationStartedAt` rather than `syncedAt`
precisely because the column name was never the contract. That requirement is now met structurally
rather than by convention.

**Before.** `syncPancakeCatalog()` took `syncedAt: Date` from its caller and imposed nothing on it.
`syncConfiguredPancakeCatalog()` happened to evaluate `new Date()` as a default parameter before
calling in, and `scripts/pancake-durability-evidence.ts` supplied its own — so the marker was a
read-start fact *by accident at one call site*, and the parameter name actively invited a caller to
pass the instant the write finished.

**Now.** `syncPancakeCatalog()` takes a `clock: () => Date` and samples it **once, itself,
immediately before the first Pancake request**. A caller chooses *what* time source is used; it can
no longer choose *when* the sample is taken, so a post-fetch reading is unrepresentable rather than
merely discouraged. Injecting a fixed clock stays possible for deterministic tests and evidence
scripts — a fixed instant is still a read-start marker, not a reading taken after the response came
back.

`tests/integrations/catalog-sync.test.ts` pins the **ordering**, not the value: one test asserts the
clock is read before any fetch is issued, and a second asserts that no Pancake request has been made
at the moment the clock is sampled. A value assertion would still pass if the sampling moved below
the fetch, which is exactly the regression that matters.

`WarehouseStock.syncedAt` therefore now carries read-start semantics by construction, and no separate
generation column is needed. The alternative — persisting an explicit marker alongside the stock row
— was not taken because it would add a column to express a property the call ordering already
guarantees.

A caller that still has no marker passes nothing, and a missing marker resolves to **keep holding** —
so the predicate degrades safely rather than guessing.

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

### 5.1 Resolving the policy when no row exists

Almost every product will have no `ProductSellingPolicy` row, because §14 permits no
`ProductSellingPolicy` backfill. That
makes the missing-row answer part of the contract, not an edge case — and it is **not** supplied by
the column defaults in §13.

A column default fires when a row is inserted. A product with no row has had no default applied to
it, because the database never invents the row. Saying "no backfill is needed, the defaults cover
it" conflates the two and is simply wrong; the earlier draft of §14 said exactly that, and this
section is the correction.

One resolver owns the answer, and every consumer goes through it:

> **No `ProductSellingPolicy` row ⇒ `STANDARD`, `negativeStockLimit = −20`.**

Shipped as `resolveSellingPolicy()` in `src/commerce/capacity-policy.ts` and pinned by
`tests/domain/capacity-policy.test.ts`, which asserts the resolved default not only carries the
right constants but refuses to go below `0` at the gate — today's behaviour exactly. Without a
single resolver, each call site invents its own missing-row answer and they will disagree.

Three details the tests also pin:

- `isDefault` distinguishes "not configured" from "configured to the same values as the default", so
  an admin surface can show which products an operator has actually reviewed.
- A stored row is returned **as stored**, including a limit `evaluateVariantCapacity()` will refuse.
  Substituting the default for a bad stored value would sell the product under a limit the owner
  never set; refusing with `invalid-limit` sends the operator to the row that is wrong.
- An unrecognized `sellingMode` resolves to `STANDARD` — no owner intent survives in a value that
  names no mode — while the stored limit is preserved, so no allowance is silently widened.

**Why a separate table rather than columns on `ProductMirror`.** This follows the pattern the schema
already uses: `ProductMerchantFacts` deliberately keeps website-owned merchant facts out of the
Pancake mirror, keyed `productId @unique` with `onDelete: Cascade`. Selling policy is website-owned
in the same sense — master spec §27 requires it never be overwritten by catalog sync — so it takes
the same shape rather than inventing a second convention.

---

## 6. Transaction and locking strategy

### 6.1 The empty-ledger race this rule exists to close

An earlier draft of this section said: lock the reservation ledger rows keyed by `variantId`, then
sum them. **That is wrong, and wrong in exactly the case that matters most.**

`SELECT … FOR UPDATE` locks the rows it returns. A variant nobody has reserved yet has *no* ledger
rows, so the statement returns zero rows and locks nothing at all. Two first-ever checkouts for that
variant therefore both take the lock successfully-but-vacuously, both compute
`activeReservedQuantity = 0`, both pass the predicate, and both insert. The claim that "a second
transaction blocks until the first commits" is false whenever the ledger is empty for that variant —
which is the state of every variant before its first sale.

This is the same shape of error review `5229201195` found in ADR 0013: a constraint that reads as
enforcement but does not constrain the case it is invoked for. A row lock can only serialize
transactions around a row that **already exists**.

### 6.2 The rule

Lock identities that always exist for both the purchased line and the resources it consumes, *then*
read capacity:

1. One transaction per order commit. `READ COMMITTED` is sufficient; correctness comes from the
   explicit locks, not from the isolation level.
2. Merge the basket to one entry per purchased variant (§7). Resolve the current resource identities:
   a standalone line consumes itself; a STANDARD composite consumes each
   `CompositeComponentMirror.componentVariantId`, multiplied by the positive edge quantity.
3. In one ordered `SELECT ... FOR UPDATE`, lock the requested `VariantMirror` rows, every component
   resource row for those requested composite parents, and any resource snapshots already owned by
   this order for idempotent retry. `VariantMirror` is still the lock target because it exists even
   when the reservation ledger is empty.
4. Assert every requested purchased variant exists. Invalid/missing component facts fail closed.
   After the lock is held, read current component topology for a new reservation, mirrored stock for
   the locked resources, and competing `CapacityReservationResource` rows joined to reservations
   that still hold under §4.
5. Evaluate capacity per resource with `evaluateVariantCapacity()`. For a STANDARD composite, **all**
   component resources must pass. The parent line itself is not given synthetic stock.
6. Only after every line/resource decision passes, insert the line-oriented
   `VariantCapacityReservation` rows and their `CapacityReservationResource` snapshots in the
   same transaction. A resource snapshot records what that accepted line consumed at the reservation
   boundary, so later composite-graph sync cannot move an existing hold to different stock.

**Why the invariant holds under interleaving.** Two different FULL SET parent variants that share a
child lock the same child `VariantMirror` row, and a direct sale of that child locks that same row.
The second transaction therefore blocks before reading competing resource holds. Under
`READ COMMITTED`, its post-lock read sees the first transaction's committed resource snapshot and
cannot spend the same component units again. The same rule covers edge multipliers because the
resource quantity persisted for a composite is `lineQuantity × edgeQuantity`.

The database regression suite pins the empty-ledger race, shared-child parent/parent and parent/direct
contention, an edge multiplier greater than 1, and multi-component all-or-none refusal.

A transaction-level advisory lock (`pg_advisory_xact_lock`) would also work and would not contend
with catalog sync. It is not chosen because `variantId` is a `cuid` string and advisory locks take a
`bigint`, so it would need a hash — and a hash collision silently serializes two unrelated variants
or, worse, invites a keyspace scheme nobody maintains. A real row needs no such mapping.

**A higher isolation level is compatible but not load-bearing.** Under `REPEATABLE READ` or
`SERIALIZABLE` the transaction's snapshot is taken before it blocks, so a transaction that waited on
the lock may fail with a serialization error rather than read the newer rows. That is safe — it
aborts instead of overselling — but it means those levels require the retry loop below, whereas
`READ COMMITTED` does not.

**Deadlock.** The lock statement orders by `id`, and PostgreSQL applies `FOR UPDATE` after the sort,
so every caller acquires the same variants in the same ascending sequence and no cycle can form.
Serialization failures and lock timeouts are retried with bounded attempts and jittered backoff; a
retry re-enters at step 1 and re-reads everything, and because §3 keys reservations to the order it
cannot double-reserve.

### 6.3 What the lock does *not* cover

Stated plainly rather than left to be assumed:

- **It serializes local capacity decisions against each other. It does not freeze the Pancake
  mirror.** `WarehouseStock` is a different table, and catalog sync may commit a new `mirroredStock`
  between step 4 and step 6. The local gate's guarantee is that two *local* checkouts cannot both
  spend the same unit; it was never that the absolute floor holds against a sale Pancake made
  elsewhere. G2 established Pancake will not enforce that for us, and §4.1 plus §10 reconciliation
  are what absorb mirror movement.
- **It does not enforce the state machine.** See §6.4.

### 6.4 State transitions require a guarded update

The `ReservationState` enum constrains the value of a column. The §13 CHECK constraints are all
intra-row. Neither prevents an `UPDATE` from moving a row `COMMITTED → RESERVED`, so §4's terminality
is a property of *this specification and the service that implements it* — not something the schema
makes unrepresentable.

Every transition must therefore be a compare-and-set:

```sql
UPDATE "VariantCapacityReservation"
   SET state = $new, ...
 WHERE id = $1
   AND state = $expected;
```

with the affected-row count asserted to be exactly `1`, and `$expected` drawn from
`RESERVATION_TRANSITIONS`. An affected count of `0` means another worker moved the row first and is
a conflict to re-read, never a no-op to ignore. An unguarded `UPDATE … WHERE id = $1` bypasses the
entire state machine and is prohibited.

---

## 7. Multi-line atomicity

An order reserves **all lines or none** (§31). I6a first merges duplicate purchased variants, then
builds every line's resource plan and evaluates the complete plan before inserting any reservation
or resource row. A refusal on one component therefore leaves neither a parent line reservation nor a
partial hold on components that had room.

For standalone lines, one purchased unit consumes one resource unit. For a composite line, each
resource quantity is `lineQuantity × edgeQuantity`; multiplication must stay a positive PostgreSQL
integer or the line fails closed.

**Precondition:** callers pass one logical entry per purchased variant; I6a defensively merges
duplicates before resource planning. The `(orderId, variantId)` uniqueness in §3 remains the
idempotency backstop.

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

## 11. Composite products — component-aware STANDARD capacity

STANDARD composite parents are component-accounted. Their parent `WarehouseStock` remains the
verbatim Pancake mirror and is **not** the sellable-capacity authority for the FULL SET. Advisory PDP
and cart capacity are derived from components as:

```text
parentCapacity = min(floor(max(0, componentStock) / requiredQuantity))
```

At checkout the authoritative rule is stricter than that advisory scalar: the parent line expands
into component resources, locks those resources atomically, and persists the exact consumed resource
quantities in `CapacityReservationResource`. A child disabled for standalone storefront sale may
still supply a FULL SET when it remains present and stocked; activation controls standalone
addressability, not whether a present component exists in the set.

The database regressions cover a shared child across different parents/direct sale, a multiplier
greater than 1, and multi-component all-or-none refusal.

`OVERSELL` and `PREORDER` remain **disabled for composite parents**. Component-aware negative
capacity semantics are still not approved, so those modes continue to fail with
`composite-oversell-unproven` rather than extending the STANDARD component accounting by analogy.

---

## 12. Immutable order and preorder snapshot (I7)

Preorder facts are snapshotted onto the order at successful local `CONFIRMED` and never recomputed:

- preparation time **15 calendar days**, clock starting at the successful system confirmation instant;
- this is an **ORDER ETA authority**, not Merchant `availability_date` and not a product-level public
  availability date;
- a mixed ready + preorder order is held whole and ships in one shipment after the preorder items
  are ready; the order-level preorder readiness is the slowest snapshotted preorder readiness;
- later policy or stock changes must not rewrite historical order truth;
- no historical row is fabricated for orders confirmed before I7 or for rows whose required authority
  was not available.

I7 uses a dedicated `OrderPreorderSnapshot` + `OrderPreorderLineSnapshot` projection rather than
the mutable DRAFT `OrderLineSnapshot`. The parent is one-to-one with the order; line rows preserve
the confirmation-time READY/PREORDER state and line readiness. PostgreSQL triggers reject UPDATE and
DELETE on both snapshot tables, and the order foreign key is `RESTRICT`, making the history
append-only/immutable at the database boundary.

The READY/PREORDER classification is decided at the **atomic capacity acceptance boundary**, while
the variant lock is held. I7 stores that accepted classification as nullable metadata on the
`VariantCapacityReservation`; confirmation never re-reads mutable stock, selling policy, or competing
reservations to reconstruct it after the Pancake write.

The confirmation transition writes the local `CONFIRMED` state and the I7 snapshot in one database
transaction when complete I7 reservation authority exists. A reservation created by rolling old code
has null I7 metadata, and a legacy/lower-level order may have no capacity reservation at all. Those
orders remain truthfully **without an I7 snapshot** rather than deriving history from current mutable
facts. This is rolling-compatible no-backfill, not an alternate ETA calculation.

Calendar arithmetic uses the existing project authority of **UTC+7**. Because that authority has no
DST transition, 15 calendar days preserves the confirmation local wall-clock time deterministically
across month, year and leap-year boundaries.

The snapshot never reads or derives Merchant `availability_date`. Shipping-window calculation is
intentionally not part of I7 persistence; later F8 consumers may add the already-approved fulfillment
window to this immutable preorder readiness, but must not rewrite the stored preparation fact.

---

## 13. Persistence for I1 — AUTHORIZED and IMPLEMENTED (2026-09-17)

**Not created or run by this ADR.** The G4 Checkpoint B approval (2026-09-16) covers five
merchandising models and **does not** cover anything below; these need their own authorization.

**Owner review, 2026-09-17.** The repository owner reviewed this section and approved the *design
direction* of `ProductSellingPolicy`, with four required corrections, all applied here:

| # | Finding | Where it is fixed |
|---|---|---|
| 1 | "No backfill because the column default covers it" is false — a default never fires for a row that does not exist. A canonical resolver must own the missing-row answer and be tested. | §5.1, `resolveSellingPolicy()`, §14 |
| 2 | `onDelete: Cascade` on the order would let a hard-deleted `OrderMirror` silently free capacity, including a live `UNKNOWN` hold — the very thing §15 prohibits. | `Restrict` on both relations, below |
| 3 | One-way CHECK implications still admit `RESERVED` with a `committedAt`, or a row that is both committed and released. | Biconditional CHECKs below |
| 4 | §6 locked ledger rows keyed by `variantId`, which locks nothing when that variant has no reservations yet — so the first two concurrent checkouts could both read `0` and both insert. | §6.1–§6.2, rewritten to lock `VariantMirror` |

Finding 4 was a genuine correctness blocker, not a wording problem: ADR 0014 names this ledger the
authoritative gate, and the gate did not close on an empty ledger.

**Migration authorized 2026-09-17** and shipped as
`prisma/migrations/20260917080000_add_atomic_capacity_persistence`, a **separate** authorization from
the 2026-09-16 five-model merchandising approval, which explicitly did not cover these two tables.
Recorded with provenance in `docs/specs/la-na-design-owner-approved-facts-and-decisions.md` ›
Settled decisions.

`src/commerce/capacity-repository.ts` reads the policy through `resolveSellingPolicy()`, so the
missing-row answer keeps exactly one producer. I6a reservation writes are now implemented by
`src/commerce/capacity-reservation.ts`: §6.2's purchased/resource locking and §6.4's guarded
compare-and-set are the enforcement boundary. The 2026-09-25 composite extension adds immutable
`CapacityReservationResource` rows beneath those line reservations; it does not create a second
capacity authority.

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

/// The line-oriented capacity ledger. One row per (order, purchased variant).
model VariantCapacityReservation {
  id          String           @id @default(cuid())
  orderId     String
  variantId   String
  quantity    Int
  state       ReservationState @default(RESERVED)
  acceptedPreorderState OrderPreorderLineState?
  committedAt DateTime?
  releasedAt  DateTime?
  createdAt   DateTime         @default(now())
  updatedAt   DateTime         @updatedAt

  order     OrderMirror                   @relation(fields: [orderId], references: [id], onDelete: Restrict)
  variant   VariantMirror                 @relation(fields: [variantId], references: [id], onDelete: Restrict)
  resources CapacityReservationResource[]

  @@unique([orderId, variantId])
  @@index([variantId, state])
  @@index([state, updatedAt])
}

/// Immutable capacity resources consumed by one accepted line reservation.
model CapacityReservationResource {
  id            String                     @id @default(cuid())
  reservationId String
  variantId     String
  quantity      Int
  reservation   VariantCapacityReservation @relation(fields: [reservationId], references: [id], onDelete: Cascade)
  variant       VariantMirror              @relation(fields: [variantId], references: [id], onDelete: Restrict)

  @@unique([reservationId, variantId])
  @@index([variantId])
}
```

Notes on the shape:

- `@@unique([orderId, variantId])` is the idempotency backstop from §3 and the duplicate-line
  backstop from §7.
- `VariantCapacityReservation` stays keyed to the purchased variant for order idempotency and
  historical READY/PREORDER state.
- `CapacityReservationResource @@index([variantId])` serves the authoritative shared-resource hot
  path: competing holds are summed by the stock identity they actually consume, then filtered by the
  owning reservation state.
- `@@index([state, updatedAt])` on the line ledger serves the reconciliation sweep and the
  stuck-`UNKNOWN` operator view.
- `onDelete: Restrict` on **both** relations is deliberate, and the order side is the one that is
  easy to get wrong. An earlier draft had `Cascade` on the order, reasoning from ownership: a
  reservation belongs to an order, so deleting the order should take its reservations with it. But
  this table is a capacity ledger and an audit record, not a child collection. A hard-delete of an
  `OrderMirror` would cascade away holds that are still counting — an `UNKNOWN` hold above all,
  which by §8 must never be released except by reconciliation — and silently free capacity through
  a path nobody reviewed. That is the same outcome §15 prohibits when it rules out dropping the
  ledger as a rollback. `Restrict` makes the deletion fail loudly instead, so an operator must
  resolve the reservations first.
- `onDelete: Restrict` on the variant is deliberate for the same reason — a variant with live holds
  must not vanish and silently free capacity. §6.2 additionally depends on the variant row existing
  for every reservable variant, because that row is the lock target.
- `Int`, not `Float`: capacity is a count. `WarehouseStock.quantity` is `Float` today, which is a
  pre-existing mirror shape; the ledger does not inherit it.

Because that mirror is `Float`, a fractional or non-finite `mirroredStock` is reachable from upstream
data. `evaluateVariantCapacity()` refuses it as `invalid-stock` rather than flooring it — flooring
would silently reinterpret stock nobody approved — so the variant stops selling and the reason names
the mirror rather than the shopper's request.

Additional `CHECK` constraints proposed, all intra-row so the database genuinely can enforce them
(unlike the cross-table taxonomy case ADR 0013 §4.5 documents).

The implications must be **biconditionals**, not one-way. An earlier draft wrote only the forward
direction, which still admits rows that are plainly nonsense: `RESERVED` carrying a `committedAt`,
or a `COMMITTED` row that also has a `releasedAt` and so claims both outcomes at once. Required
semantics:

```text
quantity > 0
negativeStockLimit <= 0                     -- on ProductSellingPolicy

state = 'COMMITTED'  ⇔  committedAt IS NOT NULL
state = 'RELEASED'   ⇔  releasedAt  IS NOT NULL

NOT (committedAt IS NOT NULL AND releasedAt IS NOT NULL)
```

As SQL on `VariantCapacityReservation`:

```sql
CHECK (quantity > 0),
CHECK ((state = 'COMMITTED') = (committedAt IS NOT NULL)),
CHECK ((state = 'RELEASED')  = (releasedAt  IS NOT NULL)),
CHECK (NOT (committedAt IS NOT NULL AND releasedAt IS NOT NULL))
```

The biconditional form also does the reverse work: a `RESERVED`, `SUBMITTING` or `UNKNOWN` row is
now forbidden from carrying either timestamp, so a stale `committedAt` cannot survive into a
non-terminal state and be read later as evidence of a commit that never happened.

**These constraints still do not make the state machine safe.** They are per-row predicates; they
say nothing about the transition between two versions of a row, so `COMMITTED → RESERVED` remains
perfectly representable in SQL as long as the new row satisfies the CHECKs. Enforcement of the
transition itself is §6.4's guarded compare-and-set, in the service.

**What the database still cannot enforce:** the capacity arithmetic itself. No constraint can express
"the sum of active holds plus mirrored stock stays above a per-product limit", because it spans
tables and depends on the selling mode. That invariant lives at the §6 transaction boundary and is
enforced there — stated plainly here rather than claimed as a schema guarantee.

---

## 14. Migration requirements

### Original I1 persistence (2026-09-17)

The original migration added the selling-policy and line-reservation persistence additively. No
`ProductSellingPolicy` backfill is required: §5.1's `resolveSellingPolicy()` owns the missing-row
answer (`STANDARD`, limit `−20`). A column default would not create an absent row.
`CHECK (negativeStockLimit <= 0)` belongs on `ProductSellingPolicy`.

That migration was separately authorized on **2026-09-17** as
`20260917080000_add_atomic_capacity_persistence`.

### Composite resource extension (2026-09-25)

`20260925003000_add_composite_capacity_resources` is expand-only: it adds
`CapacityReservationResource` and does not change or synthesize `WarehouseStock`.

Existing line reservations **are backfilled** into immutable resource snapshots using the durable
composite graph available at migration time: standalone reservations consume themselves; composite
reservations consume each component multiplied by the stored edge quantity.

This backfill cannot be rolling-compatible with an old writer that knows only
`VariantCapacityReservation`: otherwise old code could create a line reservation after the backfill
but before new code starts, leaving a live hold with no resource snapshot. The production deploy
therefore quiesces the old `app` container **before** `prisma:migrate:deploy`, runs the backfill with
no application writer active, and starts the new app only after migration succeeds. If migration
fails, the stopped pre-release app container is started again; no new image is recreated on that
failure path.

The deploy-order regression in `tests/domain/vps-deploy-quiesce.test.ts` pins
`stop old app → migrate → start new app`.

---

### I7 migration rollback reasoning

The I7 migration is **expand-only**. It must be deployed before enabling the confirmation seam that writes
the snapshot, so old and new application versions can coexist while the new tables are present. If the
application needs to roll back, roll back the application code while **keeping the I7 tables and trigger
history intact**; pre-I7 code ignores the additive tables. Do not use a down-migration that drops the
snapshot tables, because that would destroy immutable order history. Re-enabling I7 later simply resumes
writing snapshots for newly confirmed orders; there is still no backfill of older orders.

## 15. Rollback and disable

The feature is off by default and reversible without a down-migration:

- with no `ProductSellingPolicy` row, a product is `STANDARD` — today's behaviour exactly, by §5.1's
  resolver rather than by any column default;
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
| **I1** | §13 persistence, and §4.2's stock-observation marker before the `COMMITTED` rule is trusted |
| **I4** | §1 + §5 — one sellability predicate, `capacity-policy.ts` |
| **I5** | §2 — cart/PDP advisory, commit boundary authoritative |
| **I6a** | §6 purchased/resource locking + §7 line/resource atomicity |
| **I6b** | §2 + §9 checkout integration and retry |
| **I7** | §12 immutable snapshot |
| **I8** | §10 reconciliation |

## Out of scope

Durable offline order queue; composite `OVERSELL`/`PREORDER`; changing `WarehouseStock` to an
integer quantity; any Pancake live write.
