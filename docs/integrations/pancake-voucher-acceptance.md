# Pancake — Voucher v1 exact-money, status and probe boundary

- **Status:** Offline design input for gate **H1-D**. No Pancake call has been made for this document.
- **Task:** V00 of [`tasks/storefront-voucher-v1-plan.md`](../../tasks/storefront-voucher-v1-plan.md). Architecture: [ADR 0018](../decisions/0018-voucher-v1-accepted-order-architecture.md).
- **Spec:** [`docs/specs/storefront-voucher-v1.md`](../specs/storefront-voucher-v1.md) §4.1 step 3, TG-02, TG-04, AC-20.
- **Builds on:** ADR 0016 D-08 / D-13 and `src/commerce/pancake-gift-projection.ts`.

## 1. What the vendor can and cannot take

Pancake takes **line prices only**: `(variation, quantity, unitPrice)`. The website quote carries exact per-line money, a merchandise voucher is a *total* `D`, and a gift is sent at 1.000đ with the same amount carved out of paid units (D-08). The vendor total must equal the website total to the VND, so a voucher must be representable as line prices, together with the gift offset, or it must not exist for that cart.

Pipeline (all pure, all offline, all in the repo):

1. `quoteMerchandiseVoucher` (V02) gives `D` and a per-line allocation; each line becomes at most two segments whose prices differ by 1đ.
2. Those segments are the PAID lines of `projectBenefitQuoteForVendor` (existing): the gift offset walks paid units dearest-first, each unit keeping at least 1đ.
3. `canProjectExactMoney(completeQuote)` (V09) is `allocation ok AND projection ok AND vendor total == website total`. Anything else is **infeasible**: the candidate is excluded from AUTO, a manual choice is reported unavailable, no hold is granted and no POS call is made (AC-20).

## 2. Offline fixtures

Asserted in `tests/domain/voucher-vendor-fixtures.test.ts` against the real allocator and the real projection; the numbers below are copied from those tests.

| ID | Website paid lines | Voucher `D` | Gifts | Vendor lines | Vendor total |
| --- | --- | --- | --- | --- | --- |
| F1 | `V1` 3 × 100.000 | 10.000 | — | `V1` 2 × 96.667, `V1` 1 × 96.666 | 290.000 |
| F2 | `V1` 1 × 300.000; `V1` 2 × 150.000 (same variation, two website lines) | 50.000 | — | `V1` 1 × 275.000, `V1` 2 × 137.500 | 550.000 |
| F3 | `V1` 2 × 250.000; `V2` 1 × 150.000 | 80.000 | `G1` × 1 | `G1` 1 × 1.000, `V1` 1 × 219.231, `V1` 1 × 218.231, `V2` 1 × 131.538 | 570.000 |
| F4 | `V1` 2 × 2; `V2` 1 × 1.000 | 1.000 | — | `V1` 2 × 1, `V2` 1 × 2 | 4 |
| F5 | as F4 | 1.000 | `G1` × 2 | **infeasible** (`VENDOR_PROJECTION_INFEASIBLE`) | — |

What the fixtures establish, and what they do not:

- Repeated variations and a variation split over several website lines are represented as separate vendor lines at different prices; nothing is averaged or rounded to fit.
- F3 shows the order of operations: voucher allocation first, gift offset second, and the vendor total still equals `650.000 − 80.000 = 570.000`.
- F5 shows why feasibility must be evaluated on the **complete** quote (voucher + gift + shipping), not on the voucher alone: F4's voucher is fine on its own and becomes unrepresentable once a gift needs 2.000đ to come from units already at the floor.
- They do **not** prove Pancake accepts these lines, stores them unchanged, or reads them back unchanged. That is H1-V.

## 3. Status and cancellation (TG-04)

The reconciliation service stores Pancake's raw integer status (`pancakeStatus`) and the local state machine is `DRAFT → VALIDATING → POS_SUBMITTING → CONFIRMED / REJECTED / SYNC_UNKNOWN`. There is **no proven mapping** from a Pancake status code to "cancelled". Until one is proven:

| Signal | Voucher effect |
| --- | --- |
| Local `CONFIRMED` | none (already consumed at website acceptance) |
| Local `REJECTED` with evidence the order was not created | refund once |
| Local `SYNC_UNKNOWN`, timeout, network error, unmapped status | **pending**, alert, no refund |
| Status code documented *and* observed as cancel for this shop | refund once (after the mapping is added with its evidence) |
| Admin cancel with audit | refund once |

The mapping, the shop-scope verification and the replay/out-of-order cases are V14 work; this document only fixes the rule that a guess is never a refund.

## 4. Operator probe boundary

> **Status 2026-10-26:** H1-V was authorised by the owner and run — F1–F4 4/4 PASS, test orders cancelled (status 0 → 7). Evidence: [`docs/verification/storefront-voucher-v1-pos-probe.md`](../verification/storefront-voucher-v1-pos-probe.md). Re-run `pnpm pancake:voucher:accept` (same approval variables as the gift-quantity probe) for any other shop before listing it in `LA_PANCAKE_VOUCHER_VERIFIED_SHOP_IDS`.

Approving the plan, the ADR or this document does **not** authorize a Pancake write. H1-V needs a separately authorized, operator-run sandbox probe:

- shop and token supplied by the operator at run time, never committed or logged;
- creates only clearly labelled test orders and records their ids for cleanup;
- for each of F1–F4: write the vendor lines, read the order back, and compare `(variation, quantity, unitPrice)` and the order total to the fixture to the VND; record the status code Pancake reports for created and for cancelled test orders (this also supplies the TG-04 mapping evidence);
- stores the evidence under `docs/verification/` in the V09/V20 PRs;
- if permission or sandbox access is unavailable, real holds stay OFF and V12/V13 do not ship (plan §3).

## 5. Rollback and feature-off behaviour

Nothing in this document changes runtime. When voucher code lands behind `LA_VOUCHER_ENABLED`, flag OFF removes new candidates and holds only; orders already accepted keep their frozen vendor projection and continue to reconcile (ADR 0018 D-6).
