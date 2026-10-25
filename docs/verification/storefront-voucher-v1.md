# Voucher v1 — verification status

- **Status:** PARTIAL. Built and verified: V00–V10, V15–V17, V19. **Not built** (blocked by gates that need a person): V11–V14 (holds, accepted order, consume, cancel/refund), V18 (checkout exposure), V20/V21 completion, H1-V, H3-D/V, H4, H5.
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
| 12 picker mobile + desktop, a11y | U written; see "Browser run" |
| 13 PRIVATE code, KOL link, invalid code | verified (server) | B `voucher-candidates`, `voucher-selection` (uniform INVALID_CODE, throttle); D `voucher-marketing-link`; U |
| 14–16 quota/budget races, expiry, reload/2 tabs | **pending V11/V12** | DB invariants only: `voucher-schema` (partial unique live hold, absolute TTL, no oversubscribe) |
| 17–19 accept → consume once; reject vs unknown; cancel refunds once | **pending V13/V14** | DB guards only: `voucher-schema` (acceptance insert-only, redemption needs consumed hold + accepted order, refund CAS one-way) |
| 20 unrepresentable POS money → no hold, no proof | verified at the representation level | D `pancake-voucher-projection` (AUTO excludes, manual reported `POS_INFEASIBLE`); **H1-V sandbox readback pending** |
| 21 Admin edit/disable keeps history and live holds | verified | B `voucher-admin-operations`, `voucher-admin-cap-edit` |
| 22 cart/checkout/commit/Pancake agree | partial | quote ↔ proof ↔ order snapshot ↔ vendor projection are built and tested (D `voucher-quote-proof`, `pancake-voucher-projection`); checkout/submit wiring **pending V13/V18** |
| 23 voucher read fails → never a silently dearer total | partial | `readVoucherPreview` returns `QUOTE_UNAVAILABLE` and the cart renders its plain totals; submit-side behaviour pending V12/V13 |
| 24 flag OFF = main | verified | D `voucher-gate`; B `voucher-order-subtotal-checkout`, `voucher-candidates`, `voucher-selection` (nothing read or written) |
| 25 other shop / replay / forged money | verified (server) | B admin + selection isolation; D `voucher-selection-input` (money/revision/cart keys rejected) |
| 26 picker open/close keeps COD form and gifts | U + B | selection saved only on Áp dụng |
| 27 refund after campaign expiry | **pending V14** | DB: refund never touches campaign lifecycle |
| 28 totals reconcile to the VND | verified | D `voucher-quote`, `voucher-picker-model`; B preview |
| 29–30 shipping stacking per candidate (TG-10 B) | verified | D `voucher-shipping` (real campaign engine), `voucher-optimizer`; B preview (real engine) |
| 31–34 self-held hold semantics | **pending V11/V12** | proof side done: D `voucher-quote-proof` (HELD/expiry/paidRevision ABA); DB clock guard in `voucher-schema` |
| 35 gift-loss confirmation updates the saved gift | **pending V18** | picker shows the loss and asks for confirmation; saved gift choices are not edited here |
| 36 TG-09 tie-break keeps the gift | verified | D `voucher-optimizer` |
| 37 ALL_SHOP+exclude / TARGETED OR / parent-child | verified | D `voucher-scope` |
| 38 accepted order is immutable | verified (database) | B `voucher-schema` (money + quote rows frozen after acceptance, state still moves) |
| 39 / 46 EX-10: 650K − 30K − 80K = 540K, never 570K | verified | D `voucher-money`; B `voucher-order-subtotal-checkout` through the real engines |
| 40 PRIVATE link never reaches analytics/Referer | verified (logic) | D `voucher-marketing-link`; U |
| 41 TG-05 A: edit/disable never revokes a hold | verified | B `voucher-admin-cap-edit` |
| 42 GET / prefetch / hover never hold | verified for the preview; **prefetch evidence pending V12** | B `voucher-order-subtotal-checkout` (ledger, holds and selection unchanged after repeated previews) |
| 43 POST grants once, idempotent | **pending V12** | |
| 44 cap under committed floor refused | verified | B `voucher-admin-cap-edit`, `voucher-schema` |
| 45 Admin cap edit racing grants | partial | edits serialize under the campaign row lock (B `voucher-admin-cap-edit`); a real grant race needs V11 |
| 47 flag OFF settles existing holds | partial | settle path has no flag read by design (ADR 0018 D-6); behaviour test pending V13/V14 |

## Regression

| Suite | Result |
| --- | --- |
| `pnpm test:domain` | 16 failures that are **identical on a clean `main`** (checked by stashing this work); all new tests pass |
| `pnpm test:db` (PostgreSQL 16, all migrations) | every test passes except `auth-runtime`, which needs `BETTER_AUTH_SECRET` (environment, unrelated) |
| `tsc --noEmit`, `eslint` | clean (existing warnings only) |

## Browser run

See the pull request description for the exact result of `voucher-picker.spec.ts`; it is recorded there, not claimed here, because it depends on the run environment.

## What a person still has to do

H1-V operator sandbox probe · H3-D review of ADR 0019 · build V11–V14 and V18 · H4 UX review · V20 convergence run with approved POS · V21 rollback dry run · H5 go/no-go. **Keep `LA_VOUCHER_ENABLED` unset in production until V18 ships.**
