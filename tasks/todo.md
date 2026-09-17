# La.na Design implementation checklist

Status: **DRAFT PLAN — awaiting human approval before `/build`**  
Source: `docs/specs/la-na-design-master-spec.md`  
Baseline: `main@8f7b20552d7dee0df4dff8e662ce508276a65f72`

## Giai đoạn 2 — Brand Config/static truth
- [x] **A1** Sync owner-facts + normalized policy authority with interview overrides; no future legal prose depends on chat memory.
- [x] **A2** Add distinct registered legal address/email/tax issue date; do not expose legal representative.
- [x] **A3** Replace Brand #1 identity/contact/merchant/default SEO truth; preserve `Lana Design` as search alias only.
- [x] **A4** Replace size guide with `ao-dai`, `set-vay-form-rong`, `set-vay-form-nho`; body measurements; cm/kg; no fixed tolerance.
- [x] **A5** Align carriers/delivery/returns/refund/COD-only payment; Hà Nội 1–3, other provinces 3–10.
- [x] **F3a** Create every new navigation destination before cutover: crawlable parent/child category targets **and `/sale`** using existing truthful listing/promotion projections; do not switch active navigation yet.
- [x] **A6** After F3a, atomically activate the approved primary navigation and remove obsolete `/lookbook`/`/flash-sale` links from active navigation surfaces (at least primary + footer); verify all active links resolve non-404.
- [x] **A7a** Update About/contact legal/support surfaces; legal/business roles distinct.
- [x] **A7b** Make all 11 required policy items reachable through dedicated pages + stable `/policies`
  anchors. Owner-approved legal/static content is normalized in
  `docs/specs/la-na-design-policy-authority.md`; COD-only overrides stale bank-transfer payment
  wording, approved contact facts replace placeholders, and no contact-form delivery capability is
  published before F9b.
- [x] **A8** After A6, remove Brand #2 public `/lookbook` + `/flash-sale` routes and align sitemap/canonical policy; `/sale` already exists from F3a and remains the only public discounted-products route.

### Checkpoint A
- [ ] F3a + A1–A8 review: 0 Critical / 0 Required.
- [ ] Active primary + footer destinations all resolve; no active link points to removed `/lookbook`/`/flash-sale`; no build-green/404-nav state.
- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test:domain`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] Brand leak/current-truth checks pass.

## High-risk gates — run early
- [x] **G1** Verify current official Merchant + structured-data availability/date contracts; decide and approve a compliant `availability_date` strategy. Evidence complete in ADR 0011 and **owner-accepted 2026-09-17** at Checkpoint B; I9 backorder publication remains blocked until a reviewed product-level public date authority exists — the acceptance does not lift that block.
- [x] **G2** Controlled Pancake zero/negative-stock + composite write evidence completed on authorized test shop `1720000650`; bounded observations and post-run hardening are recorded in `docs/integrations/pancake-zero-negative-stock-capability-probe.md`, and the evidence was **owner-accepted 2026-09-17** at Checkpoint B with those bounds intact. **Credential incident follow-up:** repository owner confirmed on 2026-09-16 that the previously exposed Pancake credential was revoked/rotated; no credential value is recorded here.
- [x] **G3** Inspect existing outbound-email capability and decide transport; if a new provider/dependency/credential is required, only propose it until Checkpoint B approves that boundary. ADR 0012 proposes Resend via server `fetch`; provider/sender/DNS/secret boundary still requires Checkpoint B. Direct HTTP must supply Resend's required static `User-Agent`.
- [x] **G4** Map merchandising requirements to existing storage; record whether any schema migration is actually required. **ARCHITECTURE-COMPLETE:** ADR 0013 ratifies `src/brand/category.config.ts` as the canonical category taxonomy (identity/hierarchy stay code — no migration) and adds `src/commerce/category-taxonomy.ts` as its query/invariant boundary with domain tests. Membership, category PLP order, category media and the related-product override are specified as five additive models pending Checkpoint B; none is created here. Top-level exclusivity is enforced at the validated admin write boundary and audited, not claimed as a database guarantee — review `5229201195` showed the earlier composite-FK proposal did not actually enforce it. Taxonomy changes bypass that boundary, so ADR §4.8 makes a pre-activation audit against the *proposed* taxonomy a release gate across every category-keyed owner, and §4.9 retires category keys permanently so stale merchandising can never reattach (reviews `5229272917`, `5229297352`). The parent-only membership question is **owner-approved on 2026-09-16: yes**, recorded in `docs/specs/la-na-design-owner-approved-facts-and-decisions.md` › Settled decisions and carried as `APPROVED_CATEGORY_MEMBERSHIP_POLICY` (ADR §4.4); changing it later is one constant plus a data review, no migration.
- [x] **G5** Design/review atomic capacity state machine using G2 evidence; cover retries/ambiguous writes/composites. **ARCHITECTURE-COMPLETE:** ADR 0014 specifies the capacity quantity, per-mode thresholds, reservation state machine, locking/multi-line atomicity, expiration, crash recovery, reconciliation and composite v1 restriction; `src/commerce/capacity-policy.ts` lands the pure predicate with domain tests. Persistence (`ProductSellingPolicy`, `VariantCapacityReservation`) was **separately authorized 2026-09-17** — not covered by the 2026-09-16 five-model approval — and is applied as `20260917080000_add_atomic_capacity_persistence`, after a design review whose four corrections are all in the shipped shape (canonical missing-row resolver, `onDelete: Restrict` on **both** reservation relations, biconditional CHECKs plus `committedAt`/`releasedAt` mutual exclusion, and the §6 lock target moved to an always-present `VariantMirror` row).

### Checkpoint B — before migrations/dependencies

> **Not the same Checkpoint B as `docs/audits/wave-2-checkpoint-b.md`.** That record closes the Wave 2
> growth-commerce checkpoint (U12–U19) at `main@649e04c3` and says nothing about the G1–G5 gates
> below. The two share a name only; do not read one as evidence for the other.
>
> Status: **5 of 5 accepted** (G4 migration path, G5 architecture, G3 transport, G1 mapping, G2
> evidence). Every acceptance is recorded with provenance in
> `docs/specs/la-na-design-owner-approved-facts-and-decisions.md` › Settled decisions.
>
> Closing Checkpoint B does **not** blanket-authorize migrations. Each acceptance carries its own
> stated scope, and two things stay explicitly blocked: ADR 0014 §13 persistence
> (`ProductSellingPolicy`, `VariantCapacityReservation`) needs **separate** migration
> authorization, and I9 may not publish the internal-preorder → `backorder` row until a reviewed
> website-owned product-level public availability date authority exists.
- [x] Human approves G4 merchandising **migration path** — **approved 2026-09-16, all five additive models**: `HomepageFeaturedProduct`, `ProductCategoryMembership`, `CategoryProductOrder`, `CategoryEditorialMedia`, `RelatedProductOverride` (ADR 0013 §3, §4.5, §5, §6, §7). Recorded in `docs/specs/la-na-design-owner-approved-facts-and-decisions.md` › Settled decisions. The approval covers **only** these five additive models: no backfill is permitted, category membership starts empty and admin-assigned, and no existing column changes meaning. The other Checkpoint B rows below are **not** covered by it.
- [x] Human approves G5 selling-policy/capacity **architecture** — **approved 2026-09-16** (ADR 0014; fact authority › Settled decisions). Scope is the architecture only; the §13 persistence still needs separate migration authorization.
- [x] G1 Merchant + structured-data mapping accepted — **accepted 2026-09-17** (ADR 0011; fact authority › Settled decisions). Accepts the shopper-sellability projection, internal `preorder` → Google `backorder`, fulfillable `oversell` → `in_stock`, exact negative limit → `out_of_stock`, and one shared projection for Merchant + JSON-LD. The `backorder` row itself stays **blocked**: `availability_date` is required and no product-level public date authority exists, so I9 must still fail closed there and must not derive a date from `today + 15`, order confirmation or campaign expiry.
- [x] G2 Pancake/composite evidence accepted — **accepted 2026-09-17** (`docs/integrations/pancake-zero-negative-stock-capability-probe.md`; fact authority › Settled decisions). Accepts the bounded observations **with the probe's own limits**: nothing is established about non-1:1 composite multipliers, multi-component atomicity, nested BOMs, a component starting negative, unlimited overselling or storefront concurrency safety. It is the factual basis for ADR 0014 treating Pancake as a non-enforcing upstream and for the composite `OVERSELL`/`PREORDER` v1 restriction — not a licence to lift either. No second live run is authorized.
- [x] G3 transport decision accepted — **approved 2026-09-16**: Resend over server-side `fetch`, `From website@lanadesign.vn` on `lanadesign.vn`, `RESEND_API_KEY` server-only, `name`/`email`/`message` payload, 3/15min + 10/24h pseudonymous rate limit (ADR 0012; fact authority › Settled decisions). Account, key and DNS records are deployment-time work and **do not exist yet**.

## Admin merchandising
- [x] **M1** After A4, reuse `ProductContent.sizeGuide` as allowlisted guide ID; admin selects one of 3 guides.
- [x] **M2** Featured + editorial-image storage. Migration `20260917050000_add_website_owned_merchandising` creates all five approved models, additive and **with no backfill**. `HomepageFeaturedProduct` is standalone and does **not** reuse `CollectionDefinition.featuredProductSlugs`; an empty selection renders an empty section and must never fall back to newest/bestseller (§20). `CategoryEditorialMedia` keys hero and mega-menu media separately by category key, both validated against the reviewed Pancake CDN host contract. Writes go through `merchandising-admin.ts` (`requireAdminSession`) → `merchandising-repository.ts` (transactional full replacement). **Storage only**: `listConfiguredHomepageFeaturedProducts()` is the runtime seam, but no page consumes it yet — rendering is F-series.
- [x] **M3a** Related products implement ADR 0013 §7: manual override (`RelatedProductOverride`) → same subcategory → same parent tree → **no** collection fallback. The superseded shared-collection fallback is **removed** from `storefront-related-products.ts`, so a product with no categories and no manual picks now has no related products. Within-stage order (`CategoryProductOrder.position`, then `name`, then `id`) and multi-subcategory traversal in declared taxonomy order are decided in TypeScript and pinned by 13 domain tests. Self-reference is refused at the admin boundary **and** by a DB CHECK. The PDP consumes this contract.
- [x] **M3b** Default PLP merchandising order. Owner is `CategoryProductOrder`, keyed by the same category key as membership, so a parent PLP ranks the union it lists — a product assigned only to `Áo dài Tết` has no membership row for `aoDai` yet `/ao-dai` can still rank it. A ranking is rejected unless every product is actually listed by that category. **Storage and ordered read only**: `listConfiguredCategoryProducts()` is the runtime seam; the category route is still the F-series placeholder, so no page renders the grid yet.

## Inventory selling modes
- [x] **I1** Selling-policy and reservation persistence applied (`20260917080000_add_atomic_capacity_persistence`): `ProductSellingPolicy` + `VariantCapacityReservation`, two enums, additive, **no backfill**. Existing products default `STANDARD` at `−20` **through `resolveSellingPolicy()`**, not through a column default — a default never fires for a row that does not exist, which is precisely what makes no-backfill safe. `capacity-repository.ts` reads policy through that resolver; 8 database tests pin the no-backfill answer, the intra-row CHECKs in both directions, the `(orderId, variantId)` idempotency key and `onDelete: Restrict` on both relations. ADR 0014 §4.2's stock-observation marker is now **enforced**: `syncPancakeCatalog()` samples a `clock` itself immediately before the first Pancake read, so a post-fetch marker is unrepresentable, and the tests pin the *ordering*. **Order-snapshot is not included** — that is §12/I7 and was never part of the §13 authorization. Reservation **writes** are I6a: they need the §6.2 locking transaction and the §6.4 guarded compare-and-set.
- [x] **I2** Selling-policy writes exist behind `requireAdminSession`: `capacity-admin.ts` → `capacity-repository.ts`, mirroring the M2/M3 boundary rather than inventing a second convention. The mode is an **allowlist of three exact strings** (`standard | oversell | preorder`), refused rather than coerced — `resolveSellingPolicy()` answers an unrecognized *stored* mode with `STANDARD`, which is the right read-path repair and the wrong write-path answer, because it would turn a typo into a silent demotion reported as saved. The limit defaults to `−20`, accepts any non-positive integer with **no invented floor** — the master spec fixes none, so a parser has no standing to legislate one (comment 5714858155) — and refuses a positive value instead of negating it. Two boundary refusals the gate alone would not give an operator: a product that is not a **visible product of this shop** (`ProductSellingPolicy` carries no shop of its own, so nothing in the schema would object), and a **composite parent** set to `OVERSELL`/`PREORDER` (ADR §11 — storing intent that silently never takes effect is worse than refusing it; `STANDARD` on a composite is unaffected). `clearSellingPolicy` returns a product to *unconfigured*, which §5.1's `isDefault` distinguishes from configured-to-the-default. **No migration** — the table is I1's. **Behaviour today is still unchanged**: no page calls this service until **I3** builds the UI, and cart/checkout enforcement is **I5**.
- [ ] **I3** Add admin product UI for mutually exclusive `standard | oversell | preorder` and limit.
- [x] **I4** Sellability is now one rule: `resolveVariantSellability()` in `capacity-policy.ts`, which is `evaluateVariantCapacity()` at quantity 1 — the *same* predicate the reservation gate uses, not a second rule that happens to agree. `buildStorefrontVariantOptions()` consults it instead of the hard-coded `sellableStock <= 0`, which had silently assumed `STANDARD` for every product and would have hidden an `OVERSELL` variant the owner allowed to `−20`. Options gain `isPreorderSale` so a surface can render master spec §30's `Đặt trước` without re-deriving the rule, and never on something unbuyable. Boundary tests pin the limit exactly: `−19 → −20` sells, `−20` does not (`negative-limit-reached`), `−21` stays closed. **Behaviour today is unchanged**: every caller passes the default `STANDARD`/`−20`, because no admin path can set a policy until I2/I3 — the policy value starts flowing then, and cart/checkout enforcement is I5. Merchant/JSON-LD availability stays ADR 0011's separate projection (I9).
- [ ] **I5** Enforce mode/hard-limit eligibility in cart add/update using server truth.
- [x] **I6a** `capacity-reservation.ts` implements the ADR 0014 §6.2 locking transaction and the §6.4 guarded compare-and-set. The lock target is **`VariantMirror`, not the ledger**: `SELECT … FOR UPDATE` locks the rows it returns, and a variant nobody has reserved yet has none, so a ledger lock locks nothing in exactly the state every variant is in before its first sale (§6.1). `READ COMMITTED` is sufficient because correctness comes from the lock, not the level. Seven database tests, and the concurrency ones drive the **empty-ledger** case: 8 concurrent checkouts for 1 unit yield exactly 1 hold, and 6 concurrent for an `OVERSELL` floor of `−3` yield exactly 3 — a floor that is not zero, so it cannot pass by a rule that merely refuses below zero. Each guard was verified against a deliberate mutation: locking the ledger instead of the variant, removing `FOR UPDATE`, and dropping the §7 duplicate-line merge each fail their test. Illegal transitions **throw** while a lost CAS returns `false` — a lost race is worth re-reading, `COMMITTED → RESERVED` never is. **No migration**; the tables are I1's. Checkout integration is **I6b**, cart/checkout eligibility is **I5**.
- [ ] **I6b** Integrate reservation boundary into checkout without breaking quote/order-state protections.
- [ ] **I7** Snapshot preorder line state; 15 calendar days from successful confirmation; mixed order ships together.
- [ ] **I8** Integrate Pancake submission/reconciliation only for G2-supported cases; preserve ambiguous-write safety.
- [ ] **I9** Extend Merchant + structured-data availability projection; keep exact-state/date semantics in parity.

### Checkpoint C
- [ ] Inventory boundary-table tests green.
- [ ] DB concurrency tests green.
- [ ] Admin auth/input tests green.
- [ ] Pancake controlled acceptance satisfied or feature remains non-production/disabled.
- [ ] Merchant + structured-data exact-state/parity tests green.
- [ ] Inventory review: 0 Critical / 0 Required.

## Giai đoạn 3 — FE
- [ ] **F1** Wire approved logo/social/favicon assets + brown/cream tokens + serif/sans typography.
- [ ] **F2a** Build transparent→cream header, mega menus and full-screen mobile navigation.
- [ ] **F2b** Build accessible full-screen search overlay with real product/category suggestions.
- [ ] **F2c** Wire Account header action to existing `/login`; no new account scope.
- [ ] **F2d** Build accessible right-side Cart drawer without changing cart authority.
- [ ] **F3b** Add breadcrumbs/canonicals/internal-link and approved taxonomy SEO hierarchy on top of F3a routes; keep primary + footer link-resolution regression green.
- [ ] **F4a** PLP server contract: filters, manual default order, stable crawlable page/cursor URLs.
- [ ] **F4b** PLP UI: accessible filters + infinite loading + loading/error/empty/back-navigation behavior.
- [ ] **F5** Product card: 4:5, second-image hover, sale display, one marketing badge, availability slot.
- [ ] **F6a** Empty-aware hero: 0 omit / 1 static / 2–3 slider; reduced-motion safe.
- [ ] **F6b** Homepage lower sections in exact approved order; no fake content.
- [ ] **F7a** PDP 2-column editorial gallery with trusted-media fallback.
- [ ] **F7b** PDP buy panel with exact `Thêm vào giỏ` + `Mua ngay`; without size highlight selector + show `Vui lòng chọn size`; standard OOS stays visible/disabled with `Hết hàng`; mobile sticky purchase controls.
- [ ] **F7c** PDP mapped size-guide modal; never infer guide from category.
- [ ] **F7d** PDP related products: manual order first, same-category fallback.
- [ ] **F7e** Render PDP detail blocks in exact approved order; omit missing product-specific facts without inference; shipping/returns use approved policy projections.
- [ ] **F8a** Show preorder/oversell truth on product card + PDP from canonical sellability projection; standard OOS/hard limit remain visible+disabled with exact `Hết hàng`.
- [ ] **F8b** Show preorder preparation/shipping truth in cart + checkout; mixed order ships together.
- [ ] **F8c** Show immutable historical preorder/ETA truth on confirmation + tracking.
- [ ] **F9a** Build final footer/legal/policy UX; non-accordion mobile; no newsletter/representative.
- [ ] **F9b** Implement real contact-form delivery through G3-approved transport with validation/abuse controls; if it requires a new provider/dependency/credential, wait for Checkpoint B before provider/adapter work.

## Final verification
- [ ] **V1** Mobile+desktop browser walkthrough of header/nav/search/home/PLP/PDP/cart/checkout/preorder/static pages.
- [ ] **V1** Keyboard/focus/modal/menu checks.
- [ ] **V1** Axe/accessibility runtime checks.
- [ ] **V1** Compare representative Home/PLP/PDP using the same harness/test data/network profile against `main@8f7b20552d7dee0df4dff8e662ce508276a65f72`; record measurements/observations.
- [ ] **V2** `pnpm lint`
- [ ] **V2** `pnpm typecheck`
- [ ] **V2** `pnpm test:domain`
- [ ] **V2** `pnpm test`
- [ ] **V2** `pnpm test:db`
- [ ] **V2** `pnpm build`
- [ ] **V2** `pnpm release:check`
- [ ] Exact-head CI green.
- [ ] No secrets in diff; migrations/config/rollback documented.
- [ ] `SEARCH_INDEXING_ENABLED=false` still fail-closed.
- [ ] Final review: correctness → security → architecture → simplicity → performance; 0 Critical / 0 Required.

## Explicitly still pending / do not invent
- [ ] Real hero campaign assets/destinations.
- [ ] Child collection names/content.
- [ ] Real source for `Bán chạy` before badge/sort use.
- [ ] Meta Pixel/CAPI.
- [ ] Exact category SEO copy where master spec says draft-for-approval.
- [ ] Production deployment/indexing approval (`/ship`, later).
