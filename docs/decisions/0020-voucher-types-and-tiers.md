# ADR 0020: Voucher types and tiers — several MERCHANDISE vouchers of different types, one tier per type

- **Status:** **Proposed**, built behind the same `LA_VOUCHER_ENABLED` gate (OFF). It extends [ADR 0018](./0018-voucher-v1-accepted-order-architecture.md) and [ADR 0019](./0019-voucher-v1-hold-design.md); it does not replace them. The owner has decided the product rules below (interview of 2026-10-28). Migration and Admin schema approval (the H2-style gate) is still the owner's before anything is enabled.
- **Date:** 2026-10-28
- **Governs:** [`docs/specs/storefront-voucher-v1.md`](../specs/storefront-voucher-v1.md) §1 ("one MERCHANDISE + one SHIPPING_FREE at most"), §3.1, §3.2, §4.1, §4.2, §5.1, §5.2.
- **Does not decide:** production enablement, Pancake sandbox probes, any change to SHIPPING_FREE.

## Context

Voucher v1 lets a cart carry at most **one MERCHANDISE and one SHIPPING_FREE** voucher. Each `VoucherCampaign` is one voucher with one threshold (`minEligibleSubtotalVnd`). The shop now wants to run several kinds of merchandise voucher side by side (for example "by order value", "by category") where each kind is a ladder of thresholds, and a shopper may use one voucher of **each** kind but never two of the same kind.

## Owner decisions (2026-10-28)

| # | Decision |
| --- | --- |
| Q1 | A **type** ("loại") is created by the Admin: it has a name, a stacking priority and its own distribution (AUTO, or CODE with PUBLIC/PRIVATE). Its tiers are ordinary campaigns that belong to it. |
| Q2 | Inside a type, the tiers are a **ladder**: the system picks the **highest tier the cart reaches**. The shopper may still lock a lower tier or an explicit NONE for that type. |
| Q3 | Vouchers of different types are applied **in sequence by type priority**. Each type's discount is computed on the amount left after the earlier types. |
| Q4 | Scope of change: **extend v1** (additive migration, keep ledger, holds, picker, snapshot). |
| Q5 | Quota and budget stay **per tier** (the existing per-campaign ledger and CHECKs). When a tier is exhausted AUTO falls back to the highest tier that still has quota. |
| Q6 | A **CODE type has one code for the whole type**. The code unlocks the ladder; entering another code of the same type replaces the first. |
| Q7 | A tier's threshold is judged on the **in-scope paid subtotal before any voucher**, so another type's voucher never makes the shopper lose a tier. The discount itself is computed on what is left. |

## Decision

### D-1 Slot: the unit that "only one" applies to

A **slot** is the key under which at most one voucher can be selected, held and redeemed per checkout attempt:

| Campaign | Slot |
| --- | --- |
| SHIPPING_FREE | `SHIPPING_FREE` |
| MERCHANDISE without a type (v1 rows) | `MERCHANDISE` |
| MERCHANDISE of type `T` | `MERCHANDISE:T` |

Everything that was "once per kind" in v1 (the live-hold unique index, the redemption unique key, the cart selection, the optimizer grid, the proof) becomes "once per slot". With no typed campaign the system behaves exactly as v1.

### D-2 Data model (additive)

- New table `VoucherType` (`id`, `pancakeShopId`, `name`, `priority`, `issuance`, `visibility`, `code`, timestamps). `code` is unique per shop; a typed tier's own `code` stays NULL because the type owns the code.
- `VoucherCampaign.typeId` (nullable, FK `RESTRICT`). CHECK: only MERCHANDISE has a type; a typed tier copies `issuance` and `visibility` from its type (validated in the Admin service and re-checked when a row is read). The v1 CHECK "CODE requires a code" is relaxed to "CODE requires a code **or** a type".
- `VoucherHold.slot` and `VoucherRedemption.slot` (`TEXT NOT NULL`, backfilled from `kind`). The partial unique index becomes `(attemptKey, slot) WHERE state = 'HELD'` and `VoucherRedemption` becomes unique on `(orderId, slot)`. The guard triggers freeze `slot` like every other identity column and require the redemption's slot to equal its hold's.
- `CartVoucherSelection.typeSelections` (`jsonb`, default `{}`): per typed slot `{ mode, voucherId, unlocked }`. The v1 columns keep serving the untyped `MERCHANDISE` slot. `unlocked` records that a PRIVATE type was opened with its code in this cart, which is what lets later reads load its tiers without the code in the URL.
- No existing column is dropped or retyped. Rollback is the `DROP` list at the top of the migration, safe only while no accepted order references a typed tier.

### D-3 Money: sequential stack, thresholds on the pre-voucher base

Inputs: paid lines `L0` after legacy/tier/ladder (unchanged, TG-11 A); the chosen tier of each slot ordered by `(type priority, slot key)`.

```text
lines = L0
for each chosen tier t (in order):
  E0 = in-scope subtotal of t on L0            -- threshold only (Q7)
  if t.min and E0 < t.min             -> t ineligible
  E  = in-scope subtotal of t on lines          -- base of the discount
  D  = FIXED amount | round-half-up(E x pct / 100) capped by t.max
  require 0 < D < E and D <= E - units          -- every unit stays >= 1d
  allocate D over in-scope lines of `lines` (v1 allocator, exact to the VND)
  lines = lines after the allocation
```

Total merchandise discount = sum of the `D`s; `P_after = P - sum`. A tier that passes its threshold on `L0` but fails the guards on the reduced `lines` (for example a fixed discount larger than what the earlier types left) makes **that combination** invalid; the optimizer simply does not choose it.

Worked example, `P = 1.000.000` all shop:

| Type (priority) | Tiers | Chosen | Base | D |
| --- | --- | --- | --- | --- |
| A "Theo đơn" (1) | >=500K -30K · >=1M -80K | >=1M | 1.000.000 | 80.000 |
| B "Phần trăm" (2) | >=500K 5% (cap 50K) · >=1M 10% (cap 100K) | >=1M | 920.000 | 92.000 |

Pay `1.000.000 - 172.000 = 828.000` (v1 with a single voucher is the first row only). At `P = 520.000`: A takes 30.000, B's >=500K tier is still reachable because its threshold is judged on 520.000, and takes 5% of 490.000 = 24.500.

Shipping is unchanged: the fee is re-evaluated per candidate with `hasOtherPromotions` true when the merchandise total is positive (TG-10 B), then the SHIPPING_FREE threshold is judged on the in-scope subtotal after **all** merchandise vouchers.

### D-4 Optimizer

The grid becomes `(prod over slots of (NONE + that slot's candidates)) x (NONE + shipping)`. Ranking is the existing TG-09 order (lowest total, then gifts kept, then fewer vouchers, then the higher rung of a type's ladder, then stable ids). When two tiers of one type cost the shopper the same (for example both are at their cap), the tier with the higher threshold wins, so AUTO never serves a cart that reached the top tier from a lower one and never spends the lower tier's quota. Untyped v1 vouchers have no rung and keep the stable-id tie-break. `NONE` everywhere remains a candidate, so AUTO is never dearer than no voucher. Bounds: at most 8 slots and 50 merchandise candidates in play and at most 20.000 cells, otherwise `INVALID_INPUT` (fail closed). Manual locks are per slot; when a combination cannot honour every lock the shipping lock is dropped first, then merchandise locks from the lowest priority up, each with a notice.

### D-5 Holds, proof, redemption, snapshot

- A hold request lists grants by slot and releases every other live hold of the attempt, all or nothing, with the same lock order as ADR 0019 (cart row, campaigns ascending by id, hold rows). Each tier keeps its own ledger counters.
- The signed proof and the quote digest bind the full ordered list of merchandise vouchers (id, revision, amount, slot), not one id.
- Acceptance consumes every declared hold in one transaction; one redemption per slot. A refund remains a per-redemption compare-and-set.
- `VoucherOrderSnapshot` moves to `v: 2` with `merchandise: [...]` (ordered). The parser still reads `v: 1` rows.
- A paid line touched by several vouchers carries one `VOUCHER` step per voucher in order, so the stored ledger still walks base price to paid price.

### D-6 Selection and distribution

Selection is per slot (AUTO, MANUAL tier, or explicit NONE). A CODE type is unlocked by applying its code; the saved selection marks that slot `unlocked` and from then on the type's tiers are read for this cart. A wrong, expired or exhausted type code answers the same `INVALID_CODE` as in v1.

### D-7 Admin

The Admin creates a type (name, priority, AUTO or CODE/PUBLIC|PRIVATE, code) and adds tiers to it (threshold, discount, optional scope, window, caps). Among the enabled tiers of a type with the same scope and discount kind, thresholds are distinct and a higher threshold must never save less: a higher fixed amount, or for a percentage a percent and a cap that are both not lower (no cap is the highest cap) and one of them higher. A rung that is better on small carts but capped lower on big ones is refused, so AUTO never picks a lower rung where a higher one is reached. Types and tiers follow the same revision, activation and cap-floor rules as v1 campaigns. A type carries a `revision` like a campaign: the form sends the revision it was opened at and a stale form is refused (`STALE_REVISION`). A type's stacking `priority` cannot change while a shopper holds a live (10-minute) hold on any of its tiers, because the order is part of every quote and of the digest a hold stores (`HOLDS_LIVE`); renaming is never blocked. The ladder rule judges benefit where a rung is reached: a percentage rung whose cap the lower rung already reaches at the higher threshold adds nothing and is refused.

## Consequences

- One slot per type is enforced by the database (unique indexes), not by convention.
- Percent-after-fixed ordering matters; priority is explicit and visible in Admin so the owner controls it.
- The grid is bounded and pure; the hold, acceptance and checkout paths grow from one merchandise voucher to a list.
- v1 behaviour is a strict subset: no typed campaign, no change.

## Rollback

Drop the new columns and the `VoucherType` table (list at the top of the migration) while no accepted order references a typed tier; leave `LA_VOUCHER_ENABLED` OFF. Nothing is read or written before that gate is on.

## Review checklist for the owner

- [ ] Sequential order and "threshold on the pre-voucher base" (D-3) match the intent, including the 520.000 example.
- [ ] Quota stays per tier with fall-back to a lower tier (Q5).
- [ ] One code per type (Q6) is acceptable for KOL use.
- [ ] The migration in D-2 is approved before any environment applies it.
