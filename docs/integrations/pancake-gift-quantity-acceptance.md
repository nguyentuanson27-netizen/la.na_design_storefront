# Pancake gift & quantity capability probe (GQ01 / R-06)

Status: **RUN 2026-10-14 (shop 715077776): both gating cases PASS** — see the Evidence log. This document and `scripts/pancake-gift-quantity-capability-probe.ts` exist so an operator can produce the API-level evidence that Gift & Quantity Promotions v1 needs. The only vendor-support claims are those recorded in the "Evidence log" section, for the shop and date stated there.

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

## Adapter-flow acceptance (acceptance record O-2)

The probe above proves the vendor behaviour with its own parser. `scripts/pancake-gift-quantity-adapter-acceptance.ts` runs **the code a benefit order really uses** on the same kind of controlled test order, so the read-back contract (`id`, `shop_id`, `status`, `total_price`, line prices) is exercised against the live POS rather than a fake:

quote lines -> D-08 projection -> `buildPancakeCreateOrderRequest` -> `gateway.createOrder` -> `parsePancakeCreateOrderResponse` -> `gateway.readOrder` -> `compareOrderReadBack(projection, readBack, { orderId, shopId })` must be `MATCH` -> `gateway.cancelOrder` -> read again: the production comparison must call it `canceled` (status 7).

Cases: `ADAPTER_TIER_SPLIT_PAID` (2 x 100.001đ + 1 x 90.001đ, 3 units) and `ADAPTER_PAID_PLUS_GIFT_SAME_VARIATION` (paid 100.000đ + gift, projected to 99.000đ + 1.000đ, 2 units). Same safety model and the same approval variables as the probe (`GQ_POS_PROBE_APPROVED=shop:<id>`, variation and product code, run id; refuses CI; one create per case, never retried; cancelled on every path; an unproven cancellation is never a pass and stops the run; no API key in the report).

```bash
GQ_POS_PROBE_APPROVED=shop:<PANCAKE_SHOP_ID> \
GQ_POS_PROBE_VARIATION_ID=<variation uuid> \
GQ_POS_PROBE_PRODUCT_CODE=<product code> \
pnpm pancake:gift-quantity:adapter
```

Exit codes: `0` both cases `PASS` and no order may be open; `2` a case did not pass; `3` an order may still be open (find it by the run id in the order note `TEST AUTOMATION GQ ADAPTER <runId> ...` and cancel it first); `1` refused or crashed. Covered by `tests/domain/pancake-gift-quantity-adapter-acceptance.test.ts` with a fake gateway. A `PASS` here is what lets the operator list the shop in `LA_PANCAKE_LINE_LEVEL_PRICING_VERIFIED_SHOP_IDS`; a `FAIL_READBACK_NOT_MATCH` or `FAIL_CANCEL_NOT_OBSERVED` means the parser's assumption about a field is wrong for this POS and the shop must stay unlisted.

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
| 2026-10-14 | Repository owner (run through a Claude Code session) | 715077776 | `PAID_PAID_DIFFERENT_PRICE`, `PAID_GIFT_VENDOR_PRICE_SAME_VARIATION` (run id `ab50e3dd`; variation `9e7a1103-6e08-4580-be46-41678726f1dd`, SKU `SQ069S`, stock 5 before the run) | Both **PASS**, exit 0. Case 1: lines 2 × 100.001đ + 1 × 90.001đ read back unmerged, `total_price` 290.003đ. Case 2: lines 1 × 99.000đ + 1 × 1.000đ read back unmerged, `total_price` 100.000đ. Both test orders (POS ids 1 and 2) were cancelled and read back as status 7; `noOrderMayBeOpen: true`. `GIFT_ZERO_PRICE_INFORMATIONAL` was not run (not gating under D-08). | Report below |

### Run report (2026-10-14, run id `ab50e3dd`)

Raw probe output, no key and no customer data (the probe prints neither). Produced with `NODE_USE_ENV_PROXY=1` because the sandbox reaches the POS only through an egress proxy and Node's `fetch` ignores `HTTPS_PROXY` otherwise.

| Case | Requested lines | Read-back lines | Expected / read-back / order total | Cleanup |
|---|---|---|---|---|
| `PAID_PAID_DIFFERENT_PRICE` | 2 × 100.001đ, 1 × 90.001đ | 2 × 100.001đ, 1 × 90.001đ (same variation, not merged) | 290.003đ / 290.003đ / 290.003đ | status 7 |
| `PAID_GIFT_VENDOR_PRICE_SAME_VARIATION` | 1 × 99.000đ, 1 × 1.000đ | 1 × 99.000đ, 1 × 1.000đ (same variation, not merged) | 100.000đ / 100.000đ / 100.000đ | status 7 |

What this proves: on this shop the create-order API accepts several lines of one variation at different unit prices and reports them back unmerged with the merchandise total equal to the sum of the lines. What it does not prove: behaviour on any other shop or variation, a variation that also has a discount or voucher, shipping, or stock reservation effects (the probe measures none of them), or that the same shape survives a later edit of the order in the POS UI. One run is one observation; re-run before enabling the flag in production if the POS integration or the shop changes.
