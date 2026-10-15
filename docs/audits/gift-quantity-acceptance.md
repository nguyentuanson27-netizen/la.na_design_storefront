# Gift & Quantity Promotions v1 — Integration Acceptance & Rollout Gate (GQ25)

Owning sources: `docs/specs/gift-quantity-promotions-v1.md` (§EX-01..EX-22, §AC-01..AC-12),
`docs/decisions/0016-*`, `tasks/gift-quantity-promotions-v1-todo.md` §GQ25, rollback record
`docs/audits/gift-quantity-rollback.md`, live POS record `docs/integrations/pancake-gift-quantity-acceptance.md`.

## Verdict

**NOT READY TO SHIP — build complete except GQ19 (buyer checkout UX); feature stays default OFF.**
This record is a map from each requirement to the test that proves it, plus an explicit list of what is
**not** proven. It is not a go/no-go and it does not enable anything: the flag
`LA_GIFT_QUANTITY_PROMOTIONS_ENABLED` stays unset, and the owner's go/no-go and the independent `/ship`
approval are separate, unmet gates (todo §H5). Nothing in this document is vendor acceptance that was not
actually run.

### Open items (each blocks turning the flag ON)

| # | Open item | Why it blocks |
|---|---|---|
| O-1 | **GQ19 — checkout UX not built.** Nothing in the buyer UI submits the benefit proof or the non-claim acknowledgement; the checkout link stays withheld for carts with gifts or split tier prices. | A buyer cannot complete a benefit order end to end in the browser. Server side (GQ17/18/20/21) is proven; the screen is not. |
| O-2 | **Live adapter-flow acceptance not run.** The two GQ01 gating cases ran live on shop 715077776 and passed (PAID+PAID different price; PAID + GIFT at 1.000đ, same variation). The production adapter (`createOrder` → `readOrder` read-back → confirm) has only run against fakes. | The read-back parser was written from the observed contract, not exercised against the live POS. |
| O-3 | **`LA_PANCAKE_LINE_LEVEL_PRICING_VERIFIED_SHOP_IDS` is empty** (by design). | Until the owner lists a shop, benefit orders are withheld before any POS write. |
| O-4 | **Alert thresholds are proposals** with no production baseline; no dashboard exists. | See rollback record §4. |
| O-5 | **H5:** exact-head CI on the final PR(s), owner go/no-go, independent `/ship` approval. | Required by the todo; cannot be inferred from this document. |
| O-6 | **Credential hygiene:** the Pancake API key used for GQ01 was shared in chat. | Rotate it before any further use. |

### Known limitations (accepted in design, listed so nobody is surprised)

- The render proof has no clock; it expires by recomputation (any price/gift/slot/revision/stock change makes
  it stale). Only the non-claim acknowledgement carries a 2-hour TTL.
- Replay of an unchanged proof on the same cart is harmless and idempotent (no nonce store, same trade-off as P9a).
- A fresher Pancake base price for a benefit order is handled as a re-quote (buyer reconfirms), not a silent reprice.
- `benefit.quote_summary` counts checkout attempts, not distinct buyers.

---

## EX-01 … EX-22

"D" = `tests/domain/…`, "DB" = `tests/database/…`, "E2E" = `tests/a11y-runtime/…` (Chromium, 390 px).

| EX | Requirement (short) | Evidence | Status |
|---|---|---|---|
| 01 | QUANTITY N=2, Q=1/2/4/6 → 0/1/2/3 | D `gift-quantity-entitlement` | proven |
| 02 | maxGiftsPerOrder caps 5 → 3 | D `gift-quantity-entitlement` | proven |
| 03 | ORDER_SUBTOTAL boundary 999.999/1.000.000 | D `gift-quantity-entitlement` | proven |
| 04 | S=2.5m: ONCE 1, REPEAT 2 | D `gift-quantity-entitlement` | proven |
| 05 | ALL_PAID vs ELIGIBLE_PAID | D `gift-quantity-entitlement`, `gift-quantity-scope` | proven |
| 06 | Q counts items across variants/set = 1 | D `gift-quantity-entitlement`, `gift-quantity-scope` | proven |
| 07 | Tier ALL vs FROM_REACHED_THRESHOLD | D `gift-quantity-tier` | proven (R-05 `N0` reading approved at H0, ADR 0016) |
| 08 | FROM + CHEAPEST / MOST_EXPENSIVE | D `gift-quantity-tier` | proven |
| 09 | Flash 10% then Tier 5% = 855.000đ | D `gift-quantity-stack`; DB `gift-quantity-cart-quote` | proven |
| 10 | Threshold judged after discounts | D `gift-quantity-entitlement` | proven |
| 11 | Earned 3, stock 1, take 1, 2 unclaimed acknowledged | D `gift-quantity-entitlement`; DB `benefit-checkout-snapshot` (FR-06 tests); D `checkout-benefit-quote` | proven server side; **buyer screen = O-1** |
| 12 | Earned 2, take 0 with acknowledgement | DB `benefit-checkout-snapshot` ("taking none is a full non-claim") | proven server side; **buyer screen = O-1** |
| 13 | Gift same variant: paid/gift split, one physical hold, POS contract | D `checkout-benefit-quote`; DB `benefit-checkout-snapshot` (one hold per variant); live GQ01 case 2 | quote/hold proven; POS contract proven live for the **probe**, not the adapter (O-2) |
| 14 | Changing the gift (same total) stales the proof | D `checkout-benefit-quote` ("EX-13/14 …stale even when the total is identical") | proven server side; **re-confirm screen = O-1** |
| 15 | Allowed variants only | D `gift-quantity-entitlement` | proven |
| 16 | Dynamic vs Fixed scope | D `gift-quantity-scope` | proven |
| 17 | 3 × 100.001đ, tier FROM → 2 × 100.001 + 1 × 90.001 = 290.003đ, two lineIds | D `checkout-benefit-quote`, `order-quote-snapshot`, `pancake-gift-projection`; DB `benefit-checkout-snapshot`, `order-quote-snapshot`; live GQ01 case 1 (read back unmerged, 290.003đ) | proven (adapter live run = O-2) |
| 18 | One reservation of 3 physical units | DB `benefit-checkout-snapshot` ("ONE hold per variant"), `order-quote-snapshot` | proven |
| 19 | Non-monotonic total discount detected/rejected | D `gift-quantity-tier`; E2E `admin-gift-quantity` | proven (R-05 approved at H0) |
| 20 | Fixed scope frozen at publish; scheduled edit re-freezes | DB `gift-quantity-activation-service` | proven |
| 21 | Fixed VND tier below price → whole tier dropped, reconfirm | D `gift-quantity-tier`, `gift-quantity-stack`; DB `gift-quantity-cart-quote`, `gift-quantity-tier-rule-operations`, `benefit-checkout-snapshot` (EX-21); E2E `cart-gift-picker` | proven; reason stored in `droppedBenefits` |
| 22 | Global ALL_PAID_LINES gift, no scope | D `gift-quantity-entitlement`, `gift-quantity-scope`; DB `gift-quantity-admin-operations`; E2E `admin-gift-quantity` | proven |

## AC-01 … AC-12

| AC | Statement (short) | Evidence | Status |
|---|---|---|---|
| 01 | Admin creates GIFT_ITEM (QUANTITY/ORDER_SUBTOTAL, ALL/ELIGIBLE, ONCE/REPEAT) | DB `gift-quantity-admin-operations`; E2E `admin-gift-quantity` | proven |
| 02 | Dynamic/Fixed scope, snapshot inside the publish transaction | D `gift-quantity-scope`; DB `gift-quantity-activation-service` | proven |
| 03 | Gift list, allowed variants, duplicates, max per order | DB `gift-quantity-admin-operations`; D `gift-quantity-entitlement` | proven |
| 04 | Earned/selected boundaries; 0..entitled; acknowledgement when short | D `gift-quantity-entitlement`; DB `benefit-checkout-snapshot`; E2E `cart-gift-picker` | proven server side; **buyer acknowledgement screen = O-1** |
| 05 | Highest tier only; non-decreasing; ALL/FROM from N0; multi-price lines | D `gift-quantity-tier` | proven (R-05 approved at H0) |
| 06 | Stack by priority from remaining price; invalid VND → drop whole tier + requote | D `gift-quantity-stack`; DB `gift-quantity-cart-quote`, `benefit-checkout-snapshot` | proven |
| 07 | Gift threshold after all discounts, before shipping, gifts excluded; one price authority | D `gift-quantity-entitlement`, `checkout-benefit-quote` (GQ22 shipping); DB `gift-quantity-listing-parity` (GQ23) | proven |
| 08 | Quote proof signs every lineId, role, quantity, price, step | D `checkout-benefit-quote` | proven |
| 09 | Reservation/submit idempotent; paid+gift merged; concurrency | DB `benefit-checkout-snapshot` (idempotent retry, single hold, unknown-then-retry) | proven |
| 10 | Pancake live acceptance: gift, PAID+GIFT same variation, PAID+PAID different price | `docs/integrations/pancake-gift-quantity-acceptance.md` (run `ab50e3dd`); D `pancake-gift-projection`, `pancake-order-readback`; DB `benefit-checkout-snapshot` (GQ20/21) | **partial**: both gating probe cases passed live; `GIFT_ZERO_PRICE` informational case not run (not gating under D-08); adapter flow vs live POS not run (O-2) |
| 11 | Order snapshot immutable; shipping/analytics/feeds/preorder/legacy not regressed | DB `order-quote-snapshot` (immutability triggers), `benefit-analytics`, `gift-quantity-listing-parity`; flag-OFF legacy test in `benefit-checkout-snapshot` | proven |
| 12 | Domain/DB/E2E/a11y/security/observability/release gates, DoD, rollback | §Gates below; `gift-quantity-rollback.md` | **partial** — see O-1…O-6 |

---

## Flag OFF regression

With `LA_GIFT_QUANTITY_PROMOTIONS_ENABLED` unset/false: `resolveBenefitCheckoutQuote` returns `LEGACY` before
any query; no quote rows are written; a tier price is not applied; the legacy `laq2` proof path is untouched
(`benefit-checkout-snapshot` "with the gate OFF the checkout is the legacy one byte for byte"); listings,
PDP, Merchant output are byte-identical with and without active tier/gift campaigns
(`gift-quantity-listing-parity`); legacy `pancake_order.*` events are unchanged (the new `benefit` tag is only
present on benefit orders, and every existing event assertion still passes).

## Security / PII / bounds review (summary)

- Proof canonicalisation (domain-separated prefixes and keys, length-prefixed fields, cart binding, size bounds,
  constant-time compare): recorded in todo GQ16.
- Telemetry: closed vocabularies, counts only, no cart UUID/token/PII/money/campaign id (rollback §1, test
  `benefit-telemetry`).
- Bounds: 200 quote lines, 8 steps/line, 20 entitlements, 100 gift units, 48 KiB proof, 512 B acknowledgement,
  50 dropped-benefit records, 1024-byte log line.
- The Pancake key never entered the repository (verified before every commit of the GQ01 work); it must still be
  rotated (O-6).

## Staged ON path (for the owner, after O-1…O-3)

1. Build/merge GQ19; run the browser flow on staging with the flag ON.
2. Run the adapter-flow live acceptance with explicit operator approval (creates and cancels test orders).
3. List the verified shop id in `LA_PANCAKE_LINE_LEVEL_PRICING_VERIFIED_SHOP_IDS`.
4. Confirm the alert thresholds and wire the alerts. (R-05 was approved by the owner at H0 on 13/10/2026, recorded in ADR 0016 and the spec status.)
5. Flag ON with a single low-risk campaign; watch the rollback record §4 for 30 minutes; keep §6 ready.
6. Separate owner go/no-go and `/ship`.

## Gates (local, this branch)

Filled in from the run recorded below; CI on the exact PR head is the authoritative result.

| Gate | Result |
|---|---|
| `pnpm prisma:validate` | pass |
| `pnpm lint` | 0 errors (pre-existing warnings only; none in the new files) |
| `pnpm typecheck` | pass |
| `pnpm test` (domain + integrations) | 3110 tests, 0 fail |
| `pnpm test:db` (real PostgreSQL 16) | 862 tests, 0 fail |
| Playwright (a11y-runtime) | 291 passed, **1 failed**: `footer-support.spec.ts:389` (footer contact row wraps to 2 lines at 390 px). No footer or global-CSS file is touched by this work; the test is font-metric sensitive and the sandbox has no web fonts. Not re-run on `main`, so "environmental" is an attribution, not a proof; CI decides. Run from `tests/a11y-runtime` (its own Playwright install), `PANCAKE_SHOP_ID=920942` |
| `pnpm build` | pass |
| `pnpm release:check` | **not run**: `scripts/release-readiness.ts` calls the live Pancake API and needs `PANCAKE_API_KEY`; the only key available was shared in chat and is not approved for this use. Run it in the real environment |
