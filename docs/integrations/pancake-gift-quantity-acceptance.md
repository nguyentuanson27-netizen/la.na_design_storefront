# Pancake gift & quantity capability probe (GQ01 / R-06)

Status: **NOT RUN.** This document and `scripts/pancake-gift-quantity-capability-probe.ts` exist so an operator can produce the API-level evidence that Gift & Quantity Promotions v1 needs. No live Pancake call has been made by the project team for this feature; nothing below is a vendor-support claim until the operator records a run in the "Evidence log" section.

Governing decisions: [ADR 0016](../decisions/0016-gift-quantity-promotions-v1-decisions.md) (D-08: gift units are sent to Pancake at **1.000đ** each and 1.000đ per gift unit is deducted from the paid goods) and spec §4 FR-12 / R-06.

## What is proven and what is not

| Evidence | Proves | Does not prove |
|---|---|---|
| P10 ([`pancake-p10-custom-price-acceptance.md`](./pancake-p10-custom-price-acceptance.md)) | One positive custom price on one line of a variation is preserved | Several lines of one variation; 0đ lines; totals across lines |
| Owner screenshot, 2026-10-13 (Pancake order UI, SKU `SV2447-BE-S` on four lines at 7đ, 0đ, 699.000đ, 799.000đ) | The Pancake **UI** lets an operator keep several lines of one SKU at different unit prices, including 0đ | That the **create-order API** accepts the same shape, or how read-back reports it |

## Cases

| Case id | Lines (all the same variation) | Gating | Why |
|---|---|---|---|
| `PAID_PAID_DIFFERENT_PRICE` | 2 × 100.001đ + 1 × 90.001đ = **290.003đ** | yes | EX-17: tier `FROM_REACHED_THRESHOLD` splits one variant into price segments; also what a gift deduction produces when it splits a paid segment |
| `PAID_GIFT_VENDOR_PRICE_SAME_VARIATION` | 1 × 99.000đ (paid) + 1 × 1.000đ (gift) = **100.000đ** | yes | D-08 projection when a gift shares a variation with a paid unit |
| `GIFT_ZERO_PRICE_INFORMATIONAL` | 1 × 100.000đ + 1 × 0đ | no | The flow no longer needs 0đ lines; run only if the owner wants the fact recorded |

A case **passes** only when read-back returns every requested `(variation, unit price, quantity)` with no merged, averaged or dropped line **and** `total_price` equals the expected merchandise total (P10 observed `total_price` as merchandise total with shipping reported separately).

## Operator checklist (before running)

1. Written operator approval for **this shop** and **these cases**; use a test shop or a clearly marked test variation with stock for at least the largest selected case (3 units for the paid/paid case).
2. Confirm the order will be cancelled by the script (`PUT … {status: 7}`) and who watches for a failed cancel.
3. Server-only credentials in `.env.local`: `PANCAKE_API_KEY`, `PANCAKE_SHOP_ID`. Never in CI; the script refuses `CI`/`GITHUB_ACTIONS`.
4. The probe's customer/address constants are the fixed, clearly-marked test values reused from the P10 script (`TEST … KHONG GIAO`, `0900000000`, province/district/commune ids). If the target shop rejects them, the operator adjusts them in the shared P10 constants in a reviewed change; the probe never takes customer data from the environment.
5. Choose the probe variation (`GQ_POS_PROBE_VARIATION_ID`) and its product code for the preflight search (`GQ_POS_PROBE_PRODUCT_CODE`).

## Run

```bash
GQ_POS_PROBE_APPROVED=shop:<PANCAKE_SHOP_ID> \
GQ_POS_PROBE_CASES=PAID_PAID_DIFFERENT_PRICE,PAID_GIFT_VENDOR_PRICE_SAME_VARIATION \
GQ_POS_PROBE_VARIATION_ID=<variation uuid> \
GQ_POS_PROBE_PRODUCT_CODE=<product code> \
pnpm pancake:gift-quantity:probe
```

Exit codes: `0` all selected gating cases passed **and** no test order may be open (every case either was explicitly refused by the POS, or created an order that was read back as status 7); `2` at least one gating case did not pass; `3` a test order **may still be open**: a cancellation was not proven, or a create gave no definite answer so an order of unknown id may exist (find it by the run id in the order note and cancel it first; takes priority over `2`, and applies to informational cases too); `1` refused or crashed.

Safety properties (covered by `tests/domain/pancake-gift-quantity-capability-probe.test.ts` with a fake client):

- refuses CI and anything except the exact `shop:<id>` approval; a refused run makes no network call;
- stock preflight before the first write;
- **one create attempt per case, never retried** (Pancake has no idempotency key); an ambiguous response stops the run and reports the run id used in the order note (`GQ01 <runId> <case> - DO NOT SHIP`) so the operator can search the POS and cancel any order found;
- the created order is cancelled on every path after creation; a case whose cancellation is not proven is reported `CLEANUP_NOT_CONFIRMED`, never `PASS`, and **stops the run**; the cancel call's own `success: true` is not proof, the order is read back and must report status 7 so no further order is created while one is still open;
- the report contains no API key and no customer data beyond the fixed test constants.

## Interpreting results and the fallback if a case fails

| Result | Consequence |
|---|---|
| Both gating cases `PASS` | Record in the evidence log; the gift path and `FROM_REACHED_THRESHOLD` may be enabled by the owner later, behind the default-OFF gate and after the other release gates |
| `PAID_PAID_DIFFERENT_PRICE` fails | `FROM_REACHED_THRESHOLD` and any deduction that splits a paid segment stay OFF. `ALL_ELIGIBLE_UNITS` tiers (one price per variation per line) are unaffected |
| `PAID_GIFT_VENDOR_PRICE_SAME_VARIATION` fails | Gift campaigns stay OFF for gifts whose variation also appears in the paid goods. Owner may choose: forbid gifts that share a variation with a paid line, or approve an alternative below |
| Both fail | Gift and FROM stay OFF until an alternative is approved |

Alternatives to propose to the owner (none is approved or implemented; each needs its own spec amendment and acceptance run):

1. **Order-level discount instead of a line price split** — only if the POS exposes an order-level discount field that read-back reports exactly; needs discovery first.
2. **Restrict the promotion** so the failing shape cannot occur (for example no gift sharing a paid variation; tiers `ALL_ELIGIBLE_UNITS` only).
3. **Operator-side manual line split** for the rare order, with an explicit audit note — a manual process, not an automatic one.

The project never averages or re-rounds prices to dodge a vendor limitation (spec FR-12).

## Evidence log

| Date | Operator | Shop | Cases run | Outcomes | Report location |
|---|---|---|---|---|---|
| — | — | — | — | NOT RUN | — |
