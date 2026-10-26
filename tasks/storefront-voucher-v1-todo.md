# Storefront Voucher v1 — execution checklist

**Status:** BUILD IN PROGRESS — owner approved H0, **H1-D and H2** on 2026-10-25. Built and verified: V00–V10, V15–V17, V19; gates **H3-D** (ADR 0019, 2026-10-26) and **H1-V** (live POS probe 4/4 PASS, 2026-10-26) are done. **Not built:** V12–V14 and V18 (holds, accepted order, cancel/refund, checkout exposure — H3-V and the build itself remain), and the completion of V20/V21. `LA_VOUCHER_ENABLED` exists and is OFF by default; **keep it unset in production until V18 ships** (checkout does not apply vouchers yet). Evidence: [verification status](../docs/verification/storefront-voucher-v1.md).
**Authority:** [Merged Voucher v1 spec](../docs/specs/storefront-voucher-v1.md) (PR #212, main@2c6e35d39d165064f5986ef901a5bb3efa464e1a).
**Execution design:** [Voucher v1 implementation plan](./storefront-voucher-v1-plan.md); V00..V21 and H0..H5. This does **not** replace [master plan](./plan.md) or [master todo](./todo.md).
**Quality:** [ADR 0005 PR sizing](../docs/decisions/0005-pr-scope-reviewability.md); checkout/Pancake/DB migrations require real test evidence, not a checked box on docs.

## Gate approvals — must be documented before dependent work

- [x] **H0 — Plan approved:** owner approves new implementation work; spec merge is not automatic /build approval. _Evidence: owner asked for the PR #213 plan to be built end to end on 2026-10-25; scope taken as Slice A because later slices wait on H1-D / H2 below._
- [x] **H1-D — Accepted/POS design (after V00, before V09):** accepted marker vs DRAFT, stock/quote transaction and offline exact-money vendor design; sandbox probe needs separate operator permission. _Approved by the owner 2026-10-25 against ADR 0018 ("duyệt H1-D, H2 theo ADR 0018"). The sandbox probe is NOT authorized by this._
- [x] **H1-V — POS verification (after V09, before V12):** real canProjectExactMoney tests plus authorized sandbox write/readback; otherwise real holds stay OFF. _DONE 2026-10-26: F1–F4 4/4 PASS on shop 715077776 (owner-authorised, labelled test variation, all test orders cancelled, status 0→7). Evidence: [POS probe](../docs/verification/storefront-voucher-v1-pos-probe.md)._
- [x] **H2 — Database/API authorization (after V00, before V04):** owner approves additive voucher ledger, accepted marker + immutable quote storage, selection storage if needed, and rollback. _Approved 2026-10-25 with H1-D; migration `20261025100000_voucher_v1_additive` written and applied only to a scratch database. Applying it to a real database is a deploy step._
- [x] **H3-D — Hold design (after V00/V10, before V11):** lock order, 10m TTL, GET read-only, POST idempotency/CSRF, proof/POS feasibility sequencing. _Design drafted: [ADR 0019](../docs/decisions/0019-voucher-v1-hold-design.md) (**Accepted**, owner approval 2026-10-26)._
- [x] **H3-V — Hold verification (after V11/V12, before V13/V18):** actual DB/admin races, natural expiry/T+10, GET/prefetch no mutation, POST reuse and signed proof. _Approved by the owner 2026-10-26 ("duyệt h3v") on the evidence in [the H3-V write-up](../docs/verification/storefront-voucher-v1-h3v.md): two review rounds fixed, production-build browser harness 6/6, CI 19/19 on `6e75c2a`. The approval covers V11–V12 / AC-42–43 only; V13 and V18 keep their own gates (voucher proof ↔ checkout/gift proof, accepted/consume, stock-failure rollback; real cart/checkout browser run; the >16 KiB proof UX)._
- [ ] **H4 — UX review:** Grab-style responsive picker and gift-loss consent accepted before final UI sign-off.
- [ ] **H5 — Launch AFTER V20+V21:** full CI/browser/DB/approved POS, security, rollback/on-call packet, owner go/no-go; does not block writing V21.

**Ordering:** H1-D/H3-D are design-only before code; H1-V/H3-V come from implementing V09/V12. H5 is final, never prerequisite of V21.

## Phase A — architecture and pure rules

- [x] **V00 — Accepted-order/POS architecture design** _(deps: none; produces H1-D/H2 design inputs)_ — **approved (H1-D/H2)**
  - [x] Specify persisted accepted marker, immutable quote, stock-reservation-before-consume and rollback-on-capacity-failure; historical order migration boundary. _[ADR 0018](../docs/decisions/0018-voucher-v1-accepted-order-architecture.md), status Proposed._
  - [x] Offline vendor fixtures, cancellation states, cart-bound selection storage; H1-D/H2 review, no unauthorized POS calls. _[doc](../docs/integrations/pancake-voucher-acceptance.md), `tests/domain/voucher-vendor-fixtures.test.ts`; reviewed and approved with ADR 0018._
- [x] **V01 — Voucher scope and campaign validation** _(deps: V00)_
  - [x] Test ALL_SHOP+exclude, TARGETED category OR product include minus exclude, parent/child membership and bounds. _`tests/domain/voucher-scope.test.ts`, `voucher-rule-validation.test.ts`._
  - [x] Run focused scope/rule domain tests; verify existing Gift & Quantity scope unchanged. _`gift-quantity-scope.ts` is not modified; its tests pass._
- [x] **V02 — Merchandise money and allocation** _(deps: V01)_
  - [x] Test fixed/%/cap, per-unit >=1đ, exact VND conservation; TG-11 A EX-10 = 540K and no voucher = 620K. _`tests/domain/voucher-money.test.ts` (EX-10 runs through the real `priceStack` ladder)._
  - [x] Run focused money + ORDER_SUBTOTAL ladder regression tests. _`gift-quantity-order-subtotal-tier.test.ts` passes._
- [x] **V03 — Two-group optimizer and POS feasibility seam** _(deps: V02)_
  - [x] Test min total, nonstack shipping, gift tie, manual NONE, and injected infeasible POS candidate excluded/clearly rejected. _`tests/domain/voucher-optimizer.test.ts`._
  - [x] Run domain optimizer/shipping tests (EX-01/02/06/07). _`voucher-optimizer.test.ts`, `voucher-shipping.test.ts`; shipping engine exercised for real in the latter._

## Phase B — persistence and Admin (H2 required before writes)

- [x] **V04 — Voucher tables, accepted-marker persistence and default-OFF** _(deps: V00, H2)_
  - [x] H2-approved Voucher tables, durable local accepted marker + DB immutable accepted quote and historical compatibility; cart selection store if DB-backed. _Migration `20261025100000_voucher_v1_additive` (tables, CHECKs, partial unique index, guards); `tests/database/voucher-schema.test.ts`._
  - [x] Prisma validation/generation, DRAFT-vs-ACCEPTED DB tests, flag OFF and migration rollback; split accepted schema into H2-approved sub-PR if needed. _`prisma validate`/`generate` clean; DRAFT-vs-ACCEPTED, historical orders, absolute TTL, one-way refund tested; migration applied to a scratch PostgreSQL 16 and the full DB suite passes (only `auth-runtime`, which needs `BETTER_AUTH_SECRET`, fails). Not applied to any real database._
- [x] **V05 — Candidate repository and PRIVATE code validation** _(deps: V01, V04)_
  - [x] Bounded shop-scoped lifecycle reads; private code not discoverable; own valid holds still recognizable. _`voucher-candidate-repository.ts`; private codes never listed, uniform `INVALID_CODE`._
  - [x] Run DB tests for code, expiry, shop ownership and rate-limit surfaces. _`tests/database/voucher-candidates.test.ts` (flag OFF reads nothing, window, shop, bound, idempotent, own held voucher survives expiry/disable/flag OFF)._
- [x] **V06 — Admin write service and quota/budget floor** _(deps: V04, V05)_
  - [x] RBAC, draft/publish, disable and revision audit; reject cap below used-not-refunded+live-held. _`voucher-admin-service.ts`: ADMIN-only, shop-scoped, optimistic revision, identity lock, Copy._
  - [x] Seeded Admin cap-floor/validation tests (AC-44); do not mark real Admin × checkout grant AC-45 complete until V11. _`tests/database/voucher-admin-operations.test.ts`, `voucher-admin-cap-edit.test.ts` (AC-41/44; AC-45 grant race waits for V11)._
- [ ] **V07 — Admin voucher UI** _(deps: V06)_ — **built; Admin browser/axe evidence pending**
  - [x] Campaign create/edit/schedule/disable and clear validation; default not active. _`/admin/promotions/vouchers` list/create/edit/enable/disable/copy; strict parsing (`tests/domain/voucher-admin-input.test.ts`); flag-OFF notice._
  - [ ] Browser a11y/action tests; no public exposure of private codes. _Server actions re-authorize and the service re-checks; no browser/axe run of the Admin screen yet._

## Phase C — canonical quote and POS projection

- [x] **V08 — Voucher-aware canonical benefit quote** _(deps: V02, V03, V05)_
  - [x] Tier-before-voucher quote, gift/shipping recompute and typed canProjectExactMoney seam; preview-only before V09. _`voucher-quote.ts` (pure) + `voucher-preview.ts` (real cart/tier/gift/shipping engines, repeatable-read, read-only); preview-only (`held: false`)._
  - [x] Run focused quote/DB tests including TG-11 A AC-39/46 and flag-OFF parity. _`tests/domain/voucher-quote.test.ts`; `tests/database/voucher-order-subtotal-checkout.test.ts` incl. EX-10 = 540K and EX-06 on the real engines._
- [x] **V09 — POS canProjectExactMoney adapter** _(deps: V02, V08, H1-D; produces H1-V)_ — **done; H1-V live evidence recorded 2026-10-26**
  - [x] Exact line/quantity/gift/shipping projection; typed infeasible result excludes candidate before any hold. _`pancake-voucher-projection.ts`: `canProjectExactMoney` + `createVoucherPosFeasibility`, wired as `isFeasibleOnLines`._
  - [ ] Domain/integration impossible-money case, then operator-authorized sandbox write/readback for H1-V; no V12 real holds without H1-V. _Domain tests incl. lockstep with the order-submit projection and the AC-20 exclusion. **H1-V live write/readback PASSED 2026-10-26** (see POS probe doc); holds still need V11/V12 and the verified-shop gate._
- [x] **V10 — Voucher-signed quote and immutable snapshot** _(deps: V04, V08)_
  - [x] Signed proof binds voucher/amount/hold/paidRevision, is tamper/ABA/cross-cart-safe and legacy compatible. _`voucher-quote-proof.ts` (`lav1`) and `voucher-order-snapshot.ts` (strict v1)._
  - [x] Run proof/domain tests and security review; preview proof cannot submit held voucher. _`tests/domain/voucher-quote-proof.test.ts` (tamper/ABA/cross-cart/preview-vs-held/expiry; legacy proofs unaffected)._

## Phase D — 10-minute hold, acceptance and cancellation

- [x] **V11 — Atomic holds and real Admin cap race** _(deps: V04, V05, V06, V10, H3-D)_ — **done 2026-10-26:** `src/commerce/voucher-hold-service.ts`, `tests/database/voucher-hold.test.ts` (15)
  - [x] Grant, swap, reuse and expire holds atomically across two groups; no rolling TTL, no oversubscribe.
  - [x] Run actual V06×V11 simultaneous cap edit/hold grant AC-45, plus T+3/T+5 natural expiry, T+10 and idempotent ledger. _Mutations checked: no self-credit, no lazy expiry and an unsorted lock order each make a test fail (the last with a real `deadlock detected`)._
- [ ] **V12 — Verified-POS-only buyer POST hold** _(deps: V09, V10, V11, H1-V; produces H3-V)_ — **built 2026-10-26; revised after the H3-V review (3×P1 fixed: own holds stay in play, quote-digest consent, proof issued inside the hold transaction)** (`voucher-hold-flow.ts`, `voucher-hold-actions.ts`, `tests/database/voucher-hold-flow.test.ts` 15); **production-build browser evidence (AC-42/43) is recorded** via a test-only harness outside `src/` ([evidence](../docs/verification/storefront-voucher-v1-h3v.md)); **H3-V APPROVED 2026-10-26; second review: two more P1 fixed (NONE needs the digest; quote re-verified under the cart lock) with barrier race tests; harness re-run on the fixed code; CI green on `37f6de3` (19/19); H3-V approved by the owner 2026-10-26**
  - [x] GET/prefetch read-only; CSRF/idempotent POST invokes verified V09 canProjectExactMoney BEFORE any hold or submit-capable proof. _The only grantor is a Server Action (POST-only, origin-checked, cookie-owned cart); gates, per-cart/per-shop throttle, expected-total agreement, exact-money check, atomic hold, then the HELD proof. Mutations (no exact-money check, no total check, no gates) each fail a test._
  - [x] DB/integration unrepresentable money→no hold/budget/proof/POS (AC-20) **[done: database]**, plus production prefetch-vs-POST browser evidence (AC-42/43) **[done 2026-10-26: `pnpm voucher:hold-harness`, 6/6 + official artifact proved clean]**, then H3-V review **[approved by the owner 2026-10-26]**.
- [ ] **V13 — Durable accepted state and consume once** _(must also prove: the voucher proof and the checkout/gift proof stay consistent when the buyer switches gift A→B at the same count; the V12 proof binds only the gift slot count)_ — _(deps: V04, V09, V11, V12, H1-V, H3-V)_
  - [ ] Use V04 accepted marker/immutable quote, only after capacity reservation succeeds; stock fail/rollback means no accepted marker, no consumed voucher and no POS write.
  - [ ] DB stock-failure injection, retry/2-tab/PRICE_CHANGED/UNKNOWN tests; accepted orders never reprice and analytics waits confirmed.
- [ ] **V14 — Trusted cancellation, reject and reconciliation** _(deps: V13, H1-V)_
  - [ ] Definitive reject/cancel refunds once including after shipped; UNKNOWN stays pending and alertable.
  - [ ] Run DB reconciliation tests incl replay, out-of-order statuses and expired campaign.

## Phase E — shopper UX and marketing

- [x] **V15 — Picker model + cart-bound manual/CODE selection** _(deps: V03, V05, V08)_
  - [x] Add cart-bound server AUTO/manual/NONE selection, CSRF-protected rate-limited CODE validation POST with no hold; preserve through reload and checkout. _`voucher-picker-model.ts`, `voucher-selection-service.ts` (`CartVoucherSelection`, atomic apply, throttled CODE), `voucher-selection-actions.ts`._
  - [x] Domain/action tests for PRIVATE valid/invalid, manual NONE, cart-switch, reload, shop isolation and no quota mutation; split into small PRs if needed. _`tests/database/voucher-selection.test.ts`, `tests/domain/voucher-picker-model.test.ts`, `voucher-selection-input.test.ts`; ledger/holds byte-identical after selection writes._
- [x] **V16 — Grab-style picker UI** _(deps: V15; gate H4)_
  - [x] Picker code/radio/NONE wired to V15 validated action; disabled reasons and sticky “Áp dụng • N ưu đãi”, no fake hold state. _`voucher-picker.tsx`/`voucher-card.tsx` (native dialog, two radio groups + NONE, sticky `Áp dụng • N ưu đãi`, server answer governs)._
  - [x] Browser keyboard/focus/contrast/mobile tests; back/cancel preserves selection. _`tests/a11y-runtime/voucher-picker.spec.ts` 8/8 on the 390px project: axe, ≥44px rows, Escape + focus return, draft not saved, atomic apply. Desktop viewport and H4 design review still open._
- [x] **V17 — PDP/cart entry points** _(deps: V15, V16)_
  - [x] PDP/cart use same V15 selection state as checkout, no fake eligibility or holds on render. _Cart block + PDP teaser use the same server selection; no hold on render (spec + DB)._
  - [x] Product/cart domain + browser responsive and sticky checkout tests. _Browser: teaser axe clean, no hold created. Mobile sticky-CTA regression and desktop not exercised._
- [ ] **V18 — Checkout selection and gift-loss consent** _(deps: V08, V12, V13, V15, V16, H3-V)_
  - [ ] Checkout preserves COD fields and V15 selection, confirms gift-loss/ship price, never holds candidate without H1-V/H3-V.
  - [ ] Checkout domain/a11y tests for submit/reprice/expired hold.
- [x] **V19 — Safe KOL/private-code links** _(deps: V05, V15, V17)_
  - [x] Marketing deep link uses same V15 validated CODE selection, sanitizes referrer/analytics URL, no duplicated state. _`voucher-marketing-link.ts`, proxy hook, `/voucher-link`, pending-code cookie offered (not applied) on the cart._
  - [x] Integration/referrer/network tests and shop/privacy/rate-limit security review. _Browser: clean URL, `no-referrer`/`no-store`, no code in page. Found and fixed the global Referrer-Policy override._

## Phase F — QA and release packet

- [ ] **V20 — AC/TG convergence test evidence** _(deps: V07, V09, V13, V14, V16–V19)_
  - [ ] AC-01..47/TG-01..12 and H1-V/H3-V evidence includes impossible POS money no-hold, stock failure no-consume, Admin grant race and code/NONE persistence.
  - [ ] Run pnpm test:domain, pnpm test, pnpm test:db, prisma:validate/generate, typecheck, lint, build; browser a11y and authorized POS checks.
- [ ] **V21 — Rollback/runbook (H5 afterwards)** _(deps: V20)_ — _partial: migration rollback/roll-forward dry run on a scratch DB done 2026-10-26, see the verification doc; the runbook and packet wait for V13/V14/V18_
  - [ ] Runbook stops new holds without breaking valid existing holds, reconciles unknown/refunds, audits counters.
  - [ ] Assemble CI/security/rollback packet FOR later H5 owner go/no-go; do not auto-enable/deploy.

## Milestone checkpoints

- [x] **C0:** H0 owner plan approval and H1-D/H2 reviewer assignment before implementation.
- [x] **C1:** V01–V05 covered by focused tests; tier-voucher ordering and OFF parity verified; migration gate satisfied.
- [ ] **C2:** H1-V after V09 exact POS proof; until then V12 real holds remain OFF.
- [ ] **C3:** H3-V after V11/V12; V13 stock-failure rollback and V14 trusted refund verified.
- [ ] **C4:** V15–V19 picker/checkout accessibility, gift consent, marketing URL privacy verified.
- [ ] **C5:** V20 QA, V21 rollback dossier, THEN H5 owner ship approval.

## Verification status of this PLAN PR

- [x] Owner approves the plan and authorizes /build. _(2026-10-25)_
- [ ] No Critical/Required findings remain in plan review.
- [ ] None of V00..V21 is marked complete without verification evidence.
- [ ] No runtime code, schema, migration, test, browser interaction, POS write or deploy was performed by this **plan-only** PR.