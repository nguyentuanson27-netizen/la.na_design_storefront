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

## 3. Human/evidence gates (stop before dependent build)

| Gate | Required proof / decision | Blocked work |
| --- | --- | --- |
| H0 — PLAN | Owner reviews and explicitly approves this plan/checkboxes. TG-05 A/TG-09/TG-10 B/TG-11 A are **already decided**, not open questions | **All /build** |
| H1 — MONEY/POS (TG-01/02/04/06) | Reviewed local acceptance transition (immutable quote & once-only consume), deterministic VND allocation + same-variation price segments, trustworthy POS REJECTED/CANCELED/UNKNOWN mapping. Live sandbox write/probe needs **separate explicit operator approval** | V09, V13, V14, enabling order path |
| H2 — MIGRATION/AUTH | Separate owner approval for additive VoucherCampaign/Hold/Redemption schema and any high-impact order acceptance state/API. Migration/rollback/concurrency review; don't reuse blanket spec approval | V04 and all DB writes |
| H3 — QUOTE/HOLD (TG-03/05/11/12) | Source/tests prove fixed pre-voucher D-12 tier, signed hold-bound quote, GET/prefetch is read-only, POST idempotency, 10-minute absolute TTL, cap edits serialized | V11–V14 and checkout CTA |
| H4 — UX (TG-07) | Owner/reviewer signs off representative Grab-style mobile/desktop picker semantics, loss-of-gift confirmation, readable disabled reasons, a11y evidence | V16–V18 sign-off |
| H5 — SHIP (TG-08 + DoD) | Full suite, DB races, sandbox readback, browser a11y, security/PII, observability, feature-OFF parity, backout path, explicit launch go/no-go | Production enablement |

**No production writes or deploy in this plan.** Stop a dependent slice when its gate lacks evidence; don't weaken amount/proof/ship correctness to obtain a green build.

## 4. Dependency graph and incremental slices

~~~text
Merged PR #212 + owner product decisions
    |
    V00 architecture / POS-readback design --------> H1/H2 approval
    |                                                   |
    +-- V01 scope/rule validation -> V02 money -----+    |
    |                                               V03 optimize
    |                                                   |
    +---------------> V04 additive DB + flag --------> V05 campaign reads
                         |                                |
                         +------------------------------> V06 admin writes -> V07 admin UI
                                                          |
                        V02 + V03 + V05 ----------------> V08 quote composition
                                                          |
                                 H1 --> V09 POS adapter <--+
                                          |
                                 V08 --> V10 proof/snapshot
                                          |
                                 V04 + V10 --> V11 hold ledger
                                                    |
                                                V12 POST hold
                                                    |
                                 V09 + V12 --> V13 website accepted order
                                                    |
                                                V14 cancel/reconcile
                                V05 + V08 --> V15 picker model
                                                   |
                                                V16 picker UI
                                               /            \
                                           V17 PDP/cart   V18 checkout
                                              \          /
                                            V19 marketing link
                                                   |
                            V07 + V13 + V14 + V16–V19 --> V20 convergence QA
                                                         |
                                                     V21 release/rollback pack
~~~

**Slices / potential implementation PRs:** (A) V00–V03 pure/evidence, (B) V04–V07 schema/admin behind OFF, (C) V08–V10 quote+POS proof behind OFF, (D) V11–V14 transactional checkout, (E) V15–V19 UX/marketing, (F) V20–V21 QA/ship. Split these further when ownership/risk demands. Each PR must carry its direct tests; never leave an independently mergeable money-affecting path unguarded.

**Reviewability:** ADR 0005 controls effective changed-line scope; <=300 lines preferred, 301–500 usually fine for one concern, >800 generally split. Likely file counts below are **estimates**, not arbitrary hard gates.

## 5. Task cards (all NOT STARTED)

### Phase A — high-risk gates and pure logic

### V00 — Lock architecture and vendor/cancellation evidence plan
**Intent:** Review accepted-marker vs DRAFT, atomic hold→consume, immutable quote, POS exact discount projection and authoritative cancel statuses; document rollback and test boundaries before migration.
**Deps:** none. **Size:** S/M (2 files). **Gate:** H0/H1 for later tasks.
**Likely files:** docs/decisions/<new-voucher-architecture-adr>.md (new); docs/integrations/pancake-voucher-acceptance.md (new).
**Acceptance:** [ ] ADR diagrams state transitions and backfill/version compatibility; [ ] vendor fixtures list discount/quantity/gift+paid segments and readback; [ ] status unknown/reject/cancel mapping and operator-approval boundary are explicit.
**Verify:** ADR reviewer + product owner review; offline sample math & readback test design; **no live POS probe** until separately authorized.

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
**Intent:** Evaluate NONE/MERCHANDISE/SHIPPING_FREE combinations using same pre-voucher snapshot; recompute existing shipping campaign per merchandise candidate and gift eligibility after discount.
**Deps:** V02. **Size:** M (3–4 files).
**Likely files:** src/commerce/voucher-optimizer.ts (new), voucher-shipping.ts (new), tests/domain/voucher-optimizer.test.ts (new), voucher-shipping.test.ts (new).
**Acceptance:** [ ] EX-01 picks 600K not 610K; [ ] EX-06 auto NONE when non-stack freeship would make payable 120K; [ ] TG-09 tie preserves gift and valid manual NONE/locks survive.
**Verify:** focused domain tests, existing tests/domain/shipping-campaign.test.ts if present; verify AC-01..04/08..10/29/30/36.

### Phase B — additive storage and Admin

### V04 — Additive Voucher persistence and OFF flag
**Intent:** New shop-scoped campaign/hold/redemption tables, indexes/checks, revision fields, TTL/ledger constraints; default-OFF independent of existing promotion gates.
**Deps:** V00, H2. **Size:** M (4–5 files).
**Likely files:** prisma/schema.prisma, prisma/migrations/<new-voucher-additive>/migration.sql (new), src/commerce/voucher-gate.ts (new), tests/database/voucher-schema.test.ts (new), tests/domain/voucher-gate.test.ts (new).
**Acceptance:** [ ] migration additive/no legacy rewrite; [ ] unique order/kind redemption and campaign/code per shop; [ ] OFF does not block settling holds already granted or legacy pricing.
**Verify:** pnpm prisma:validate; pnpm prisma:generate; focused DB/schema and flag tests, rollback/compatibility review. **Do not apply migration without owner H2.**

### V05 — Shop-scoped candidate and quota read model
**Intent:** Bounded active PUBLIC lookup and explicit PRIVATE/CODE validation; dynamic scope and time/revision, no secret code exposure, idempotent reads only.
**Deps:** V01, V04. **Size:** S/M (3 files).
**Likely files:** src/commerce/voucher-candidate-repository.ts (new), voucher-code.ts (new), tests/database/voucher-candidates.test.ts (new).
**Acceptance:** [ ] candidates bounded and shop-checked, private undiscoverable; [ ] expired/disabled excluded for NEW holds but own valid holds still recognizable; [ ] no N+1/secret logging.
**Verify:** focused DB test incl expiry, unknown shop, code enumeration; negative-case security review.

### V06 — Admin writes, lifecycle and committed budget floor
**Intent:** Draft/publish/schedule/disable/copy with RBAC and revision, and cap edit serialized against held+consumed VND/uses.
**Deps:** V04, V05. **Size:** M (3–4 files).
**Likely files:** src/commerce/voucher-admin-service.ts (new), voucher-admin-input.ts (new), tests/database/voucher-admin-operations.test.ts (new), tests/database/voucher-admin-cap-race.test.ts (new).
**Acceptance:** [ ] server role/shop guard and publish validation; [ ] cannot lower maxUses/maxBudget below used-not-refunded+valid holds, incl concurrent checkout; [ ] disable/emergency OFF prevents NEW grants but does not revoke 10-min holds.
**Verify:** focused DB race tests AC-21/41/44/45/47 + existing admin baseline.

### V07 — Admin voucher campaign UI
**Intent:** Minimal campaign form/list/status/cap usage and validation feedback under existing Admin promotion area.
**Deps:** V06. **Size:** S/M (3–4 files).
**Likely files:** src/app/admin/promotions/vouchers/page.tsx (new), src/app/admin/promotions/vouchers/actions.ts (new), src/components/brand/voucher-admin-form.tsx (new), tests/a11y-runtime/admin-voucher.spec.ts (new).
**Acceptance:** [ ] disabled by default, errors clear; [ ] shop/role boundaries server-enforced; [ ] usable keyboard/a11y and no exposed PRIVATE codes in public routes.
**Verify:** admin a11y/browser smoke and focused action/integration tests.

### Phase C — authoritative quote, proof, POS

### V08 — Integrate voucher into canonical benefit checkout quote
**Intent:** Resolve pre-voucher stack once, apply optimized scoped discount, recompute gift and shipping (TG-10 B); preserve legacy and flag-OFF behavior.
**Deps:** V02, V03, V05. **Size:** M (3–4 files).
**Likely files:** src/commerce/voucher-quote.ts (new), src/commerce/benefit-checkout-quote.ts, tests/domain/voucher-quote.test.ts (new), tests/database/voucher-order-subtotal-checkout.test.ts (new).
**Acceptance:** [ ] quote pricing follows TG-11 A; [ ] selected gift-loss gets warning/needs confirmation, not silent deletion; [ ] shipping stacking checked for EACH combination and totals identical across quote/summary.
**Verify:** focused tests AC-05/08/09/22/28/39/46, existing benefit quote/domain regression, flag-OFF parity.

### V09 — POS line-level voucher adapter and acceptance gate
**Intent:** Deterministically allocate money into vendor paid lines, preserve gift projection D-08 1.000đ offset and readback hash without a second price authority.
**Deps:** V02, V08, H1. **Size:** M (3–4 files).
**Likely files:** src/commerce/pancake-voucher-projection.ts (new), src/commerce/pancake-order-submit.ts, tests/domain/pancake-voucher-projection.test.ts (new), tests/integrations/pancake-voucher-contract.test.ts (new).
**Acceptance:** [ ] exact D and gift offset even on repeated variations/split segments; [ ] infeasible representation fails closed with typed error; [ ] separate operator-authorized sandbox evidence for API-level exact totals before enabling.
**Verify:** domain/integration fixtures, existing pancake-gift-projection tests; operator-controlled sandbox probe/readback (not in CI; explicit authorization required).

### V10 — Quote proof, immutable snapshot and versioning
**Intent:** Bind voucher IDs/revisions/amounts, shipping winner, gift selections, cart paidRevision, hold reference and expiry into signed immutable checkout facts without leaking cart cookie.
**Deps:** V08, V04. **Size:** M (3–4 files).
**Likely files:** src/commerce/voucher-quote-proof.ts (new), src/commerce/checkout-quote-proof.ts, src/commerce/order-quote-snapshot.ts, tests/domain/voucher-quote-proof.test.ts (new).
**Acceptance:** [ ] tamper/stale/ABA and cross-cart proof rejected; [ ] preview proof cannot submit as a held voucher; [ ] old no-voucher proofs/legacy orders remain compatible; bound size/format.
**Verify:** focused proof tests incl mixed gifts, legacy proof tests and code review for token secrecy.

### Phase D — holds, website acceptance and reconciliation

### V11 — Atomic 10-minute holds with quota and budget
**Intent:** Transactional issue/reuse/swap/expire/release for up to two groups, with deterministic lock order and non-rolling 10-minute TTL.
**Deps:** V04, V05, V10. **Size:** M (3 files).
**Likely files:** src/commerce/voucher-hold-repository.ts (new), voucher-hold-service.ts (new), tests/database/voucher-hold-races.test.ts (new).
**Acceptance:** [ ] quota=1 concurrent holds never oversubscribe; [ ] self-held quota=0 still honors same cart/proof through natural expiry; [ ] reload/swap/expiry exactly T+10 and cap edit races safe.
**Verify:** DB concurrency tests AC-14..16/31..34/44..45/47, transaction failure injection and ledger audit.

### V12 — Explicit buyer-initiated POST hold, read-only GET/prefetch
**Intent:** Separate preview render from side-effecting checkout hold in server action/POST; bind proof to granted hold, no extra forced checkout step.
**Deps:** V10, V11. **Size:** M (3–4 files).
**Likely files:** src/commerce/voucher-checkout-actions.ts (new), voucher-public-actions.ts (new), src/routes/checkout.ts, tests/integrations/voucher-checkout-hold.test.ts (new).
**Acceptance:** [ ] GET/RSC/prefetch/refresh never mutate holds; [ ] POST with CSRF/cart/attempt and idempotency grants/reuses once; [ ] first checkout click or submit may grant while quote change requires explicit reconfirmation.
**Verify:** focused integration tests and production-mode browser/network trace of prefetch vs POST AC-42/43; don't claim test passed without runtime.

### V13 — Atomic website accepted order and once-only voucher consume
**Intent:** Add local accepted marker distinct from DRAFT, consume held vouchers and persist immutable quote/order/vendor facts atomically before POS confirmation.
**Deps:** V09, V11, V12, H1. **Size:** M (4–5 files).
**Likely files:** src/commerce/voucher-order-acceptance.ts (new), src/commerce/guest-checkout-submit.ts, src/commerce/guest-checkout-snapshot.ts, src/commerce/guest-checkout-submit-runtime.ts, tests/database/voucher-order-acceptance.test.ts (new).
**Acceptance:** [ ] 2 tabs/retries/price drift do not double consume; [ ] accepted order never re-priced via DRAFT retry; [ ] POS pending/unknown does not trigger premature refund or confirmed purchase analytics.
**Verify:** DB acceptance/retry/ABA tests AC-17/18/38 and existing guest-checkout snapshot/concurrency tests.

### V14 — POS reconciliation, verified cancel and refund once
**Intent:** Refund used quota/budget on trusted definitive reject or cancel, including post-fulfillment, without interpreting SYNC_UNKNOWN/timeout as absent order.
**Deps:** V13, H1. **Size:** M (3–4 files).
**Likely files:** src/commerce/voucher-redemption-service.ts (new), src/commerce/pancake-order-status-reconciliation.ts, src/commerce/pancake-order-reconciliation.ts, tests/database/voucher-redemption-reconciliation.test.ts (new).
**Acceptance:** [ ] duplicate/out-of-order cancel and definitive reject refund once; [ ] UNKNOWN stays pending and alertable; [ ] refund after campaign expiry never reactivates it, history unchanged.
**Verify:** DB/reconciliation tests AC-18/19/27 and trust-source/status mapping review.

### Phase E — buyer UX and marketing

### V15 — Server picker view model, shortfall and selection locks
**Intent:** Read-only view model of 2 groups with eligible/near-threshold/disabled reasons, actual savings, gift-loss preview and pinned manual NONE/CODE.
**Deps:** V03, V05, V08. **Size:** S/M (3 files).
**Likely files:** src/routes/voucher-picker-model.ts (new), src/commerce/voucher-preview.ts (new), tests/domain/voucher-picker-model.test.ts (new).
**Acceptance:** [ ] scoped shortfall never uses whole-cart ineligible goods; [ ] PRIVATE not listed before validated code; [ ] auto best combo but manual persists until invalid with announcement.
**Verify:** focused domain tests AC-01/04/11/13/36/37.

### V16 — Responsive Grab-inspired picker component
**Intent:** Mobile full-screen and desktop panel/dialog, 2 radios incl NONE, input code, readable disabled cards and sticky "Áp dụng • N ưu đãi".
**Deps:** V15. **Size:** M (3 files).
**Likely files:** src/components/brand/voucher-picker.tsx (new), src/components/brand/voucher-card.tsx (new), tests/a11y-runtime/voucher-picker.spec.ts (new).
**Acceptance:** [ ] focus trap/restore, keyboard, AA contrast, 44px targets, reasons not just grey; [ ] footer commits only after server response; [ ] cancel/back keeps original selection.
**Verify:** browser a11y/visual checks mobile/desktop AC-12/26; Playwright only where runtime exists.

### V17 — PDP/cart teaser and picker entry points
**Intent:** Small relevant PDP teaser, one cart block with applied savings/progress, no duplicated promotion bars or broken sticky checkout.
**Deps:** V15, V16. **Size:** M (3–4 files).
**Likely files:** src/routes/product.ts, src/routes/cart-model.ts, src/app/cart/page.tsx, tests/domain/voucher-entry-points.test.ts (new).
**Acceptance:** [ ] no unconditional eligibility before variant/cart; [ ] one consistent cart/checkout offer summary; [ ] no fake benefit claims, no hold on render.
**Verify:** domain + browser PDP/cart smoke, mobile scroll/sticky CTA.

### V18 — Checkout UI and explicit gift-loss confirmation
**Intent:** Show selected vouchers vs preview holds; apply/undo selection while preserving guest COD fields and saved gift choices.
**Deps:** V08, V12, V13, V16. **Size:** M (4–5 files).
**Likely files:** src/app/checkout/page.tsx, src/routes/checkout-model.ts, src/commerce/cart-gift-selection-actions.ts, tests/domain/voucher-gift-confirmation.test.ts (new), tests/a11y-runtime/checkout-voucher.spec.ts (new).
**Acceptance:** [ ] preview warns and does not silently delete gift; confirm updates gift/voucher atomically and reissues quote; [ ] expiry/fee increase/manual override require buyer acknowledgment without clearing form.
**Verify:** targeted domain + browser scenarios AC-08/26/35/42/43 and checkout benefit regressions.

### V19 — Safe KOL/code redemption links
**Intent:** Capture bounded code as untrusted server intent, redirect/clean URL before GTM/Meta, persist without leaking raw private code or quote/hold token.
**Deps:** V05, V15, V17. **Size:** S/M (3 files).
**Likely files:** src/commerce/voucher-marketing-link.ts (new), src/routes/product.ts, tests/integrations/voucher-marketing-link.test.ts (new).
**Acceptance:** [ ] private code only materializes after validated input and then pins selection; [ ] referrer/analytics never receive the code query; [ ] rate-limit guessing/replay and ensure shop/session isolation.
**Verify:** integration/browser network/referrer tests AC-13/40 and security review.

### Phase F — verification, operations and release gates

### V20 — End-to-end convergence, security and observability
**Intent:** Prove quote/render/signed submit/order/POS consistency, failure paths, DB races and whole-flow UX, without Mức 1 session tracking or secrets.
**Deps:** V07, V09, V13, V14, V16, V17, V18, V19. **Size:** M (3–4 verification files per PR; split suites if larger).
**Likely files:** tests/integrations/voucher-checkout-convergence.test.ts (new), tests/database/voucher-invariants.test.ts (new), tests/a11y-runtime/voucher-checkout.spec.ts (new), docs/verification/storefront-voucher-v1.md (new).
**Acceptance:** [ ] AC-01..47 each has named evidence; [ ] fail-closed, rate limit, privacy, flag-OFF and valid-held-while-OFF cases; [ ] audit quote/POS totals, admin cap/hold race and latency baseline.
**Verify:** pnpm test:domain; pnpm test; pnpm test:db; pnpm prisma:validate; pnpm prisma:generate; pnpm typecheck; pnpm lint; pnpm build; Playwright/browser/a11y; operator-authorized vendor acceptance.

### V21 — Production readiness and rollback packet (NOT automatic launch)
**Intent:** Record staged rollout, feature flags, reconciliation operations, counters, rollback and human go/no-go; **do not** enable or deploy as part of this task without new permission.
**Deps:** V20, H5. **Size:** S (2–3 docs).
**Likely files:** docs/operations/storefront-voucher-runbook.md (new), docs/verification/storefront-voucher-v1.md, tasks/storefront-voucher-v1-todo.md.
**Acceptance:** [ ] kill switch stops NEW holds yet continues existing accepted/held settlement; [ ] refund/reconciliation runbook and alerts for UNKNOWN/budget anomalies; [ ] exact-head CI, security review, owner sign-off and production rollback plan recorded.
**Verify:** human release checklist/DoD, migration rollback dry-run and staging operator evidence; separate /ship approval required.

## 6. Test coverage / acceptance traceability

| Spec acceptance criteria | Primary tasks |
| --- | --- |
| AC-01..04 | V03, V15, V16 |
| AC-05..07 | V01, V02, V06, V08 |
| AC-08..10 | V03, V08, V18 |
| AC-11..13 | V05, V15, V16, V19 |
| AC-14..16 | V11, V12 |
| AC-17..19 | V13, V14 |
| AC-20..22 | V08, V09, V10, V14 |
| AC-23..25 | V04, V05, V08, V10, V11, V12 |
| AC-26..28 | V09, V14, V18 |
| AC-29..30 | V03, V08 |
| AC-31..34 | V10, V11, V12 |
| AC-35..37 | V01, V03, V15, V18 |
| AC-38..39 | V08, V13 |
| AC-40..41 | V06, V11, V19 |
| AC-42..43 | V12, V18 |
| AC-44..45 | V06, V11 |
| AC-46..47 | V02, V08, V11, V20 |

**TG mapping:** TG-01 V00/V13; TG-02 V00/V09; TG-03 V04/V11; TG-04 V00/V14; TG-05 V06/V11/V21; TG-06 V02/V08/V10; TG-07 V16/V18; TG-08 V05/V20/V21; TG-09 V03/V15; TG-10 V03/V08; TG-11 V02/V08; TG-12 V12/V18.

## 7. Checkpoints and no-shortcuts

- **C0 (before /build):** Owner approves **this plan**, architecture gate H1 and migration boundary H2 have named reviewers. All V00..V21 remain unchecked until real evidence exists.
- **C1 (after V02–V05):** Scope, VND math, TG-11 A and flag-OFF regression covered; DB schema approved/validated before new write paths.
- **C2 (after V08–V10):** One server quote, gift/shipping/legacy parity, exact POS contract and signed proof in staging; vendor unsupported cases remain blocked.
- **C3 (after V11–V14):** Holds and website acceptance/remission exactly once; T+10 boundary, cancelled/unknown and 2-tab races; no GET/prefetch mutation.
- **C4 (after V15–V19):** Grab-like UX, gift-loss confirmation, buyer form retained, KOL URL sanitized; accessibility/browser evidence.
- **C5 (after V20):** Full tests + security/POS/observability evidence, review findings closed; **no deployment before separate release decision**.

**Every implementation PR:** RED regression test where behavior changes → small implementation → focused tests → full relevant suite → security/architecture review → exact-head CI evidence; record command/output and no unresolved Critical/Required. Do not mark TODO checked from code presence alone.

**Plan verification now:** Inspect repository paths/scripts and spec AC/TG coverage; no runtime code, DB migration, live POS call, browser test, deploy or feature enablement is performed by this planning PR.