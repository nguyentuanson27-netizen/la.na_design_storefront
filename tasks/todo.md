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
- [ ] **F3a** Create every new navigation destination before cutover: crawlable parent/child category targets **and `/sale`** using existing truthful listing/promotion projections; do not switch active navigation yet.
- [ ] **A6** After F3a, atomically activate the approved primary navigation and remove obsolete `/lookbook`/`/flash-sale` links from active navigation surfaces (at least primary + footer); verify all active links resolve non-404.
- [x] **A7a** Update About/contact legal/support surfaces; legal/business roles distinct.
- [ ] **A7b** **PARTIAL.** `/policies` hub built with stable anchors; shipping, payment, returns/refund,
  contact, online support and complaint handling all resolve from approved facts. The remaining five
  §33 items — general terms, pricing, privacy, supply conditions, platform rights/obligations — have
  **no approved source text anywhere in the repository** and stay unbuilt rather than authored.
  Blocked on owner content; see owner-facts §11.
- [ ] **A8** After A6, remove Brand #2 public `/lookbook` + `/flash-sale` routes and align sitemap/canonical policy; `/sale` already exists from F3a and remains the only public discounted-products route.

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
- [ ] **G1** Verify current official Merchant + structured-data availability/date contracts; decide and approve a compliant `availability_date` strategy.
- [ ] **G2** Run explicitly authorized Pancake zero/negative-stock + composite write probe in safe/non-production context with cleanup/reconciliation; otherwise remain BLOCKED/UNKNOWN.
- [ ] **G3** Inspect existing outbound-email capability and decide transport; if a new provider/dependency/credential is required, only propose it until Checkpoint B approves that boundary.
- [ ] **G4** Map merchandising requirements to existing storage; record whether any schema migration is actually required.
- [ ] **G5** Design/review atomic capacity state machine using G2 evidence; cover retries/ambiguous writes/composites.

### Checkpoint B — before migrations/dependencies
- [ ] Human approves G4 merchandising **migration path if required**; no merchandising schema migration before this checkpoint.
- [ ] Human approves G5 selling-policy/capacity architecture.
- [ ] G1 Merchant + structured-data mapping accepted.
- [ ] G2 Pancake/composite evidence accepted.
- [ ] G3 transport decision accepted; any new provider/dependency/credential boundary is explicitly approved before F9b provider/adapter work.

## Admin merchandising
- [ ] **M1** After A4, reuse `ProductContent.sizeGuide` as allowlisted guide ID; admin selects one of 3 guides.
- [ ] **M2** After Checkpoint A + approved G4, implement minimal Featured/editorial-image storage; if migration is required, wait for Checkpoint B before migration/DB work.
- [ ] **M3a** After M2, add manual related-product controls; inherit the same conditional Checkpoint B migration gate.
- [ ] **M3b** After M2, add default PLP merchandising order; inherit the same conditional Checkpoint B migration gate.

## Inventory selling modes
- [ ] **I1** Add approved website-owned selling-policy/order-snapshot/reservation persistence; existing products default `STANDARD`.
- [ ] **I2** Add authorized/allowlisted admin service/repository for mode + negative limit; default `-20`.
- [ ] **I3** Add admin product UI for mutually exclusive `standard | oversell | preorder` and limit.
- [ ] **I4** Centralize sellability rules with hard-limit boundary tests.
- [ ] **I5** Enforce mode/hard-limit eligibility in cart add/update using server truth.
- [ ] **I6a** Implement approved atomic reservation/capacity primitive; DB concurrency test proves no overshoot.
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