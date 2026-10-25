# Storefront Voucher v1 — execution checklist

**Status:** DRAFT / PLAN REVIEW — **no /build approval yet**, no implementation has started. All tasks and checkpoints are unchecked.
**Authority:** [Merged Voucher v1 spec](../docs/specs/storefront-voucher-v1.md) (PR #212, main@2c6e35d39d165064f5986ef901a5bb3efa464e1a).
**Execution design:** [Voucher v1 implementation plan](./storefront-voucher-v1-plan.md); V00..V21 and H0..H5. This does **not** replace [master plan](./plan.md) or [master todo](./todo.md).
**Quality:** [ADR 0005 PR sizing](../docs/decisions/0005-pr-scope-reviewability.md); checkout/Pancake/DB migrations require real test evidence, not a checked box on docs.

## Gate approvals — must be documented before dependent work

- [ ] **H0 — Plan approved:** owner approves new implementation work; spec merge is not automatic /build approval.
- [ ] **H1-D — Accepted/POS design (after V00, before V09):** accepted marker vs DRAFT, stock/quote transaction and offline exact-money vendor design; sandbox probe needs separate operator permission.
- [ ] **H1-V — POS verification (after V09, before V12):** real canProjectExactMoney tests plus authorized sandbox write/readback; otherwise real holds stay OFF.
- [ ] **H2 — Database/API authorization (after V00, before V04):** owner approves additive voucher ledger, accepted marker + immutable quote storage, selection storage if needed, and rollback.
- [ ] **H3-D — Hold design (after V00/V10, before V11):** lock order, 10m TTL, GET read-only, POST idempotency/CSRF, proof/POS feasibility sequencing.
- [ ] **H3-V — Hold verification (after V11/V12, before V13/V18):** actual DB/admin races, natural expiry/T+10, GET/prefetch no mutation, POST reuse and signed proof.
- [ ] **H4 — UX review:** Grab-style responsive picker and gift-loss consent accepted before final UI sign-off.
- [ ] **H5 — Launch AFTER V20+V21:** full CI/browser/DB/approved POS, security, rollback/on-call packet, owner go/no-go; does not block writing V21.

**Ordering:** H1-D/H3-D are design-only before code; H1-V/H3-V come from implementing V09/V12. H5 is final, never prerequisite of V21.

## Phase A — architecture and pure rules

- [ ] **V00 — Accepted-order/POS architecture design** _(deps: none; produces H1-D/H2 design inputs)_
  - [ ] Specify persisted accepted marker, immutable quote, stock-reservation-before-consume and rollback-on-capacity-failure; historical order migration boundary.
  - [ ] Offline vendor fixtures, cancellation states, cart-bound selection storage; H1-D/H2 review, no unauthorized POS calls.
- [ ] **V01 — Voucher scope and campaign validation** _(deps: V00)_
  - [ ] Test ALL_SHOP+exclude, TARGETED category OR product include minus exclude, parent/child membership and bounds.
  - [ ] Run focused scope/rule domain tests; verify existing Gift & Quantity scope unchanged.
- [ ] **V02 — Merchandise money and allocation** _(deps: V01)_
  - [ ] Test fixed/%/cap, per-unit >=1đ, exact VND conservation; TG-11 A EX-10 = 540K and no voucher = 620K.
  - [ ] Run focused money + ORDER_SUBTOTAL ladder regression tests.
- [ ] **V03 — Two-group optimizer and POS feasibility seam** _(deps: V02)_
  - [ ] Test min total, nonstack shipping, gift tie, manual NONE, and injected infeasible POS candidate excluded/clearly rejected.
  - [ ] Run domain optimizer/shipping tests (EX-01/02/06/07).

## Phase B — persistence and Admin (H2 required before writes)

- [ ] **V04 — Voucher tables, accepted-marker persistence and default-OFF** _(deps: V00, H2)_
  - [ ] H2-approved Voucher tables, durable local accepted marker + DB immutable accepted quote and historical compatibility; cart selection store if DB-backed.
  - [ ] Prisma validation/generation, DRAFT-vs-ACCEPTED DB tests, flag OFF and migration rollback; split accepted schema into H2-approved sub-PR if needed.
- [ ] **V05 — Candidate repository and PRIVATE code validation** _(deps: V01, V04)_
  - [ ] Bounded shop-scoped lifecycle reads; private code not discoverable; own valid holds still recognizable.
  - [ ] Run DB tests for code, expiry, shop ownership and rate-limit surfaces.
- [ ] **V06 — Admin write service and quota/budget floor** _(deps: V04, V05)_
  - [ ] RBAC, draft/publish, disable and revision audit; reject cap below used-not-refunded+live-held.
  - [ ] Seeded Admin cap-floor/validation tests (AC-44); do not mark real Admin × checkout grant AC-45 complete until V11.
- [ ] **V07 — Admin voucher UI** _(deps: V06)_
  - [ ] Campaign create/edit/schedule/disable and clear validation; default not active.
  - [ ] Browser a11y/action tests; no public exposure of private codes.

## Phase C — canonical quote and POS projection

- [ ] **V08 — Voucher-aware canonical benefit quote** _(deps: V02, V03, V05)_
  - [ ] Tier-before-voucher quote, gift/shipping recompute and typed canProjectExactMoney seam; preview-only before V09.
  - [ ] Run focused quote/DB tests including TG-11 A AC-39/46 and flag-OFF parity.
- [ ] **V09 — POS canProjectExactMoney adapter** _(deps: V02, V08, H1-D; produces H1-V)_
  - [ ] Exact line/quantity/gift/shipping projection; typed infeasible result excludes candidate before any hold.
  - [ ] Domain/integration impossible-money case, then operator-authorized sandbox write/readback for H1-V; no V12 real holds without H1-V.
- [ ] **V10 — Voucher-signed quote and immutable snapshot** _(deps: V04, V08)_
  - [ ] Signed proof binds voucher/amount/hold/paidRevision, is tamper/ABA/cross-cart-safe and legacy compatible.
  - [ ] Run proof/domain tests and security review; preview proof cannot submit held voucher.

## Phase D — 10-minute hold, acceptance and cancellation

- [ ] **V11 — Atomic holds and real Admin cap race** _(deps: V04, V05, V06, V10, H3-D)_
  - [ ] Grant, swap, reuse and expire holds atomically across two groups; no rolling TTL, no oversubscribe.
  - [ ] Run actual V06×V11 simultaneous cap edit/hold grant AC-45, plus T+3/T+5 natural expiry, T+10 and idempotent ledger.
- [ ] **V12 — Verified-POS-only buyer POST hold** _(deps: V09, V10, V11, H1-V; produces H3-V)_
  - [ ] GET/prefetch read-only; CSRF/idempotent POST invokes verified V09 canProjectExactMoney BEFORE any hold or submit-capable proof.
  - [ ] DB/integration unrepresentable money→no hold/budget/proof/POS (AC-20), plus production prefetch-vs-POST browser evidence (AC-42/43), then H3-V review.
- [ ] **V13 — Durable accepted state and consume once** _(deps: V04, V09, V11, V12, H1-V, H3-V)_
  - [ ] Use V04 accepted marker/immutable quote, only after capacity reservation succeeds; stock fail/rollback means no accepted marker, no consumed voucher and no POS write.
  - [ ] DB stock-failure injection, retry/2-tab/PRICE_CHANGED/UNKNOWN tests; accepted orders never reprice and analytics waits confirmed.
- [ ] **V14 — Trusted cancellation, reject and reconciliation** _(deps: V13, H1-V)_
  - [ ] Definitive reject/cancel refunds once including after shipped; UNKNOWN stays pending and alertable.
  - [ ] Run DB reconciliation tests incl replay, out-of-order statuses and expired campaign.

## Phase E — shopper UX and marketing

- [ ] **V15 — Picker model + cart-bound manual/CODE selection** _(deps: V03, V05, V08)_
  - [ ] Add cart-bound server AUTO/manual/NONE selection, CSRF-protected rate-limited CODE validation POST with no hold; preserve through reload and checkout.
  - [ ] Domain/action tests for PRIVATE valid/invalid, manual NONE, cart-switch, reload, shop isolation and no quota mutation; split into small PRs if needed.
- [ ] **V16 — Grab-style picker UI** _(deps: V15; gate H4)_
  - [ ] Picker code/radio/NONE wired to V15 validated action; disabled reasons and sticky “Áp dụng • N ưu đãi”, no fake hold state.
  - [ ] Browser keyboard/focus/contrast/mobile tests; back/cancel preserves selection.
- [ ] **V17 — PDP/cart entry points** _(deps: V15, V16)_
  - [ ] PDP/cart use same V15 selection state as checkout, no fake eligibility or holds on render.
  - [ ] Product/cart domain + browser responsive and sticky checkout tests.
- [ ] **V18 — Checkout selection and gift-loss consent** _(deps: V08, V12, V13, V15, V16, H3-V)_
  - [ ] Checkout preserves COD fields and V15 selection, confirms gift-loss/ship price, never holds candidate without H1-V/H3-V.
  - [ ] Checkout domain/a11y tests for submit/reprice/expired hold.
- [ ] **V19 — Safe KOL/private-code links** _(deps: V05, V15, V17)_
  - [ ] Marketing deep link uses same V15 validated CODE selection, sanitizes referrer/analytics URL, no duplicated state.
  - [ ] Integration/referrer/network tests and shop/privacy/rate-limit security review.

## Phase F — QA and release packet

- [ ] **V20 — AC/TG convergence test evidence** _(deps: V07, V09, V13, V14, V16–V19)_
  - [ ] AC-01..47/TG-01..12 and H1-V/H3-V evidence includes impossible POS money no-hold, stock failure no-consume, Admin grant race and code/NONE persistence.
  - [ ] Run pnpm test:domain, pnpm test, pnpm test:db, prisma:validate/generate, typecheck, lint, build; browser a11y and authorized POS checks.
- [ ] **V21 — Rollback/runbook (H5 afterwards)** _(deps: V20)_
  - [ ] Runbook stops new holds without breaking valid existing holds, reconciles unknown/refunds, audits counters.
  - [ ] Assemble CI/security/rollback packet FOR later H5 owner go/no-go; do not auto-enable/deploy.

## Milestone checkpoints

- [ ] **C0:** H0 owner plan approval and H1-D/H2 reviewer assignment before implementation.
- [ ] **C1:** V01–V05 covered by focused tests; tier-voucher ordering and OFF parity verified; migration gate satisfied.
- [ ] **C2:** H1-V after V09 exact POS proof; until then V12 real holds remain OFF.
- [ ] **C3:** H3-V after V11/V12; V13 stock-failure rollback and V14 trusted refund verified.
- [ ] **C4:** V15–V19 picker/checkout accessibility, gift consent, marketing URL privacy verified.
- [ ] **C5:** V20 QA, V21 rollback dossier, THEN H5 owner ship approval.

## Verification status of this PLAN PR

- [ ] Owner approves the plan and authorizes /build.
- [ ] No Critical/Required findings remain in plan review.
- [ ] None of V00..V21 is marked complete without verification evidence.
- [ ] No runtime code, schema, migration, test, browser interaction, POS write or deploy was performed by this **plan-only** PR.