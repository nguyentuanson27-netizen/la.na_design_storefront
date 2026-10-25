# Storefront Voucher v1 — execution checklist

**Status:** DRAFT / PLAN REVIEW — **no /build approval yet**, no implementation has started. All tasks and checkpoints are unchecked.
**Authority:** [Merged Voucher v1 spec](../docs/specs/storefront-voucher-v1.md) (PR #212, main@2c6e35d39d165064f5986ef901a5bb3efa464e1a).
**Execution design:** [Voucher v1 implementation plan](./storefront-voucher-v1-plan.md); V00..V21 and H0..H5. This does **not** replace [master plan](./plan.md) or [master todo](./todo.md).
**Quality:** [ADR 0005 PR sizing](../docs/decisions/0005-pr-scope-reviewability.md); checkout/Pancake/DB migrations require real test evidence, not a checked box on docs.

## Gate approvals — must be documented before dependent work

- [ ] **H0 — Plan approved:** Owner has reviewed task dependencies, risk/order, gates and scope of the new implementation work; a merged spec is **not** authorization to implement.
- [ ] **H1 — Architecture/vendor acceptance:** Local accepted marker vs mutable DRAFT; exact vendor line split/gift projection; trusted reject/cancel/UNKNOWN semantics; separately authorized operator probe when needed (TG-01/02/04/06).
- [ ] **H2 — Storage/checkout permissions:** Owner explicitly authorizes additive voucher migration and high-impact website-accepted order state/API change; no default-on campaign.
- [ ] **H3 — Quote/hold verification:** Proof bound to checkout/hold, TG-11 A ladder-before-voucher, absolute 10-minute TTL, GET/prefetch read-only and POST CSRF+idempotency.
- [ ] **H4 — Voucher picker UX:** Grab-inspired groups/sticky footer/near-threshold, mobile/desktop a11y, gift-loss confirmation accepted by owner/reviewer.
- [ ] **H5 — Launch:** Full AC evidence, CI, POS sandbox, security/rollback/observability, separate owner go/no-go; default OFF until explicit ship.

## Phase A — architecture and pure rules

- [ ] **V00 — Architecture/vendor status contract** _(deps: none; gate H1)_
  - [ ] Document accepted marker, exact POS discount/line readback, cancellation status provenance and rollback.
  - [ ] Review architecture/runbook with owner/operator; no unauthorized live POS writes.
- [ ] **V01 — Voucher scope and campaign validation** _(deps: V00)_
  - [ ] Test ALL_SHOP+exclude, TARGETED category OR product include minus exclude, parent/child membership and bounds.
  - [ ] Run focused scope/rule domain tests; verify existing Gift & Quantity scope unchanged.
- [ ] **V02 — Merchandise money and allocation** _(deps: V01)_
  - [ ] Test fixed/%/cap, per-unit >=1đ, exact VND conservation; TG-11 A EX-10 = 540K and no voucher = 620K.
  - [ ] Run focused money + ORDER_SUBTOTAL ladder regression tests.
- [ ] **V03 — Two-group optimizer, gift and shipping semantics** _(deps: V02)_
  - [ ] Test combined minimum-total, TG-10 B nonstack shipping, tie preserving gift, manual lock/NONE and gift loss.
  - [ ] Run domain optimizer/shipping tests (EX-01/02/06/07).

## Phase B — persistence and Admin (H2 required before writes)

- [ ] **V04 — Additive voucher tables + default-OFF gate** _(deps: V00, H2)_
  - [ ] Approved schema for Campaign/Hold/Redemption and campaign revision; no overwrite of legacy rows.
  - [ ] Run prisma validation/generation, focused DB schema and OFF parity tests; document rollback.
- [ ] **V05 — Candidate repository and PRIVATE code validation** _(deps: V01, V04)_
  - [ ] Bounded shop-scoped lifecycle reads; private code not discoverable; own valid holds still recognizable.
  - [ ] Run DB tests for code, expiry, shop ownership and rate-limit surfaces.
- [ ] **V06 — Admin write service and quota/budget floor** _(deps: V04, V05)_
  - [ ] RBAC, draft/publish, disable and revision audit; reject cap below used-not-refunded+live-held.
  - [ ] Run DB concurrency tests: Admin cap edit vs two simultaneous hold grants (AC-44/45).
- [ ] **V07 — Admin voucher UI** _(deps: V06)_
  - [ ] Campaign create/edit/schedule/disable and clear validation; default not active.
  - [ ] Browser a11y/action tests; no public exposure of private codes.

## Phase C — canonical quote and POS projection

- [ ] **V08 — Voucher-aware canonical benefit quote** _(deps: V02, V03, V05)_
  - [ ] Integrate after all legacy/quantity tiers; gift threshold after voucher; per-candidate shipping stacking.
  - [ ] Run focused quote/DB tests including TG-11 A AC-39/46 and flag-OFF parity.
- [ ] **V09 — POS voucher projection/contract** _(deps: V02, V08, H1)_
  - [ ] Exact signed amount + vendor segments/readback; respect gift 1.000đ adapter and infeasible fail-closed.
  - [ ] Run domain/integration tests; separately authorized sandbox readback evidence before enabled checkout.
- [ ] **V10 — Voucher-signed quote and immutable snapshot** _(deps: V04, V08)_
  - [ ] Signed proof binds voucher/amount/hold/paidRevision, is tamper/ABA/cross-cart-safe and legacy compatible.
  - [ ] Run proof/domain tests and security review; preview proof cannot submit held voucher.

## Phase D — 10-minute hold, acceptance and cancellation

- [ ] **V11 — Transactional hold and budget ledger** _(deps: V04, V05, V10)_
  - [ ] Grant, swap, reuse and expire holds atomically across two groups; no rolling TTL, no oversubscribe.
  - [ ] Run DB races self-hold quota=0, campaign expiry T+3/T+5, expiry T+10, admin edit concurrency.
- [ ] **V12 — POST-only checkout hold** _(deps: V10, V11; gate H3)_
  - [ ] GET/SSR/prefetch never creates hold; CSRF-protected buyer POST grants/reuses exactly once.
  - [ ] Integration and production browser/network tests for Link prefetch and direct checkout (AC-42/43).
- [ ] **V13 — Local accepted marker and consume once** _(deps: V09, V11, V12, H1)_
  - [ ] Atomic accepted order+immutable quote+hold consume before POS; DRAFT still repriceable only before accepted.
  - [ ] Run DB accepted/2-tab/retry/PRICE_CHANGED/UNKNOWN tests, no premature purchase analytics.
- [ ] **V14 — Trusted cancellation, reject and reconciliation** _(deps: V13, H1)_
  - [ ] Definitive reject/cancel refunds once including after shipped; UNKNOWN stays pending and alertable.
  - [ ] Run DB reconciliation tests incl replay, out-of-order statuses and expired campaign.

## Phase E — shopper UX and marketing

- [ ] **V15 — Server picker view model** _(deps: V03, V05, V08)_
  - [ ] Show 2 groups, eligibility/shortfall by applicable scope, hidden code safety and pinned choices.
  - [ ] Run view-model/domain tests incl auto vs manual NONE and quà tie-break.
- [ ] **V16 — Grab-style picker UI** _(deps: V15; gate H4)_
  - [ ] Responsive full-screen/panel, radio per group, input, disabled reasons, sticky “Áp dụng • N ưu đãi”.
  - [ ] Browser keyboard/focus/contrast/mobile tests; back/cancel preserves selection.
- [ ] **V17 — PDP/cart entry points** _(deps: V15, V16)_
  - [ ] Gọn, không giả ưu đãi đủ điều kiện, không lặp promotion banner, không tạo hold khi render.
  - [ ] Product/cart domain + browser responsive and sticky checkout tests.
- [ ] **V18 — Checkout apply and gift-loss consent** _(deps: V08, V12, V13, V16)_
  - [ ] Preview and confirm gift-loss or shipping total increase; preserve COD fields/gifts, re-sign quote.
  - [ ] Checkout domain/a11y tests for submit/reprice/expired hold.
- [ ] **V19 — Safe KOL/private-code links** _(deps: V05, V15, V17)_
  - [ ] Server captures bounded code, removes query before third-party trackers, pins validated voucher only.
  - [ ] Integration/referrer/network tests and shop/privacy/rate-limit security review.

## Phase F — QA and release packet

- [ ] **V20 — AC/TG convergence test evidence** _(deps: V07, V09, V13, V14, V16–V19)_
  - [ ] All spec AC-01..47/TG-01..12 mapped to actual tests/review evidence, no secret/session sink.
  - [ ] Run pnpm test:domain, pnpm test, pnpm test:db, prisma:validate/generate, typecheck, lint, build; browser a11y and authorized POS checks.
- [ ] **V21 — Rollback/runbook and separate launch gate** _(deps: V20, H5)_
  - [ ] Runbook stops new holds without breaking valid existing holds, reconciles unknown/refunds, audits counters.
  - [ ] Exact-head CI and owner go/no-go documented; **no automatic feature ON/deploy**.

## Milestone checkpoints

- [ ] **C0:** Owner approves plan; H1/H2 owners identified; code work not begun without approvals.
- [ ] **C1:** V01–V05 covered by focused tests; tier-voucher ordering and OFF parity verified; migration gate satisfied.
- [ ] **C2:** V08–V10 quote/POS/proof parity and operator-authorized acceptance; unsupported vendor cases blocked.
- [ ] **C3:** V11–V14 hold/accepted/reconcile concurrency tests and prefetch non-mutation verified.
- [ ] **C4:** V15–V19 picker/checkout accessibility, gift consent, marketing URL privacy verified.
- [ ] **C5:** V20–V21 DoD/security/observability/rollback and separate ship approval recorded.

## Verification status of this PLAN PR

- [ ] Owner approves the plan and authorizes /build.
- [ ] No Critical/Required findings remain in plan review.
- [ ] None of V00..V21 is marked complete without verification evidence.
- [ ] No runtime code, schema, migration, test, browser interaction, POS write or deploy was performed by this **plan-only** PR.