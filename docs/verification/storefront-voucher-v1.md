# Voucher v1 — verification status

- **Status:** PARTIAL. Built and verified: V00–V06, V08, V10, V15–V17, V19. V09 now has its H1-V live evidence ([POS probe](./storefront-voucher-v1-pos-probe.md), 2026-10-26, 4/4 PASS); V07 (Admin browser/axe) still lacks one piece of evidence. **Not built** (blocked by gates that need a person): V11–V14 (V11–V14 are built; V18 remains), V18 (checkout exposure), V20/V21 completion, H3-V, H4, H5.
- **Rule used here:** a row is "verified" only when a named test exercises it against real code (and, where the criterion is about the database, a real PostgreSQL). Anything else is "pending" with the reason. Nothing is marked done from code presence.
- Spec: [`../specs/storefront-voucher-v1.md`](../specs/storefront-voucher-v1.md). Plan: [`../../tasks/storefront-voucher-v1-plan.md`](../../tasks/storefront-voucher-v1-plan.md).

## Acceptance criteria

`D` = `tests/domain/…`, `B` = `tests/database/…` (PostgreSQL 16, migrations applied), `U` = `tests/a11y-runtime/voucher-picker.spec.ts` (Chromium against a Next server).

| AC | Status | Evidence |
| --- | --- | --- |
| 01 one voucher per group | verified | D `voucher-optimizer`, `voucher-quote` |
| 02 merchandise + freeship combine exactly | verified | D `voucher-optimizer`, B `voucher-order-subtotal-checkout` |
| 03 EX-01 picks 600K | verified | D `voucher-optimizer`, `voucher-quote` |
| 04 manual lock kept / replaced with notice | verified | D `voucher-optimizer`, `voucher-quote`; B `voucher-selection` |
| 05 voucher after Flash/tier/ladder, D-12 intact | verified | D `voucher-money` (real `priceStack` ladder); B `voucher-order-subtotal-checkout` (real GQ ladder) |
| 06 scope: only in-scope lines count; dynamic categories | verified | D `voucher-scope`, `voucher-money`; B preview |
| 07 fixed min > amount; no unit under 1đ | verified | D `voucher-rule-validation`, `voucher-money` (randomized, 300 carts); B `voucher-schema` CHECKs |
| 08 gift lost under a voucher is reported | verified | D `voucher-optimizer`, `voucher-quote`, `voucher-picker-model` |
| 09 freeship threshold after the merchandise voucher | verified | D `voucher-shipping`, `voucher-quote` |
| 10 shipping already 0 → freeship not selected | verified | D `voucher-shipping`, `voucher-quote` |
| 11 "Đặt thêm Xđ" from the server subtotal | verified | D `voucher-quote`, `voucher-picker-model`; B preview; U |
| 12 picker mobile + desktop, a11y | verified (mobile viewport 390px; axe clean; radio rows ≥ 44px; Escape closes and returns focus) | U — **desktop viewport and the real-device check are not run** |
| 13 PRIVATE code, KOL link, invalid code | verified (server) | B `voucher-candidates`, `voucher-selection` (uniform INVALID_CODE, throttle); D `voucher-marketing-link`; U |
| 14–16 quota/budget races, expiry, reload/2 tabs | **pending V11/V12** | DB invariants only: `voucher-schema` (partial unique live hold, absolute TTL, no oversubscribe) |
| 17–19 accept → consume once; reject vs unknown; cancel refunds once | **pending V13/V14** | DB guards only: `voucher-schema` (acceptance insert-only, redemption needs consumed hold + accepted order, refund CAS one-way) |
| 20 unrepresentable POS money → no hold, no proof | verified at the representation level **and through the hold POST** (B `voucher-hold-flow`: the flow re-runs `canProjectExactMoney` before any hold; a cart it cannot represent leaves no hold, no budget, no proof) | D `pancake-voucher-projection` (AUTO excludes, manual reported `POS_INFEASIBLE`); H1-V live readback PASSED 2026-10-26 ([evidence](./storefront-voucher-v1-pos-probe.md)) |
| 21 Admin edit/disable keeps history and live holds | verified | B `voucher-admin-operations`, `voucher-admin-cap-edit` |
| 22 cart/checkout/commit/Pancake agree | partial | quote ↔ proof ↔ order snapshot ↔ vendor projection are built and tested (D `voucher-quote-proof`, `pancake-voucher-projection`); checkout/submit wiring **pending V13/V18** |
| 23 voucher read fails → never a silently dearer total | partial | `readVoucherPreview` returns `QUOTE_UNAVAILABLE` and the cart renders its plain totals; submit-side behaviour pending V12/V13 |
| 24 flag OFF = main | verified | D `voucher-gate`; B `voucher-order-subtotal-checkout`, `voucher-candidates`, `voucher-selection` (nothing read or written) |
| 25 other shop / replay / forged money | verified (server) | B admin + selection isolation; D `voucher-selection-input` (money/revision/cart keys rejected) |
| 26 picker open/close keeps COD form and gifts | partial | U: a draft is not saved and closing keeps the old choice; the COD form/gift part belongs to checkout (V18) |
| 27 refund after campaign expiry | **pending V14** | DB: refund never touches campaign lifecycle |
| 28 totals reconcile to the VND | verified | D `voucher-quote`, `voucher-picker-model`; B preview |
| 29–30 shipping stacking per candidate (TG-10 B) | verified | D `voucher-shipping` (real campaign engine), `voucher-optimizer`; B preview (real engine) |
| 31–34 self-held hold semantics | **pending V11/V12** | proof side done: D `voucher-quote-proof` (HELD/expiry/paidRevision ABA); DB clock guard in `voucher-schema` |
| 35 gift-loss confirmation updates the saved gift | **pending V18** | picker shows the loss and asks for confirmation; saved gift choices are not edited here |
| 36 TG-09 tie-break keeps the gift | verified | D `voucher-optimizer` |
| 37 ALL_SHOP+exclude / TARGETED OR / parent-child | verified | D `voucher-scope` |
| 38 accepted order is immutable | verified (database) | B `voucher-schema` (money + quote rows frozen after acceptance, state still moves) |
| 39 / 46 EX-10: 650K − 30K − 80K = 540K, never 570K | verified | D `voucher-money`; B `voucher-order-subtotal-checkout` through the real engines |
| 40 PRIVATE link never reaches analytics/Referer | verified | D `voucher-marketing-link`; U (clean URL, redirects `no-referrer` + `no-store`, no code in the page or later requests, HttpOnly pending cookie). GTM itself was not loaded (no network) |
| 41 TG-05 A: edit/disable never revokes a hold | verified | B `voucher-admin-cap-edit` |
| 42 GET / prefetch / hover never hold | verified for the preview and the PDP/cart pages; **production-build browser evidence recorded** ([H3-V](./storefront-voucher-v1-h3v.md): 87 prefetches, 0 hold requests, database byte-identical) | B `voucher-order-subtotal-checkout`; U (no hold exists after opening the picker or the PDP). Run against `next dev`, not a production build |
| 43 POST grants once, idempotent | verified (database); **production-build browser evidence recorded** ([H3-V](./storefront-voucher-v1-h3v.md): one click = one POST = one hold, 600 000 ms TTL, double-click / second tab / navigation keep the same hold) | B `voucher-hold-flow` (reload / double click / two tabs: same holds, same expiry, same proof, one ledger entry; **with quota = 1 the buyer's own retry keeps the hold even after the campaign ended or was switched off**; consent is to the quote digest, so equal totals of two different vouchers are refused; a quote that costs a gift or raises the total needs `acknowledged`; if the proof cannot be issued the call rolls back and a swap keeps the old hold; a PREVIEW proof can never submit; the HELD proof verifies against an independently recomputed quote and expires at the earliest hold) |
| 44 cap under committed floor refused | verified | B `voucher-admin-cap-edit`, `voucher-schema` |
| 14–16 / 33 hold is 10 minutes, absolute, reused on reload / two tabs | verified (database) | B `voucher-hold` (TTL from one database timestamp; reload and parallel tabs return the same hold with the original `expiresAt`; nothing extended or double counted) |
| 31 / 32 held entitlement vs natural campaign expiry | verified at the hold read (V11); **submit-time consume is V13** | B `voucher-hold` (campaign ended at T+3: the T+5 hold is still honoured, nothing new is granted; T+10 refused by the database clock) |
| 34 swap keeps the old hold when the new one fails | verified | B `voucher-hold` (a pair is all-or-nothing; a refused swap leaves both holds and the ledger as they were) |
| 45 Admin cap edit racing grants | verified (database) | B `voucher-hold` (6 rounds of a real `voucher-admin-service` edit against 4 simultaneous grants: never over a cap, edit refused exactly at the live-hold floor, counters equal the live holds) |
| 47 flag OFF settles existing holds | partial | settle path has no flag read by design (ADR 0018 D-6); behaviour test pending V13/V14 |

## Regression

| Suite | Result |
| --- | --- |
| `pnpm test:domain` | 16 failures that are **identical on a clean `main`** (checked by stashing this work); all new tests pass |
| `pnpm test:db` (PostgreSQL 16, all migrations) | every test passes except `auth-runtime`, which needs `BETTER_AUTH_SECRET` (environment, unrelated) |
| `tsc --noEmit`, `eslint` | clean (existing warnings only) |

## Browser run

`tests/a11y-runtime/voucher-picker.spec.ts`, Chromium (mobile 390px project), against `next dev` and the migrated PostgreSQL: **8 / 8 pass**. It covers the two-group picker with the exact "Đặt thêm" shortfall and axe on the dialog, draft preview that saves nothing, atomic Áp dụng, a private code through the picker (generic wrong-code answer), the marketing link (clean URL, `no-referrer`/`no-store`, no code in the page), the no-cart pending cookie (HttpOnly), a bad code, and the PDP teaser with axe.

It found and fixed a real defect: the baseline `Referrer-Policy` from `next.config.mjs` replaced the `no-referrer` set on the voucher redirects, so the code could have travelled in a Referer. It is now overridden only for requests carrying `?voucher=` and for `/voucher-link`.

Not covered: desktop viewport, a production build, real devices, the Admin screen under axe, keyboard walk-through beyond Escape/focus return, and the H4 design review.

## What a person still has to do

build V14 and V18 · H4 UX review · V20 convergence run with approved POS · V21 rollback dry run · H5 go/no-go. **Keep `LA_VOUCHER_ENABLED` unset in production until V18 ships.**

## V13 — accepted order and once-only consume (2026-10-26)

`src/commerce/voucher-order-acceptance.ts`, wired through `acceptAtWriteBoundary` in `pancake-order-submit.ts` and `pancake-order-submit-runtime.ts`. Real PostgreSQL 16 tests: `voucher-order-acceptance.test.ts` (13) and `voucher-order-acceptance-boundary.test.ts` (4, the real submission service with a recording gateway); the guest-checkout submit domain tests gained the new reason (15). Whole `tests/database` suite: 1112 / 1113, the one failure is `auth-runtime` and is identical without this work.

| Criterion | Evidence |
| --- | --- |
| Accepted marker + voucher consume are one transaction, after stock reservation | acceptance is the last statement of the write-boundary transaction, after `reserveOrderCapacity` and the SUBMITTING claim; EX-01 (both vouchers: marker digest = the order's own quote digest, holds CONSUMED with the order, two redemptions, reserved → redeemed, order frozen afterwards) |
| Stock / acceptance failure ⇒ no marker, no consume, no POS write | refused and throwing acceptors: nothing reaches the gateway, the acceptor's writes roll back, order REJECTED `VOUCHER_REQUOTE_REQUIRED`, reservations released; crash after the acceptor but before commit: marker 0, holds HELD, counters unchanged, a retry then accepts |
| Retry / double click / 2 tabs consume once | 4 parallel acceptances: one winner, 1 marker, 2 redemptions, counters redeemed 1; later call answers `replayed` |
| ABA / expiry / quote | cart `paidRevision` moved ⇒ `CART_CHANGED`; hold past `expiresAt` by the DB clock ⇒ refused; mutated price, shipping, or voucher not applied in the order ⇒ `QUOTE_MISMATCH`; a declaration naming another campaign or revision ⇒ refused |
| Voucher proof ↔ checkout/gift proof consistent (gate from the H3-V review) | the digest the holds stored (a function of paid segments, the NUMBER of gift slots, money, vouchers, `paidRevision`) is recomputed from the order's frozen quote rows: gift A → B at the same count is accepted; two gifts, no gift, or a gift the voucher quote never promised are refused |
| A voucher order is never accepted as a plain one | the declaration row exists ⇒ either consumed or refused: released hold, expired hold, swapped hold all refuse; only an order with no declaration passes through untouched (and needs no secret) |
| POS UNKNOWN does not refund | `SYNC_UNKNOWN` after acceptance: redemptions unrefunded, counters unchanged; refund exists only as V14's trusted-signal path |

**Design choice that needs the owner's eye.** The H2-approved migration has no place for the order's voucher declaration (V10's `VoucherOrderSnapshot`), and a HELD hold cannot carry an order id (`VoucherHold_state_check`). Without a declaration, acceptance could not tell a voucher-priced order from a plain one and would risk accepting the former without consuming. Migration `20261026100000_voucher_order_snapshot` therefore adds, additively: table `OrderVoucherSnapshot` (insert-only, DRAFT-only, locked once accepted), index `VoucherHold_orderId_idx`, and its own rollback header. It was applied only to the scratch database; `prisma migrate diff` against the schema shows no drift from it.

**Not done here, on purpose:** nothing writes the declaration yet, so no real order carries one and every real order takes the untouched plain path. V18 must write it in the snapshot transaction and teach the benefit-order re-derivation in `submitBenefitOrder` (which recomputes the quote without vouchers) about the voucher segments; until then a voucher-priced order would be closed there, not accepted. `LA_VOUCHER_ENABLED` stays unset in production.

## V18 server core — vouchers in the checkout quote, DRAFT, acceptance and POS lines (2026-10-26)

`voucher-checkout-quote.ts` plus the voucher part of `resolveBenefitCheckoutQuote` (the one function the checkout render, the DRAFT step and the POS submit already share, so they cannot disagree). Real PostgreSQL, real snapshot/submission/capacity/acceptance services and a recording Pancake double: `voucher-checkout.test.ts` (6). Existing order, gift, shipping and voucher suites: 566 passed together; domain 3360/0.

| Criterion | Evidence |
| --- | --- |
| The held vouchers are in the quote the buyer proves | rendered facts: paid 850.000đ, fee waived to 0, total 850.000đ, the line carries a `VOUCHER` step 450.000 → 425.000đ; the proof binds exactly those lines |
| DRAFT, acceptance and POS agree to the VND | EX-01: order 850.000/0/850.000, POS lines `2 x 425.000đ`, `shipping_fee` 0, acceptance + two redemptions, counters reserved → redeemed, declaration stored |
| Uneven discounts | 50.000đ over 3 units = two segments, each with the voucher step; POS lines sum to 1.300.000đ |
| Holds that no longer describe the cart are not applied | cart changed: the render is the plain quote with `voucherStale`, the old proof is refused (`PRICE_CHANGED`), the hold is left to expire, nothing consumed |
| Holds released before the POS write | the POS re-derivation sees no voucher → `BENEFIT_REQUOTE_REQUIRED`, order closed, nothing sent, nothing consumed |
| Gift loss is never silent (AC-08/35) | hold without consent → `CONFIRMATION_REQUIRED`; with it, checkout shows `GIFT_SELECTION_INVALID` until the unearned choice is removed; the stored choice is not touched |

Design notes. (1) A shipping voucher is a named waiver of the fee the shipping engine decided (`shippingWaivedVnd`), not a rewrite of that decision, so the order's shipping provenance stays the real campaign's. (2) Voucher checkout rides the existing benefit path, so it needs the same two switches as any quote-bearing order: the gift/tier gate and a line-level-pricing-verified shop (the H1-V shop). (3) Migration `20261026120000_order_quote_step_voucher` relaxes ONE check constraint to admit `VOUCHER` as a discount-step source; it rewrites nothing. **It, like the V13 migration, needs the owner's approval before any real database.**

**UI slice (2026-10-26):** see the next section. **Not done:** the over-16-KiB-proof UX evidence.

## V18 UI — checkout voucher panel and cart totals (2026-10-26)

The checkout never applies a voucher the shopper merely picked: a HELD voucher is already in the server's quote and is only listed (earliest expiry, "Đổi ưu đãi ở giỏ hàng"); an OFFERED one is the shopper's own selection previewed by the server, carries the digest the one hold POST must send back, and **blocks ordering until confirmed**; a STALE hold is reported and the price shown has no voucher. A gift loss or total increase needs the consent checkbox before the hold button enables. The cart labels its total "Tổng (chưa tính ưu đãi)" and shows "Dự kiến sau ưu đãi" separately (closes the PR #214 P2).

| Criterion | Evidence |
| --- | --- |
| Bill adds up, voucher named once, waiver beside the reduced fee | D `checkout-voucher-model.test.ts` (7); B: 900.000 value, `Giảm 50K −50.000`, 880.000 total incl. 30.000 fee |
| Offer blocks ordering; one deliberate hold | B `checkout-voucher.spec.ts`: submit disabled, no hold row, click → 1 `HELD` row, submit enabled; run at 390 and 1280 widths inside one test |
| Typed COD fields survive the refresh | B: name, address and note unchanged after the hold |
| Hold no longer describes the cart | B: quantity changed under a hold → "Nàng xác nhận lại ưu đãi", submit disabled |
| Gift-loss consent | B: warning shown, button disabled until the checkbox, then one hold |
| Cart totals | B: both labels visible, nothing held, axe clean on the new block |

Run on a `NODE_ENV=production` build (4/4). Axe is scoped to the voucher panel and the new cart block before the form is filled: the untouched address `<select>` placeholder and the cart's product-image link have existing findings (contrast, label-in-name) that are not part of this change. Not covered: >16 KiB proof UX, expiry while the page is open.

Regression run of the neighbouring specs on the same build (`voucher-picker`, `checkout`, `checkout-benefit`, `cart-gift-picker`; 63 tests): 59 pass. The 4 failures are all axe rule `label-content-name-mismatch` on the cart's product-image link (`aria-label="Xem …"`), code this change did not touch; the local runner has axe-core 4.14.0 where the repo pins 4.12.1 (`tests/a11y-runtime/package.json`), and that rule is stricter in the newer version. CI, which uses the pinned version, is the authority for those four.

## V14 — trusted cancel, reject and refund once (2026-10-26)

`src/commerce/voucher-redemption-service.ts`; hooks in the submit service (Pancake 4xx on create), the SYNC_UNKNOWN reconciliation (confirmed absence) and the status reconciliation (stored status 7); `pnpm voucher:refund:sweep` for anything a lost hook left. Real PostgreSQL: `voucher-redemption-refund.test.ts` (10), plus the existing order, checkout and voucher suites (231 passed together), domain 3360/0.

| Criterion | Evidence |
| --- | --- |
| AC-18 definitive reject refunds; UNKNOWN does not | REJECTED refunds each redemption once; SYNC_UNKNOWN, CONFIRMED and in-flight orders refund nothing; a create timeout never calls the hook |
| AC-19 duplicate / out-of-order cancel, after shipping | five parallel status-7 signals on a CONFIRMED order refund two redemptions once each; an older status answer is STALE and refunds nothing; only status 7 on a complete shop-verified mirror is a signal (0–6, 8, 15, 16 and half records are not) |
| AC-27 expired campaign | counters return, `isEnabled`, window and revision untouched |
| Retry safety | a failed hook is retried by the next UNCHANGED status read; the sweep settles REJECTED orders once and leaves other states alone |
| Settle paths ignore the flag | nothing in the refund path reads `LA_VOUCHER_ENABLED` or the verified-shop list |

**Still open (evidence, not code):** only the cancel we issue ourselves is known to read status 7. A cancel made by staff in the Pancake UI, and any code for returned or shipped-then-returned orders, are unmapped and therefore stay pending. The sweep must be scheduled by the V21 runbook. There is no Admin screen for an Admin cancel yet; the service accepts it with audit evidence.

## Review fix — PRIVATE vouchers and ids (PR #214, 2026-10-26)

A review of `5414e67` found that `setGroup` and `applyBoth` accepted any active PRIVATE campaign by id, so a cart that never entered the code could lock it if it knew the id (an id is not a credential). Fixed in `voucher-selection-service.ts`: a PRIVATE voucher is accepted by id only when the cart's own saved selection already names it. `tests/database/voucher-selection.test.ts` gained a two-cart test (B refused through both entry points even knowing both ids; a mixed PUBLIC+PRIVATE draft is refused whole and writes nothing; A keeps using its unlocked voucher; the unlock is per voucher and ends when the lock is dropped); removing the check in either entry point fails it. Voucher DB suite 119/119, picker browser spec against a production build 8/8, `test:domain` 3360/0.

A second review (`f7bde69`) found the same hole on the read side: `previewStorefrontVoucherDraft` passed an unsaved draft straight to the preview, which loaded any PRIVATE campaign it named. `voucher-preview.ts` now drops a PRIVATE id that this cart's saved selection does not name (and ignores it when crediting an own hold), so the response is identical to the one for an id that does not exist. `tests/database/voucher-preview-private.test.ts` compares the two responses for each group and both together, and checks that PUBLIC drafts and the cart that entered the code are unchanged; removing the guard fails both tests. Voucher DB suite 121/121, picker browser spec 8/8 on a fresh production build.

Open from the same review (not fixed): the cart page shows two different totals while the voucher preview is on (picker vs "Tổng thanh toán"/mobile CTA). Tracked in the todo as a P2 that blocks exposing the feature; it belongs to V18.

## Migration rollback dry run (V21, partial) — 2026-10-26

Scratch PostgreSQL 16 database, never a real one. `prisma migrate deploy` applied every migration including `20261025100000_voucher_v1_additive` (5 tables, 9 triggers, 4 functions, 10 types). The migration's own commented rollback list was then run in one transaction: **0 voucher objects remained**. On that rolled-back schema the older order/checkout database tests (`benefit-checkout-snapshot`, `guest-checkout-submit`; 60 tests) passed unchanged, i.e. old code and historical orders do not depend on the new objects. Re-applying the migration file (roll forward) succeeded and `voucher-schema` plus `voucher-hold` (27 tests) passed again.

Limits: this proves the schema round trip on an empty ledger. The rollback list is only safe while no accepted order references the tables (the migration header says so); a rollback after real redemptions would need a data decision, not this script. Nothing was applied to any real database.

## V21 — runbook and H5 packet (2026-10-26)

[Operations runbook](../operations/storefront-voucher-runbook.md) rewritten for the built system and the [H5 readiness packet](./storefront-voucher-v1-h5-packet.md) assembled. The packet also carries a refreshed acceptance table for the rows above that still read "pending V11/V12/V13/V14/V18". Nothing was enabled or deployed; the runbook's SQL was run only against a scratch database (syntax and columns; the ledger was empty, so the drift queries were not exercised on real data).
