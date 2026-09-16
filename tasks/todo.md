# La.na Design implementation checklist

Status: **DRAFT PLAN — awaiting human approval before `/build`**  
Source: `docs/specs/la-na-design-master-spec.md`  
Baseline: `main@8f7b20552d7dee0df4dff8e662ce508276a65f72`

## Giai đoạn 2 — Brand Config/static truth
- [ ] **A1** Sync owner-facts doc and commit a normalized owner-supplied terms/policy source with interview overrides; no future legal prose depends on chat memory.
- [ ] **A2** Add distinct registered legal address/email/tax issue date to Brand Config/public bindings; do not expose legal representative.
- [ ] **A3** Replace Brand #1 identity/contact/merchant/default SEO truth with approved La.na values; preserve `Lana Design` as search alias only.
- [ ] **A4** Replace size guide with `ao-dai`, `set-vay-form-rong`, `set-vay-form-nho`; body measurements; cm/kg; no fixed tolerance.
- [ ] **A5** Align delivery/carriers/returns/refund/COD-only payment policy; Hà Nội 1–3, other provinces 3–10.
- [ ] **A6** Add nested primary navigation with approved order and child links; no `Trang chủ`, `/shop` stays out of primary nav.
- [ ] **A7a** Update About/contact legal/support surfaces; no LA Clothing/placeholders; legal/business addresses correctly labeled.
- [ ] **A7b** Make every required footer policy item publicly reachable via existing dedicated pages + one non-duplicative policy hub/anchors; approved prose only.
- [ ] **A8** Add `/sale` public landing; remove Brand #2 `/lookbook` + `/flash-sale` public surfaces without deleting promotion-engine semantics.

### Checkpoint A
- [ ] A1–A6, A7a, A7b, A8 review: 0 Critical / 0 Required.
- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test:domain`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] Brand leak/current-truth checks pass.

## High-risk gates — run early
- [ ] **G1** Verify current official Google Merchant backorder/preorder + `availability_date`; approve rolling-15-day feed strategy.
- [ ] **G2** Run controlled Pancake zero/negative stock + composite capability probe in a network-capable environment.
- [ ] **G3** Inspect existing outbound-email capability; approve minimal contact-form transport if new provider/credential is required.
- [ ] **G4** Map admin merchandising requirements to existing storage; approve smallest additive persistence only for real gaps.
- [ ] **G5** Design and review atomic capacity/reservation state machine using G2 evidence; cover retries/ambiguous writes/composites.

### Checkpoint B — before migrations/dependencies
- [ ] Human approves G4 merchandising storage proposal.
- [ ] Human approves G5 selling-policy/capacity architecture.
- [ ] G1 Merchant mapping accepted.
- [ ] G2 Pancake/composite evidence accepted.
- [ ] G3 mail transport accepted if contact submission is in build wave.

## Admin merchandising
- [ ] **M1** Reuse `ProductContent.sizeGuide` as allowlisted guide ID; admin selects one of 3 guides.
- [ ] **M2** Implement approved homepage/category merchandising storage for manual Featured order/editorial images; empty means empty.
- [ ] **M3** Add manual related-products + default PLP order controls; validate existing products, duplicates and self-reference.

## Inventory selling modes
- [ ] **I1** Add approved website-owned selling-policy/order-snapshot/reservation persistence; existing products default `STANDARD`.
- [ ] **I2** Add authorized, allowlisted admin service/repository for mode + negative limit; default `-20`.
- [ ] **I3** Add admin product UI for mutually exclusive `standard | oversell | preorder` and limit.
- [ ] **I4** Centralize sellability rules for standard/oversell/preorder with hard-limit boundary tests.
- [ ] **I5** Enforce mode/hard-limit eligibility in cart add/update using server truth.
- [ ] **I6a** Implement approved atomic reservation/capacity primitive; DB concurrency test proves no overshoot.
- [ ] **I6b** Integrate reservation boundary into checkout without breaking quote/order-state protections.
- [ ] **I7** Snapshot preorder line state; 15 calendar days from successful confirmation; mixed order ships together.
- [ ] **I8** Integrate Pancake submission/reconciliation only for G2-supported cases; preserve ambiguous-write safety.
- [ ] **I9** Extend Merchant projection: oversell available, internal preorder maps to approved Google backorder/date contract, hard limit out-of-stock.

### Checkpoint C
- [ ] Inventory boundary-table tests green.
- [ ] DB concurrency tests green.
- [ ] Admin auth/input tests green.
- [ ] Pancake controlled acceptance satisfied or feature remains non-production/disabled.
- [ ] Merchant exact-state tests/parity green.
- [ ] Inventory review: 0 Critical / 0 Required.

## Giai đoạn 3 — FE
- [ ] **F1** Wire approved master logo/header-footer, separate social card/favicon, brown/cream tokens, serif display + sans UI.
- [ ] **F2a** Build transparent→cream desktop header, mega menus and full-screen mobile navigation.
- [ ] **F2b** Build full-screen search plus Account `/login` and right-side Cart drawer behavior.
- [ ] **F3** Build crawlable category parent/child routes, breadcrumbs/canonicals and approved taxonomy SEO hierarchy.
- [ ] **F4a** PLP server contract: size/price/color/sale filters, manual default order, stable crawlable page/cursor URLs.
- [ ] **F4b** PLP UI: accessible filters + infinite loading + loading/error/empty/back-navigation behavior.
- [ ] **F5** Product card: 4:5, second-image hover, serif name/sans price, sale display, one marketing badge, dedicated availability slot for F8.
- [ ] **F6a** Empty-aware hero: 0 omit / 1 static / 2–3 slider, truthful content only, reduced-motion safe.
- [ ] **F6b** Homepage lower sections in exact order; no fake collection/campaign/content.
- [ ] **F7a** PDP 2-column editorial gallery with trusted-media fallback.
- [ ] **F7b** PDP sticky buy panel, Add/Mua ngay, required size, mapped size modal, mobile sticky bar and related fallback.
- [ ] **F8** Show `Đặt trước` consistently card/PDP/cart/checkout/confirmation/tracking; oversell stays visually normal; mixed-order ETA truthful.
- [ ] **F9** Footer/About/contact final UX; contact form uses approved transport with validation/abuse controls; no newsletter.

## Final verification
- [ ] **V1** Mobile+desktop browser walkthrough of header/nav/search/home/PLP/PDP/cart/checkout/preorder/static pages.
- [ ] **V1** Keyboard/focus/modal/menu checks.
- [ ] **V1** Axe/accessibility runtime checks.
- [ ] **V1** Representative home/PLP/PDP performance/image observations recorded; no unmeasured performance claim.
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
- [ ] Real hero campaign assets/destinations (2–3 when supplied).
- [ ] Child collection names/content.
- [ ] Real source for `Bán chạy` before badge/sort use.
- [ ] Meta Pixel/CAPI.
- [ ] Exact category SEO copy where master spec says draft-for-approval.
- [ ] Production deployment/indexing approval (`/ship`, later).
