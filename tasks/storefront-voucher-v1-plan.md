# Storefront Voucher v1 — implementation plan

**Status:** DRAFT PLAN — waiting for owner review/approval before /build. This PR writes **planning documents only**.
**Source of truth:** [Voucher v1 spec](../docs/specs/storefront-voucher-v1.md), merged from PR #212 by squash commit 2c6e35d39d165064f5986ef901a5bb3efa464e1a on 25/10/2026.
**Planning baseline:** main@2c6e35d39d165064f5986ef901a5bb3efa464e1a.
**Companion checklist:** [storefront-voucher-v1-todo.md](./storefront-voucher-v1-todo.md). Existing [plan.md](./plan.md) and [todo.md](./todo.md) are the unrelated current master workstream; **do not overwrite them**.
**Precedence:** Voucher-specific behavior is owned by merged spec; Brand truth and global execution policy by [master spec](../docs/specs/la-na-design-master-spec.md), [owner-approved facts](../docs/specs/la-na-design-owner-approved-facts-and-decisions.md), [tasks/README.md](./README.md) and ADR 0005. ADR 0016 D-12 remains intact; TG-11 A attaches vouchers **after** the already-final legacy/quantity ORDER_SUBTOTAL ladder.

## 1. Outcome, safety and non-goals

Build a two-group, Grab-inspired voucher experience: **one MERCHANDISE + one SHIPPING_FREE at most**, automatic lowest-total selection, explicit manual locks, public/code-only/KOL distribution, scope and threshold progress, gift-loss confirmation, and an accessible picker from PDP/cart/checkout. Keep COD guest checkout simple and server-authoritative.

Must preserve: Flash Sale + quantity-tier pricing; D-12 ladder *last in existing stack* before voucher; monetary gift eligibility *after* merchandise voucher; existing shipping stackingEnabled (MERCHANDISE counts as other promotion); 10-minute quota+budget holds without forced admin revocation; accepted local order consumes once; verified cancellation refunds once. Backend, browser render, signed proof, immutable order and Pancake projection must agree **to the VND**.

**Out of scope:** release/deploy/enable in this plan PR, general loyalty engine, voucher wallet, login/per-user caps, partially discounted shipping, gift vouchers, unapproved POS writes, modifications to live campaigns, major unrelated refactors, or a new per-session funnel tracking sink.

**Feature flag:** LA_VOUCHER_ENABLED, exact "true" opt-in, unset/malformed/off => no new vouchers or holds; switching OFF **must still honor/reconcile valid holds and prior redemptions** (TG-05 A / AC-47). Campaigns start inactive; Admin must explicitly activate after release approval.

## 2. Repo-grounded seams and evidence (read from merged main)

| Responsibility | Existing entrypoint / constraint |
| --- | --- |
| Promotion prices | src/commerce/promotion-pricing.ts; src/commerce/gift-quantity-stack.ts; ADR 0016 D-12 |
| Gift / shipping quote | src/commerce/benefit-checkout-quote.ts; gift-quantity-entitlement.ts; shipping-campaign.ts; gift selection is server state |
| Server checkout read | src/routes/checkout.ts and benefit-checkout-render.ts create proofs during **GET/render**; **never mutate holds here** |
| Canonical signing | src/commerce/checkout-quote-proof.ts and order-quote-snapshot.ts; existing proof is stateless and cart-bound |
| Submit/order | guest-checkout-submit.ts; guest-checkout-snapshot.ts; guest-checkout-submit-runtime.ts; local DRAFT may be repriced **before** website acceptance |
| Vendor adapter | pancake-gift-projection.ts and pancake-order-submit.ts; line-level readback evidence required for new voucher split/rounding |
| Cancellation | pancake-order-status-reconciliation.ts and related runtime; status/unknown must be verified before refund |
| Schema / security | prisma/schema.prisma, default-OFF promotion gates, requireAdminSession + per-shop validation |
| Existing UX | src/app/cart/page.tsx links checkout; src/app/checkout/page.tsx, routes/cart-model.ts, routes/product.ts; GQ picker/a11y patterns |
| Tests/scripts | package.json: pnpm test:domain, pnpm test (includes tests/integrations), pnpm test:db, pnpm typecheck, pnpm lint, pnpm build |

**Do not infer** that previous Pancake gift/tier acceptance automatically proves voucher fixed-total allocation with every variation/quantity. Do not use OrderMirror INSERT DRAFT as website-accepted marker. Avoid reusing GQ GLOBAL_ALL_PAID_LINES where voucher ALL_SHOP+exclude is legal.

## 3. Human/evidence gates — design before build, verification after build

| Gate | Timing / proof | Blocks |
| --- | --- | --- |
| H0 — PLAN | Owner explicitly approves this plan. TG-05 A/TG-09/TG-10 B/TG-11 A already decided in merged spec | All implementation /build |
| H1-D — Accepted-order / POS design | **After V00, before V09:** review durable ACCEPTED marker vs mutable DRAFT, capacity/stock reservation ordering, immutable quote, exact VND allocation across repeated variations/gifts, cancellation provenance and offline feasibility fixtures. Sandbox probes require separate operator authorization | V09 adapter implementation (V00 investigation remains possible) |
| H1-V — POS exact-money verification | **After V09, before V12:** real canProjectExactMoney(completeQuote) implementation, deterministic rejection tests, operator-authorized Pancake sandbox write/readback with exact amount and status evidence. If permission/evidence unavailable, remain OFF with no submit-capable holds | V12 real holds and V13/V14 order path, feature enablement |
| H2 — MIGRATION/AUTH | **After V00, before V04:** separate approval of voucher tables **plus durable website-accepted marker/immutable quote persistence** (and cart selection storage if DB-backed), migration and rollback | V04 and dependent DB writes |
| H3-D — HOLD DESIGN | **After V00 + V10, before V11:** review lock ordering, 10-minute TTL, self-held expiry precedence, GET read-only/POST CSRF-idempotency, proof binding and POS-feasibility order. Design sign-off, not runtime test claim | V11 design implementation |
| H3-V — HOLD VERIFICATION | **After V11 + V12, before V13/checkout exposure:** DB+browser evidence for quota/budget/admin cap races, natural expiry/T+10, prefetch/GET no mutation, buyer POST idempotency, signed hold proof and infeasible candidate no-hold | V13, buyer-visible V18 integration and activation |
| H4 — UX | Review Grab-style picker, gift-loss confirmation, mobile/desktop a11y; working UI evidence before final V16–V18 UX sign-off | UI sign-off, not mock/component authoring |
| H5 — SHIP | **After V20 and V21:** full CI, DB/browser/approved POS, observability, security, rollback dossier and owner go/no-go | Production enablement only, not V21 preparation |

**No circular gates:** H1-D/H3-D precede their implementation; H1-V/H3-V are produced by V09/V12 and gate downstream checkout; H5 follows V21. A sandbox probe is never authorized merely by approving this plan.

**Candidate feasibility invariant (AC-20/TG-02):** V03 defines a typed feasibility-filter interface; V08 exposes a preview-only injection seam (no trusted hold/submit capability). V09 implements canProjectExactMoney(completeQuote) for the actual Pancake paid segments/quantity, gift offset and shipping. **Before V12 issues either submit-capable proof or hold**, the server uses this verified predicate for each voucher combination; AUTO excludes infeasible combinations, manual lock receives an explicit unavailable/reconfirm response. **No quota/budget hold and no POS write** for infeasible money. The client never becomes the pricing authority.

**No production writes or deploy in this plan.** Without an evidence gate, dependent functionality stays OFF even if source/tests can still be prepared.

## 4. Dependency graph and incremental slices

~~~text
Spec PR #212 + H0 -> V00 (accepted state, POS, DB, selection design)
V00 -> H1-D -> V09 adapter (also needs V02/V08) -> H1-V
V00 -> H2 -> V04 voucher + accepted-marker persistence
V00 -> V01 -> V02 money -> V03 optimizer / POS feasibility seam
V04 + V01 -> V05 candidates -> V06 Admin edits -> V07 Admin UI
V02 + V03 + V05 -> V08 canonical preview quote
V04 + V08 -> V10 signed proof/snapshot -> H3-D
V04 + V05 + V06 + V10 + H3-D -> V11 atomic hold / real admin race
V09 + H1-V + V10 + V11 -> V12 feasible POST hold -> H3-V
V04 + V09 + V11 + V12 + H1-V + H3-V -> V13 accepted order -> V14 cancel
V03 + V05 + V08 -> V15 picker model + cart-bound selection/CODE POST
V15 -> V16 picker -> V17 PDP/cart (also V15)
V08 + V12 + V13 + V15 + V16 + H3-V -> V18 checkout UI
V05 + V15 + V17 -> V19 safe marketing link
V07 + V09 + V13 + V14 + V16 + V17 + V18 + V19 -> V20 QA
V20 -> V21 runbook/rollback -> H5 launch approval -> /ship separately
~~~

**Invariant ordering:** H1-V is produced after V09 and consumed by V12; H3-V is produced after V12 and consumed by V13/V18; H5 is produced after V21. V06 tests Admin cap edits against fixture holds; only V11 tests live V06 service racing with real voucher grants (AC-45). V12 never grants a voucher that V09 cannot project exactly.

**Slices / potential implementation PRs:** (A) V00–V03 architecture/pure, (B) V04–V07 schema/Admin behind OFF, (C) V08–V10 preview+vendor proof behind OFF, (D) V11–V14 transactional checkout, (E) V15–V19 UI/selection/marketing, (F) V20–V21 QA/runbook. Split V15 selection service and picker model into separate small PRs when needed. Keep direct tests with each code slice, never merge a money-affecting active path before its gates.

**Reviewability:** ADR 0005 recommends <=300 effective changed lines, 301–500 for one concern usually okay and >800 split. File counts below are estimates, not permission for unrelated refactors.

## 5. Task cards (all NOT STARTED)

### Phase A — high-risk gates and pure logic

### V00 — Lock architecture and vendor/cancellation evidence plan
**Intent:** Define durable website ACCEPTED state (distinct from mutable DRAFT and Pancake CONFIRMED), quote immutability, capacity-reservation→voucher-consume transaction, POS exact-money fixtures, trusted cancellation and cart-bound selection storage before schema approval.
**Deps:** none (H0 authorizes /build). **Size:** S/M (2 files). **Produces:** H1-D, H2 proposal and H3-D architecture input.
**Likely files:** docs/decisions/<new-voucher-architecture-adr>.md (new); docs/integrations/pancake-voucher-acceptance.md (new).
**Acceptance:** [ ] State/transaction design puts successful stock reservation before local accepted+consume and guarantees stock failure ⇒ no accepted marker, no consumed voucher, no POS write; [ ] specify accepted-marker and immutable-quote DB constraints/backward compatibility for V04; [ ] offline POS exact allocation/status fixtures, cart selection storage, rollback and operator probe authorization boundary.
**Verify:** architecture/H1-D reviewer + owner H2 review of state machine/transaction failure cases and offline money fixtures. No live POS probe until separately authorized; H1-V evidence comes from V09.

### V01 — Scope, issuance and campaign validation
**Intent:** Pure rules for ALL_SHOP+exclude and TARGETED=(category OR include) AND NOT exclude; public/code-only behavior and threshold/config bounds.
**Deps:** V00. **Size:** S/M (3–4 files).
**Likely files:** src/commerce/voucher-scope.ts (new), voucher-rule-validation.ts (new), tests/domain/voucher-scope.test.ts (new), voucher-rule-validation.test.ts (new).
**Acceptance:** [ ] dynamic parent/child membership & shop isolation; [ ] reject fixed discount min <= amount and invalid states; [ ] no PRIVATE/AUTO and no reuse of GQ global-all resolver.
**Verify:** focused domain tests + tests/domain/gift-quantity-scope.test.ts; review security/bounds.

### V02 — Exact merchandise discount and paid-unit allocation
**Intent:** Pure calculator on post-legacy/post-tier paid groups, correct BigInt half-up/cap/fixed VND, scoped line allocation and stable POS-friendly paid units.
**Deps:** V01. **Size:** M (2–3 files).
**Likely files:** src/commerce/voucher-money.ts (new), voucher-allocation.ts (new), tests/domain/voucher-money.test.ts (new).
**Acceptance:** [ ] EX-03 and fixed/min/% cap/zero-unit rejection; [ ] allocation sum exactly equals D, every paid unit >=1đ; [ ] TG-11 A EX-10 yields 650K-30K-80K=540K, no-voucher=620K, no double tier pass.
**Verify:** focused money domain tests and existing order-subtotal-tier regression tests.

### V03 — Combined optimizer, gift loss, shipping stacking
**Intent:** Evaluate voucher/NONE combinations on a single pre-voucher snapshot, recompute gift/shipping, honor manual locks and accept a typed POS-feasibility predicate so an impossible-to-project voucher never wins AUTO.
**Deps:** V02. **Size:** M (3–4 files).
**Likely files:** src/commerce/voucher-optimizer.ts (new), voucher-shipping.ts (new), tests/domain/voucher-optimizer.test.ts (new), voucher-shipping.test.ts (new).
**Acceptance:** [ ] EX-01 chooses 600K, EX-06 chooses NONE when non-stack shipping raises total, TG-09 gift-preserving tie; [ ] injected infeasible candidate excluded from AUTO and manual choice reported as unavailable (real adapter V09); [ ] manual NONE remains pinned.
**Verify:** focused domain tests, existing tests/domain/shipping-campaign.test.ts if present; verify AC-01..04/08..10/29/30/36.

### Phase B — additive storage and Admin

### V04 — Additive Voucher persistence and OFF flag
**Intent:** Add shop-scoped VoucherCampaign/Hold/Redemption **and V00/H2-approved durable website-accepted marker + immutable accepted quote protection**; cart-bound selection persistence when DB-backed; feature default OFF and historical order compatibility.
**Deps:** V00, H2. **Size:** M (4–5 files).
**Likely files:** prisma/schema.prisma, prisma/migrations/<new-voucher-additive>/migration.sql (new), src/commerce/voucher-gate.ts (new), tests/database/voucher-schema.test.ts (new), tests/domain/voucher-gate.test.ts (new). Split accepted-marker migration into an H2-approved focused sub-PR if needed, **before V13**, never leave storage responsibility to V13.
**Acceptance:** [ ] additive accepted marker (column/state/record chosen by V00) and DB-enforced immutable accepted quote; [ ] unique redemption/holds and scoped campaign/code constraints; [ ] DRAFT remains mutable, historical orders safe, flag OFF still settles previously held vouchers.
**Verify:** pnpm prisma:validate; pnpm prisma:generate; tests for DRAFT-vs-ACCEPTED immutability, migration compatibility/rollback and flag OFF; **do not apply migration without owner H2**.

### V05 — Shop-scoped candidate and quota read model
**Intent:** Bounded active PUBLIC lookup and explicit PRIVATE/CODE validation; dynamic scope and time/revision, no secret code exposure, idempotent reads only.
**Deps:** V01, V04. **Size:** S/M (3 files).
**Likely files:** src/commerce/voucher-candidate-repository.ts (new), voucher-code.ts (new), tests/database/voucher-candidates.test.ts (new).
**Acceptance:** [ ] candidates bounded and shop-checked, private undiscoverable; [ ] expired/disabled excluded for NEW holds but own valid holds still recognizable; [ ] no N+1/secret logging.
**Verify:** focused DB test incl expiry, unknown shop, code enumeration; negative-case security review.

### V06 — Admin writes, lifecycle and committed budget floor
**Intent:** Draft/publish/schedule/disable/copy with RBAC and revision, and cap edit serialized against held+consumed VND/uses.
**Deps:** V04, V05. **Size:** M (3–4 files).
**Likely files:** src/commerce/voucher-admin-service.ts (new), voucher-admin-input.ts (new), tests/database/voucher-admin-operations.test.ts (new), tests/database/voucher-admin-cap-edit.test.ts (new).
**Acceptance:** [ ] Admin RBAC/shop/lifecycle validation; [ ] cap edit rejects under used+live-held floor with shared DB lock/transaction on fixture holds; [ ] disable stops new grants but honors existing. **Real Admin-edit × checkout-hold race is V11, not completed by V06 fixture tests.**
**Verify:** focused Admin validation/cap-edit transaction fixture tests AC-21/41/44/47; AC-45 real checkout/Admin concurrency proof waits for V11.

### V07 — Admin voucher campaign UI
**Intent:** Minimal campaign form/list/status/cap usage and validation feedback under existing Admin promotion area.
**Deps:** V06. **Size:** S/M (3–4 files).
**Likely files:** src/app/admin/promotions/vouchers/page.tsx (new), src/app/admin/promotions/vouchers/actions.ts (new), src/components/brand/voucher-admin-form.tsx (new), tests/a11y-runtime/admin-voucher.spec.ts (new).
**Acceptance:** [ ] disabled by default, errors clear; [ ] shop/role boundaries server-enforced; [ ] usable keyboard/a11y and no exposed PRIVATE codes in public routes.
**Verify:** admin a11y/browser smoke and focused action/integration tests.

### Phase C — authoritative quote, proof, POS

### V08 — Integrate voucher into canonical benefit checkout quote
**Intent:** Produce canonical pre-voucher→voucher→gift/shipping quote plus typed POS feasibility injection; until V09/H1-V, only **read-only preview behind OFF**, never submit-capable voucher proof.
**Deps:** V02, V03, V05. **Size:** M (3–4 files).
**Likely files:** src/commerce/voucher-quote.ts (new), src/commerce/benefit-checkout-quote.ts, tests/domain/voucher-quote.test.ts (new), tests/database/voucher-order-subtotal-checkout.test.ts (new).
**Acceptance:** [ ] TG-11 A tier-first, gift consent and per-combination shipping/total parity; [ ] fail-closed feasibility seam for later V09 adapter, no submit-capable quote when the adapter is absent/unverified.
**Verify:** focused tests AC-05/08/09/22/28/39/46, existing benefit quote/domain regression, flag-OFF parity.

### V09 — POS line-level voucher adapter and acceptance gate
**Intent:** Implement deterministic canProjectExactMoney(completeQuote) for real Pancake quantity/line/variation/gift/shipping facts and return a typed fail-closed result; this is the sole vendor representation used for quote authorization.
**Deps:** V02, V08, H1-D. **Size:** M (3–4 files). **Produces H1-V** after tests and operator-authorized readback.
**Likely files:** src/commerce/pancake-voucher-projection.ts (new), src/commerce/pancake-order-submit.ts, tests/domain/pancake-voucher-projection.test.ts (new), tests/integrations/pancake-voucher-contract.test.ts (new).
**Acceptance:** [ ] exact VND distribution for repeated variations, quantities, shipping and gift 1.000đ projection; [ ] impossible vendor allocation returns infeasible and no eligible hold; [ ] operator-approved Pancake sandbox write/readback or H1-V remains blocked.
**Verify:** domain/integration fixtures, existing pancake-gift-projection tests; operator-controlled sandbox probe/readback (not in CI; explicit authorization required).

### V10 — Quote proof, immutable snapshot and versioning
**Intent:** Bind voucher IDs/revisions/amounts, shipping winner, gift selections, cart paidRevision, hold reference and expiry into signed immutable checkout facts without leaking cart cookie.
**Deps:** V08, V04. **Size:** M (3–4 files).
**Likely files:** src/commerce/voucher-quote-proof.ts (new), src/commerce/checkout-quote-proof.ts, src/commerce/order-quote-snapshot.ts, tests/domain/voucher-quote-proof.test.ts (new).
**Acceptance:** [ ] tamper/stale/ABA and cross-cart proof rejected; [ ] preview proof cannot submit as a held voucher; [ ] old no-voucher proofs/legacy orders remain compatible; bound size/format.
**Verify:** focused proof tests incl mixed gifts, legacy proof tests and code review for token secrecy.

### Phase D — holds, website acceptance and reconciliation

### V11 — Atomic 10-minute holds with quota and budget
**Intent:** Implement atomic two-group 10-minute holds and consistent budget/usage lock order with V06 Admin edit; real V06×V11 concurrency tested here, not prematurely in V06.
**Deps:** V04, V05, V06, V10, H3-D. **Size:** M (3 files). H3-V is produced after V12, not a prerequisite.
**Likely files:** src/commerce/voucher-hold-repository.ts (new), voucher-hold-service.ts (new), tests/database/voucher-hold-races.test.ts (new).
**Acceptance:** [ ] quota=1 never oversubscribed; self-held natural expiry/quota=0 honored until absolute T+10, no rolling renew; [ ] concurrent V06 Admin edit plus V11 grant never breaches cap/invalidates existing hold.
**Verify:** real DB/Admin-grant race tests AC-14..16/31..34/44..45/47, injected transaction failures and ledger consistency.

### V12 — Explicit buyer-initiated POST hold, read-only GET/prefetch
**Intent:** Accept buyer-initiated POST only; **V09 exact-money predicate must pass BEFORE issuing hold or submit-capable quote proof**. GET/prefetch remain read-only, client cannot assert money.
**Deps:** V09, V10, V11, H1-V. **Size:** M (3–4 files). Produces H3-V after browser/DB proof, not blocked by H3-V.
**Likely files:** src/commerce/voucher-checkout-actions.ts (new), voucher-public-actions.ts (new), src/routes/checkout.ts, tests/integrations/voucher-checkout-hold.test.ts (new).
**Acceptance:** [ ] GET/RSC/prefetch/reload cannot hold or renew TTL; [ ] POST CSRF/idempotency grants only when verified V09 feasibility succeeds; [ ] impossible quantity/line allocation ⇒ no hold/budget/proof/POS write, AUTO recomputes, manual needs explicit reconfirm; [ ] retry returns same hold, quote changes reconfirm.
**Verify:** domain/DB/integration test infeasible vendor candidate→zero reservation and no submit proof (AC-20) + production-mode Next Link prefetch/POST evidence (AC-42/43); then H3-V review.

### V13 — Atomic website accepted order and once-only voucher consume
**Intent:** Consume voucher and freeze quote/order at V04's **already persisted** local accepted marker, after successful capacity reservation and before remote POS confirmation.
**Deps:** V04, V09, V11, V12, H1-V, H3-V. **Size:** M (4–5 files).
**Likely files:** src/commerce/voucher-order-acceptance.ts (new), src/commerce/guest-checkout-submit.ts, src/commerce/guest-checkout-snapshot.ts, src/commerce/guest-checkout-submit-runtime.ts, tests/database/voucher-order-acceptance.test.ts (new).
**Acceptance:** [ ] accepted marker + immutable quote and voucher consume atomic on verified quote **after stock reservation succeeds**; stock reservation failure/rollback ⇒ no acceptance/consumption/POS write; [ ] retries/2 tabs cannot double consume/reprice accepted orders; [ ] POS UNKNOWN doesn't refund/publish purchase prematurely.
**Verify:** DB crash/capacity failure/retry/ABA/2-tab acceptance tests AC-17/18/38 plus existing guest capacity/quote regression suite.

### V14 — POS reconciliation, verified cancel and refund once
**Intent:** Refund used quota/budget on trusted definitive reject or cancel, including post-fulfillment, without interpreting SYNC_UNKNOWN/timeout as absent order.
**Deps:** V13, H1-V. **Size:** M (3–4 files).
**Likely files:** src/commerce/voucher-redemption-service.ts (new), src/commerce/pancake-order-status-reconciliation.ts, src/commerce/pancake-order-reconciliation.ts, tests/database/voucher-redemption-reconciliation.test.ts (new).
**Acceptance:** [ ] duplicate/out-of-order cancel and definitive reject refund once; [ ] UNKNOWN stays pending and alertable; [ ] refund after campaign expiry never reactivates it, history unchanged.
**Verify:** DB/reconciliation tests AC-18/19/27 and trust-source/status mapping review.

### Phase E — buyer UX and marketing

### V15 — Picker model + cart-bound selection and CODE validation
**Intent:** Build two-group picker view model **and cart-owned server selection state** (AUTO/manual/NONE/CODE). CSRF-protected, throttled code-validation POST stores manual choice **without any hold**, survives cart→checkout and reload, and never accepts browser money.
**Deps:** V03, V05, V08. **Size:** S/M (3 files).
**Likely files:** src/routes/voucher-picker-model.ts (new), src/commerce/voucher-selection-service.ts (new), src/commerce/voucher-selection-actions.ts (new), tests/domain/voucher-picker-model.test.ts (new), tests/integrations/voucher-selection.test.ts (new). If >5 files, split service + view model into two small PRs.
**Acceptance:** [ ] scoped shortfall and PRIVATE disclosure; [ ] persisted manual voucher/NONE/validated CODE across PDP/cart/checkout/reload until invalid; [ ] invalid/guessed codes rate-limited, cart/shop isolated; selection actions never grant quota/budget.
**Verify:** domain/integration action tests AC-01/04/11/13/26/36/37 incl reload, cart switch, invalid PRIVATE, manual NONE and no-hold security.

### V16 — Responsive Grab-inspired picker component
**Intent:** Responsive Grab-style picker and code input wired to **V15 server-owned validated selection actions**, with two group radios, NONE, disabled reasons and sticky apply footer.
**Deps:** V15. **Size:** M (3 files).
**Likely files:** src/components/brand/voucher-picker.tsx (new), src/components/brand/voucher-card.tsx (new), tests/a11y-runtime/voucher-picker.spec.ts (new).
**Acceptance:** [ ] keyboard/focus/contrast/touch-target a11y; [ ] V15 action response governs selection commit and failure, not client-only state; [ ] cancel/back preserves choice, picker preview never holds quota.
**Verify:** browser a11y/visual checks mobile/desktop AC-12/26; Playwright only where runtime exists.

### V17 — PDP/cart teaser and picker entry points
**Intent:** Small relevant PDP teaser, one cart block with applied savings/progress, no duplicated promotion bars or broken sticky checkout.
**Deps:** V15, V16. **Size:** M (3–4 files).
**Likely files:** src/routes/product.ts, src/routes/cart-model.ts, src/app/cart/page.tsx, tests/domain/voucher-entry-points.test.ts (new).
**Acceptance:** [ ] no fake eligibility/duplicate banners; [ ] PDP/cart operate on V15 selection state used in checkout; [ ] no hold on page render and no sticky CTA regression.
**Verify:** domain + browser PDP/cart smoke, mobile scroll/sticky CTA.

### V18 — Checkout UI and explicit gift-loss confirmation
**Intent:** Show selected vouchers vs preview holds; apply/undo selection while preserving guest COD fields and saved gift choices.
**Deps:** V08, V12, V13, V15, V16, H3-V. **Size:** M (4–5 files).
**Likely files:** src/app/checkout/page.tsx, src/routes/checkout-model.ts, src/commerce/cart-gift-selection-actions.ts, tests/domain/voucher-gift-confirmation.test.ts (new), tests/a11y-runtime/checkout-voucher.spec.ts (new).
**Acceptance:** [ ] voucher/gift preview never silently removes gift; [ ] checkout reads V15 persisted manual/NONE/CODE choice and runs V12 only with H1-V/H3-V; [ ] price/ship increases require consent while COD form remains intact.
**Verify:** targeted domain + browser scenarios AC-08/26/35/42/43 and checkout benefit regressions.

### V19 — Safe KOL/code redemption links
**Intent:** Handle KOL/PRIVATE deep links by sanitizing the URL before analytics and invoking **the same V15 code validation/selection action**, not a duplicate code store.
**Deps:** V05, V15, V17. **Size:** S/M (3 files).
**Likely files:** src/commerce/voucher-marketing-link.ts (new), src/routes/product.ts, tests/integrations/voucher-marketing-link.test.ts (new).
**Acceptance:** [ ] V15 action validates/locks PRIVATE code per cart; [ ] raw URL code absent from referrer/tracking; [ ] guessed/replayed codes rate-limited with shop isolation.
**Verify:** integration/browser network/referrer tests AC-13/40 and security review.

### Phase F — verification, operations and release gates

### V20 — End-to-end convergence, security and observability
**Intent:** Prove quote/render/signed submit/order/POS consistency, failure paths, DB races and whole-flow UX, without Mức 1 session tracking or secrets.
**Deps:** V07, V09, V13, V14, V16, V17, V18, V19. **Size:** M (3–4 verification files per PR; split suites if larger).
**Likely files:** tests/integrations/voucher-checkout-convergence.test.ts (new), tests/database/voucher-invariants.test.ts (new), tests/a11y-runtime/voucher-checkout.spec.ts (new), docs/verification/storefront-voucher-v1.md (new).
**Acceptance:** [ ] AC-01..47/TG-01..12 + H1-V/H3-V have named runtime evidence; [ ] vendor infeasible→no hold, stock failure→no consume, Admin cap race, CODE/NONE persistence and OFF-with-hold tested; [ ] quote/POS money parity and performance baseline.
**Verify:** pnpm test:domain; pnpm test; pnpm test:db; pnpm prisma:validate; pnpm prisma:generate; pnpm typecheck; pnpm lint; pnpm build; Playwright/browser/a11y; operator-authorized vendor acceptance.

### V21 — Production readiness and rollback packet (NOT automatic launch)
**Intent:** Record staged rollout, feature flags, reconciliation operations, counters, rollback and human go/no-go; **do not** enable or deploy as part of this task without new permission.
**Deps:** V20. **Size:** S (2–3 docs). Produces H5 readiness packet; H5 is reviewed AFTER V21.
**Likely files:** docs/operations/storefront-voucher-runbook.md (new), docs/verification/storefront-voucher-v1.md, tasks/storefront-voucher-v1-todo.md.
**Acceptance:** [ ] stop NEW holds while settling existing; [ ] UNKNOWN/refund alerts and reconciliation runbook; [ ] rollback/CI/security evidence assembled for subsequent H5 owner go/no-go without claiming release permission.
**Verify:** human release checklist/DoD, migration rollback dry-run and staging operator evidence; separate /ship approval required.

## 6. Test coverage / acceptance traceability

| Spec acceptance criteria | Primary tasks |
| --- | --- |
| AC-01..04 | V03, V15, V16 |
| AC-05..07 | V01, V02, V06, V08 |
| AC-08..10 | V03, V08, V18 |
| AC-11..13 | V05, V15, V16, V19 |
| AC-14..16 | V11, V12 |
| AC-17..19 | V04, V13, V14 |
| AC-20..22 | V03, V08, V09, V10, V12, V14 |
| AC-23..25 | V04, V05, V08, V10, V11, V12 |
| AC-26..28 | V09, V14, V18 |
| AC-29..30 | V03, V08 |
| AC-31..34 | V10, V11, V12 |
| AC-35..37 | V01, V03, V15, V18 |
| AC-38..39 | V08, V13 |
| AC-40..41 | V06, V11, V19 |
| AC-42..43 | V09, V12, V18 |
| AC-44..45 | V06, V11 |
| AC-46..47 | V02, V08, V11, V20 |

**TG mapping:** TG-01 V00/V13; TG-02 V00/V09; TG-03 V04/V11; TG-04 V00/V14; TG-05 V06/V11/V21; TG-06 V02/V08/V10; TG-07 V16/V18; TG-08 V05/V20/V21; TG-09 V03/V15; TG-10 V03/V08; TG-11 V02/V08; TG-12 V12/V18.

## 7. Checkpoints and no-shortcuts

- **C0 (before /build):** H0 owner sign-off and H1-D/H2 reviewer assigned; H1-D/H2/H3-D reached only after their prerequisite designs, no gates pre-checked.
- **C1 (after V02–V05):** Scope, VND math, TG-11 A and flag-OFF regression covered; DB schema approved/validated before new write paths.
- **C2 (after V09–V10):** H1-V exact POS write/readback and vendor feasibility evidence; V12 remains OFF if unsupported/unauthorized.
- **C3 (after V11–V14):** H3-V after V12 proves hold/POST/preflight concurrency; V13 stock failure cannot consume voucher, V14 handles refunds/UNKNOWN.
- **C4 (after V15–V19):** Grab-like UX, gift-loss confirmation, buyer form retained, KOL URL sanitized; accessibility/browser evidence.
- **C5 (after V21):** V20 QA and V21 rollback packet complete; **then** H5 owner launch go/no-go; no earlier deploy.

**Every implementation PR:** RED regression test where behavior changes → small implementation → focused tests → full relevant suite → security/architecture review → exact-head CI evidence; record command/output and no unresolved Critical/Required. Do not mark TODO checked from code presence alone.

**Plan verification now:** Inspect repository paths/scripts and spec AC/TG coverage; no runtime code, DB migration, live POS call, browser test, deploy or feature enablement is performed by this planning PR.