# Gift & Quantity Promotions v1 — Telemetry, Kill Switch, Audit & Rollback Readiness (GQ24)

Owning sources: `docs/decisions/0016-*` (D-04, D-08, D-09), `tasks/gift-quantity-promotions-v1-todo.md` §GQ24,
parent runbooks `docs/operations/release-and-rollback.md` and `docs/operations/promotion-rollback-runbook.md`.

Status: **READY FOR OWNER REVIEW.** Everything below that is code is covered by the tests listed in §8. The
alert **thresholds** in §4 are proposals derived from the signal design, not measured production baselines
(the feature has never run in production); the owner confirms or changes them before the flag is turned ON.

---

## 1. Guarantees

1. **One kill switch.** `LA_GIFT_QUANTITY_PROMOTIONS_ENABLED` (exact string `true` = ON; unset, empty, `false`
   or anything else = OFF). It is independent of `LA_PROMOTION_ACTIVATION_ENABLED`.
2. **OFF means legacy, byte for byte.** With the gate OFF, no benefit campaign is read, no tier price is
   applied, no gift is offered, the checkout writes no quote rows, and `resolveBenefitCheckoutQuote` returns
   `LEGACY` before any query (`tests/database/benefit-checkout-snapshot.test.ts` — "with the gate OFF the
   checkout is the legacy one byte for byte").
3. **Old orders are not rewritten.** A confirmed benefit order keeps its quote rows (immutable once the
   order leaves DRAFT, enforced by database triggers). Turning the flag OFF does not touch, re-price,
   cancel or re-send any of them.
4. **An in-flight draft is never silently re-priced.** A DRAFT created while the flag was ON and submitted
   after it went OFF is closed as `REJECTED / BENEFIT_REQUOTE_REQUIRED` (the buyer sees `CART_CHANGED`),
   nothing is sent to Pancake, its holds are released at once, and its quote rows stay as history (a
   quote-bearing order can never return to DRAFT). The buyer's next submit creates a new, legacy-priced order
   (test "GQ24 kill switch").
5. **Audit trail survives the campaign.** Every GIFT line stores the campaign id **and revision**; every
   tier step stores its campaign id and the input/output price; the order stores the quote digest and the
   frozen Pancake projection hash. Editing, disabling or ending the campaign later does not change them
   (test "GQ24 audit"). The campaign's own revision history is advanced under the single global
   `PromotionPricingRevision` lock, so "which rules were live at time T" is answerable from the two tables.
6. **No identifying data in telemetry.** Signals are fixed-shape JSON lines (< 1024 bytes) holding counts and
   closed-vocabulary codes. They never contain a cart UUID, a proof or acknowledgement token, a customer
   field, an address, money, a variant id or a campaign id (test "GQ24: signals are single short NDJSON
   lines…"). The `pancake_order.*` events carry only the order's public correlation code.

---

## 2. Signals (the collected stream is stdout NDJSON, per ADR 0002)

Counters are **derived by counting log lines** by `name` (+ field); there is no in-process counter store, so
nothing is lost on restart and nothing can leak through a metrics label.

| Wanted metric | Signal | Field to count |
|---|---|---|
| Stack conflict (a campaign dropped because it may not stack) | `benefit.quote_summary` | `stackConflicts` |
| `TIER_PRICE_INVALID` (a tier whose runtime price became invalid and was dropped) | `benefit.quote_summary` | `tierPriceInvalid` |
| Tier config/input invalid | `benefit.quote_summary` | `tierConfigInvalid` |
| Entitlement (slots earned / taken) | `benefit.quote_summary` | `entitledSlots`, `selectedSlots` |
| Unclaimed gift slots | `benefit.quote_summary` | `unclaimedSlots` |
| Stock insufficient for a gift | `benefit.quote_summary` | `stockShortSlots` |
| Stock insufficient at validation / reservation | `pancake_order.validation_rejected` | `reason=STOCK_UNAVAILABLE` |
| Quote stale / proof rejected | `benefit.checkout_outcome` | `outcome=QUOTE_STALE` (+ `proofReason`) |
| Buyer did not acknowledge unclaimed slots | `benefit.checkout_outcome` | `outcome=NONCLAIM_UNACKNOWLEDGED` |
| Stored gift choice no longer valid | `benefit.checkout_outcome` | `outcome=GIFT_SELECTION_INVALID` |
| Benefit checkout unavailable / projection infeasible | `benefit.checkout_outcome` | `CHECKOUT_UNAVAILABLE`, `VENDOR_PROJECTION_INFEASIBLE` |
| Re-quote required at submit (rules moved, or kill switch) | `pancake_order.benefit_requote_required` | — |
| Benefit submission withheld (shop lacks line-level acceptance) | `pancake_order.benefit_submission_withheld` | — |
| POS rejected | `pancake_order.create_rejected` | `benefit=true` |
| POS unknown | `pancake_order.create_unknown` | `benefit=true` |
| POS drift / read-back unavailable | `pancake_order.benefit_readback_unconfirmed` | `reason=RECONCILE_DRIFT \| READBACK_UNAVAILABLE` |
| Benefit orders started / confirmed | `pancake_order.create_started`, `pancake_order.confirmed` | `benefit=true` |

`benefit.quote_summary` is emitted **once per checkout attempt that resolves to a benefit quote** (a retry
counts again), so read it as an attempt-level rate, not as a count of distinct buyers.

---

## 3. Owners

| Role | Responsibility |
|---|---|
| **Store owner (Gift & Quantity operator)** | Decides ON/OFF; is paged for the triggers in §5; reconciles SYNC_UNKNOWN orders against the Pancake POS. |
| **On-call engineer** | Executes §6; confirms the container env after recreate; files the incident. |

(Named individuals are recorded by the owner in the deployment's on-call sheet; this repository does not
hold personal contact data.)

---

## 4. Alert definitions (PROPOSED — confirm before enabling the flag)

Evaluate over a rolling 30 minutes, ignoring windows with fewer than 20 benefit checkout attempts
(`benefit.quote_summary` lines) unless stated.

| Alert | Condition | Severity |
|---|---|---|
| POS unknown | any `create_unknown` with `benefit=true` that is still SYNC_UNKNOWN after 15 minutes | **Page** |
| POS drift | any `benefit_readback_unconfirmed` | **Page** (money risk: POS total/lines differ from the website quote) |
| POS rejected | ≥ 3 `create_rejected benefit=true` | **Page** |
| Quote stale storm | `QUOTE_STALE` ≥ 30 % of attempts | Warn; page at ≥ 50 % |
| Tier price invalid | any `tierPriceInvalid > 0` | Warn (campaign needs fixing) |
| Stack conflict | `stackConflicts > 0` in ≥ 10 % of attempts | Warn |
| Gift out of stock | `stockShortSlots > 0` in ≥ 10 % of attempts | Warn |
| Re-quote required | `benefit_requote_required` ≥ 5 | Warn (expected right after a deliberate kill switch) |
| Withheld | any `benefit_submission_withheld` after the shop was marked verified | Page |

---

## 5. Rollback triggers (turn the flag OFF)

Any one of:

- a **POS drift** or a **projection/total mismatch** on a benefit order (money does not match the website quote);
- a **POS unknown** that cannot be resolved by reconciliation within the agreed window;
- the **POS-rejected** or **quote-stale** page alerts above, with no campaign mistake to correct;
- a **pricing anomaly** reported on a tier or gift (wrong price, a gift shipped that was not earned);
- the owner decides the programme should stop for a business reason.

A single bad **campaign** (not the engine) is handled by disabling that campaign, not the whole flag
(`disableGiftQuantityCampaign`, O(1), advances the global pricing revision in its own transaction).

---

## 6. Procedure

### Tier 1 — kill switch (whole programme)

1. In the deployment environment (`deploy/vps/.env.production`) set `LA_GIFT_QUANTITY_PROMOTIONS_ENABLED=false`
   (or remove it).
2. From `deploy/vps`: `docker compose up -d --no-deps --force-recreate app` (a plain `restart` does **not**
   reload the environment).
3. Verify: `docker compose exec app node -e 'if (process.env.LA_GIFT_QUANTITY_PROMOTIONS_ENABLED === "true") process.exit(1)'`.
4. Effect, verified by tests: carts price with legacy rules only; no gift is offered; no tier price applies;
   a draft taken before the switch is closed `REJECTED / BENEFIT_REQUOTE_REQUIRED`, its stock goes back, and nothing is sent to Pancake.
   Expect a short burst of `benefit_requote_required` and buyers re-confirming a price — that is the switch
   working, not a new incident.
5. Do **not** delete or edit order quote rows, campaigns or `PromotionPricingRevision`. They are the audit
   trail and the triggers will refuse edits to non-DRAFT orders anyway.

### Tier 2 — one campaign

Disable it in Admin (or `disableGiftQuantityCampaign`). Open carts re-quote on their next view; drafts that
relied on it are closed `REJECTED / BENEFIT_REQUOTE_REQUIRED` and the buyer's next submit makes a new order.

### Tier 3 — the shop's POS acceptance

Remove the shop id from `LA_PANCAKE_LINE_LEVEL_PRICING_VERIFIED_SHOP_IDS` and recreate the container. Benefit
orders are then **withheld before any Pancake write** (`benefit_submission_withheld`); legacy orders are
unaffected. Use this when the flag should stay ON for browsing but POS submission must stop.

### Orders already in flight

- `SYNC_UNKNOWN` benefit orders keep their holds (UNKNOWN) and are settled by reconciliation only when the
  POS read-back matches the stored projection; otherwise they stay SYNC_UNKNOWN for the operator.
  Nothing is auto-confirmed, auto-released or auto-cancelled on drift.
- Confirmed orders are fulfilled normally; the gift is an ordinary 1.000đ line on the POS with the same
  amount deducted from the dearest paid units (ADR 0016 D-08), so the POS total equals the website total.

### Re-enabling

Fix the cause; run the §8 tests plus the live acceptance in `docs/integrations/pancake-gift-quantity-acceptance.md`
for any POS-related cause; set the flag ON; watch §4 for 30 minutes at low traffic.

---

## 7. What this does not cover (stated openly)

- Alert thresholds are proposals (§4) with no production baseline.
- Telemetry is log-line based; no dashboard or alert rule is created by this repository — the owner wires
  §4 into whatever collector reads the stdout stream.
- Live POS behaviour for the full adapter flow has not been run (see GQ25 acceptance record).

---

## 8. Evidence

| Claim | Test |
|---|---|
| Signals bounded, PII-free, closed vocabulary; observer failure never changes a checkout | `tests/domain/benefit-telemetry.test.ts` (6) |
| Outcomes emitted for each benefit stop; legacy failures not counted | same |
| Summary counts conflicts / invalid tier / unclaimed / stock | same + `tests/database/benefit-checkout-snapshot.test.ts` "GQ24: the quote summary…" |
| POS events of benefit orders tagged (confirmed / unknown / rejected) | `tests/database/benefit-checkout-snapshot.test.ts` "GQ24: the POS events…" |
| Kill switch: legacy quote, draft re-quote, nothing sent, old order intact | same file "GQ24 kill switch…" |
| Audit: campaign + revision survive campaign edits | same file "GQ24 audit…" |
| Gate OFF = legacy byte for byte | same file (GQ17 test) |
