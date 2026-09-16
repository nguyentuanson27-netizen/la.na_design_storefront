# La.na Design implementation plan — Brand Config, storefront FE, inventory selling modes

Status: **DRAFT PLAN — awaiting human approval before `/build`**  
Source of truth: `docs/specs/la-na-design-master-spec.md`  
Planning baseline: `main@8f7b20552d7dee0df4dff8e662ce508276a65f72`  
Scope: Giai đoạn 2 Brand Config/static truth, Giai đoạn 3 storefront FE, and cross-cutting `standard | oversell | preorder` inventory selling modes.

## 1. Objective and constraints

Implement the merged master spec without carrying stale LA Clothing truth into Brand #2, weakening existing auth/commerce/security boundaries, or inventing product, collection, campaign, legal, inventory or SEO facts.

Execution order:
1. Brand truth / Giai đoạn 2.
2. High-risk integration evidence and architecture gates.
3. Website-owned merchandising + inventory modes after the applicable gates.
4. Storefront FE / Giai đoạn 3.
5. Convergence and verification.

Hard boundaries:
- `SEARCH_INDEXING_ENABLED=false` remains fail-closed.
- No production deploy/indexing enablement.
- No Core Kit upstream refactor or generic CMS/inventory framework.
- Pancake remains the external commerce integration.
- Bank transfer stays disabled; Meta Pixel/CAPI stays pending.
- No fake collection/campaign/bestseller state.
- Significant migrations/new providers require the named human checkpoint.
- Each implementation task is targeted at S/M scope (about 1–5 files). If actual ownership expands beyond ~5 files or two independent subsystems, split before coding.

## 2. Current-code evidence used for planning

- `src/brand/schema.ts` has one customer contact address/email, flat `NavigationLink[]`, and mandatory numeric `toleranceCm`.
- `src/brand/brand.config.ts`, `navigation.config.ts`, `size-guide.config.ts`, and parts of `fulfillment.config.ts` still contain Brand #1/menswear truth.
- `src/content/public-brand-facts.ts` binds public brand/legal/fulfillment/size facts and assumes fixed size tolerance.
- `ProductContent.sizeGuide` already exists and is website-owned; constrain it instead of duplicating it.
- `CollectionDefinition` already owns website merchandising/collection state; reuse only where semantics fit.
- `storefront-product.ts` treats `sellableStock <= 0` as out-of-stock unconditionally.
- `guest-checkout-snapshot.ts` uses PostgreSQL transactions/row locks for order snapshot integrity, while physical stock remains mirrored external data.
- Merchant offer mapping currently supports only `in_stock | out_of_stock`.
- Admin writes use `requireAdminSession`; all new admin mutations must preserve that boundary.
- Public routes still include `/lookbook` and `/flash-sale`; Brand #2 requires `/sale` and no public lookbook/flash-sale.

## 3. Dependency map

```text
merged master spec
  |
  +--> A1 fact/policy authority sync
  |      +--> A2 legal/contact schema -> A3 identity/contact/merchant/SEO
  |      +--> A4 size guides -> M1 size-guide mapping
  |      +--> A5 fulfillment/payment
  |      +--> A6 nested navigation -> A7a/A7b/A8
  |                                  -> Checkpoint A
  |
  +--> G1 Merchant + structured-data availability decision
  +--> G2 Pancake controlled write probe -> G5 atomic capacity design
  +--> G3 contact mail transport decision
  +--> G4 merchandising persistence design
                                      -> Checkpoint B

Checkpoint A + approved G4
  +--> M2 homepage/category merchandising
       +--> M3 related products + PLP ordering
  NOTE: if M2/M3 require a schema migration, that migration path also waits for Checkpoint B.

Checkpoint B
  +--> I1 persistence
       +--> I2 admin service -> I3 admin UI
       +--> I4 sellability -> I5 cart eligibility
              +--> I6a atomic reservation -> I6b checkout integration
                     +--> I7 preorder snapshot/ETA
                     +--> I8 Pancake submission/reconciliation
       +--> I9 Merchant + structured-data mapping (also G1)
              -> Checkpoint C

Checkpoint A
  +--> F1 assets/tokens
       +--> F2a header/nav -> F2b search
                           -> F2c account
                           -> F2d cart drawer
       +--> F3 taxonomy routes -> F4a PLP server -> F4b PLP UI
       +--> F5 product card
       +--> F6a hero -> F6b homepage
       +--> F7a gallery -> F7b purchase/size/related

Checkpoint C + F5 + F7b
  +--> F8a card/PDP inventory states
       +--> F8b cart/checkout preorder state
            +--> F8c confirmation/tracking historical state

A7a + A7b + F1 -> F9a footer
A7a + approved G3 -> F9b contact delivery

F2a/F2b/F2c/F2d/F3/F4a/F4b/F5/F6a/F6b/F7a/F7b/F8a/F8b/F8c/F9a/F9b
  +--> V1 browser/a11y/performance
       +--> V2 full regression/security/release-readiness with indexing off
```

---

# WORKSTREAM A — GIAI ĐOẠN 2: BRAND CONFIG / STATIC TRUTH

## A1 — Synchronize owner-fact and policy authorities
**Estimated scope:** M (2–5 files)  
**Depends on:** merged master spec

**Work:** update owner facts to current approved truth; preserve `approved / derived / pending`; commit the supplied policy text as repository authority and apply only explicit interview overrides.

**Acceptance:** no approved Brand #2 fact remains unknown; pending campaign/collection/Pixel/bestseller content is not invented; owner-facts/policy/master spec agree.

**Verification:** docs diff + stale placeholder/payment search.

## A2 — Separate legal registration facts from customer/business contact
**Estimated scope:** M (3–5 files)  
**Depends on:** A1

**Work:** add the smallest typed home for registered address, legal email and tax issue date; keep business/return contact separate; do not add a public legal-representative field.

**Acceptance:** legal/business addresses and emails cannot overwrite each other; existing contact consumers remain compatible; representative stays absent.

**Verification:** RED/GREEN domain tests + focused public-facts tests.

## A3 — Replace Brand #1 identity/contact/merchant truth and bind homepage SEO
**Estimated scope:** M (2–4 files)  
**Depends on:** A2

**Work:** apply approved La.na casing/copy/contact/merchant defaults; keep `Lana Design` only as search alias; bind approved homepage title/meta through existing metadata authority.

**Acceptance:** no default/public metadata says LA Clothing/menswear; merchant defaults are `female/adult`; display name remains `La.na Design`.

**Verification:** metadata/domain tests + brand-leak tests.

## A4 — Replace menswear size guides with the three approved body-measurement guides
**Estimated scope:** M (3–5 files)  
**Depends on:** A1

**Work:** model no fixed tolerance as optional/nullable; add exact `ao-dai`, `set-vay-form-rong`, `set-vay-form-nho` tables; cm for body/height, kg for weight.

**Acceptance:** tables exactly match master spec; no old menswear values or `±3 cm`; formatters handle missing tolerance without fake text.

**Verification:** exact row/value assertions + focused domain tests.

## A5 — Align fulfillment/payment current truth
**Estimated scope:** M (2–4 files)  
**Depends on:** A1

**Work:** align approved carriers, delivery estimates, no proactive tracking, return/refund/shipping-responsibility rules, COD-only payment, and unavailable-bank-transfer copy.

**Acceptance:** checkout-facing and public policy agree; no legacy 3–15 ETA, unsupported return promise or enabled bank transfer.

**Verification:** focused policy tests + stale-text search.

## A6 — Add approved nested navigation taxonomy
**Estimated scope:** M (2–4 files)  
**Depends on:** A1

**Work:** evolve flat nav only enough for clickable parent + child links; encode exact approved top-level order and Áo dài/Set đồ children; `/shop` stays out of primary nav; no `Trang chủ`.

**Acceptance:** exact approved hierarchy/order and href contract; no lookbook primary link. Route existence/crawlability is completed in F3.

**Verification:** config/order/href contract tests + presentation boundary tests.

## A7a — Update About/contact legal/support surfaces
**Estimated scope:** M (2–5 files)  
**Depends on:** A2, A3

**Work:** render registered legal data and business/return address with distinct labels; publish approved support contacts/hours/complaint target; defer outbound mail to G3/F9b.

**Acceptance:** no LA Clothing/placeholders; legal representative absent; legal vs support email/address roles are correct.

**Verification:** render tests + V1 runtime check.

## A7b — Make required policy/footer items publicly reachable
**Estimated scope:** M (3–5 files)  
**Depends on:** A1, A5

**Work:** reuse dedicated shipping/returns/contact pages; use one non-duplicative policy hub with stable anchors for remaining policy items; project current Brand Config where owner decisions supersede supplied policy text.

**Acceptance:** every required footer policy item resolves; no old ETA/payment/placeholders/Brand #1 labels.

**Verification:** route/render tests + destination-link resolution + stale-text search.

## A8 — Align public route policy without deleting promotion-engine semantics
**Estimated scope:** M (3–5 files)  
**Depends on:** A6

**Work:** make `/sale` the only public discounted-products route; remove Brand #2 public lookbook/flash-sale surfaces; keep lower-level promotion data model; keep `/collections`, `/new-arrivals`, `/shop`, `/contact`.

**Acceptance:** route/sitemap/canonical contract matches master spec; removed routes are not advertised/indexable; promotion engine remains intact.

**Verification:** route + sitemap tests + build route output.

### Checkpoint A — Brand Config/static truth
Do not claim Giai đoạn 2 complete until A1–A8 have 0 Critical/0 Required findings and the combined head passes `pnpm lint`, `pnpm typecheck`, `pnpm test:domain`, `pnpm test`, `pnpm build`, plus brand-leak/current-truth checks.

---

# WORKSTREAM G — HIGH-RISK INTEGRATION / ARCHITECTURE GATES

## G1 — Lock Google Merchant and structured-data availability semantics
**Estimated scope:** S (ADR/integration note)  
**Depends on:** merged master spec

**Work:** re-check current official Merchant and structured-data contracts; decide valid mappings for `standard`, `oversell`, internal `preorder`, and a compliant `availability_date` authority. The shopper-specific 15-day preparation date cannot silently become a static or continuously moving public date.

**Acceptance:** one documented externally valid mapping for Merchant and structured data; no unsupported value/date semantics.

**Verification:** current official-source links/date recorded + review.

## G2 — Controlled Pancake zero/negative-stock and composite capability probe
**Estimated scope:** M (probe + focused test/evidence note)  
**Depends on:** merged master spec

**Work:** in a network-capable, explicitly authorized safe/non-production test context, run the smallest controlled write probe needed to determine zero/negative-stock order acceptance, upstream stock mutation/locking behavior, and composite behavior. Use test data only; emit bounded evidence; clean up/reconcile created state.

**Acceptance:** write cases are supported/unsupported/ambiguous from actual write evidence. If a safe authorized write probe cannot run, capability remains BLOCKED/UNKNOWN; read-only evidence cannot mark submission supported.

**Verification:** controlled authorized write probe + cleanup/reconciliation record with no customer data, secrets or raw credentials in output.

## G3 — Decide outbound contact-form transport
**Estimated scope:** S (ADR/integration note)  
**Depends on:** merged master spec

**Work:** inspect deployment capability first; if none can deliver to the approved support inbox, propose the smallest provider/dependency/credential boundary including validation, abuse protection, sender identity and secret storage.

**Acceptance:** existing transport is identified or one explicit provider choice is approved; no fake “sent” flow.

**Verification:** configuration/provider evidence; no secret in repo.

## G4 — Design minimal website-owned merchandising persistence
**Estimated scope:** S (design note)  
**Depends on:** merged master spec

**Work:** map size-guide selection, Featured order, PLP order, mega/category image and related-product override to existing storage first; propose only real gaps.

**Acceptance:** each admin-controlled value has one owner/source; smallest additive model documented; whether a migration is required is explicit.

**Verification:** architecture review; any migration path waits for Checkpoint B.

## G5 — Design atomic negative-capacity accounting across local DB + Pancake
**Estimated scope:** S (ADR/state-machine note)  
**Depends on:** G2

**Work:** define reserve/commit/release/reconcile states preventing concurrent orders crossing per-variant `negativeStockLimit`; cover retries, crashes, ambiguous Pancake writes and composites. If composites cannot be safe, forbid selling modes for them in v1.

**Acceptance:** deterministic invariant; no read-check-write race; recovery/rollback path specified.

**Verification:** adversarial concurrency walkthrough + security/data-integrity review.

### Checkpoint B — human architecture approval before migrations/new provider
Required: approve G4 and G5; accept G1 and G2 evidence; decide G3 if contact delivery is in this build wave. No selling-mode migration, new provider, or merchandising schema migration is authorized before this checkpoint.

---

# WORKSTREAM M — WEBSITE-OWNED MERCHANDISING

## M1 — Constrain per-product size-guide mapping
**Estimated scope:** M (2–4 files)  
**Depends on:** A4

**Work:** reuse `ProductContent.sizeGuide` as one of three approved IDs; reject arbitrary values; storefront never infers guide from category.

**Acceptance:** admin can persist only an approved guide ID.

**Verification:** auth/input/domain/repository tests.

## M2 — Implement approved minimal homepage/category merchandising storage
**Estimated scope:** M (3–5 files)  
**Depends on:** Checkpoint A + approved G4; **if G4 requires schema migration, the migration/DB slice also waits for Checkpoint B**.

**Work:** persist only real gaps for manual Featured order and editorial images needed by homepage/mega menu; absence remains absence. Reuse existing storage without migration when G4 proves it fits.

**Acceptance:** choices survive Pancake sync; default state is empty; no schema mutation occurs before Checkpoint B approval.

**Verification:** no-migration path: focused CRUD/order tests. Migration path after Checkpoint B: migrate current DB + fresh DB + CRUD/order tests + rollback note.

## M3 — Add related-product and default PLP merchandising controls
**Estimated scope:** M (3–5 files)  
**Depends on:** Checkpoint A + approved G4 + M2; inherits M2's conditional Checkpoint B gate when the approved persistence requires migration.

**Work:** admin manually orders related products and default PLP products; referenced products must exist; reject duplicates/self-reference; do not invent a `Bán chạy` truth source.

**Acceptance:** deterministic manual order; related fallback remains same-category when no override; no unauthorized schema mutation.

**Verification:** admin auth/input + repository tests.

---

# WORKSTREAM I — INVENTORY SELLING MODES

## I1 — Add website-owned selling-policy/order/reservation persistence
**Estimated scope:** M (3–5 files)  
**Depends on:** Checkpoint B

**Work:** persist exactly one `STANDARD | OVERSELL | PREORDER` product policy and default limit `-20`; persist immutable order/line facts needed for historical preorder truth; capacity model must match G5.

**Acceptance:** existing products default standard; Pancake sync cannot overwrite policy; later policy changes cannot rewrite order history.

**Verification:** migrate-current + fresh DB + constraints/default tests.

## I2 — Admin selling-policy service/repository
**Estimated scope:** M (2–5 files)  
**Depends on:** I1

**Work:** require admin session; allowlist mode; validate bounded negative integer limit; single enum enforces mutual exclusion; disabling mode never rewrites mirrored stock.

**Acceptance:** unauthorized/malformed updates fail closed; writes are website-owned/idempotent.

**Verification:** RED/GREEN auth/input + DB repository tests.

## I3 — Admin selling-mode UI
**Estimated scope:** M (2–4 files)  
**Depends on:** I2

**Work:** one mode selector and relevant limit control; default `-20`; explain enforcement is per variant.

**Acceptance:** oversell/preorder cannot be enabled simultaneously; current value round-trips.

**Verification:** admin browser/accessibility + action tests.

## I4 — One canonical sellability resolver
**Estimated scope:** S (1–2 files)  
**Depends on:** I1

**Rules:** standard `stock <= 0` unavailable; oversell purchasable while `stock > limit` with no special customer status; preorder stock `>0` normal, `stock <=0 && >limit` purchasable as preorder, at limit unavailable. Existing mapping/price/active gates stay intact.

**Acceptance:** storefront/cart/checkout consume one resolver rather than duplicate thresholds.

**Verification:** boundary table at `1, 0, -1, limit+1, limit` plus malformed/inactive/price/mapping cases.

## I5 — Enforce selling-mode eligibility in cart mutations
**Estimated scope:** S (1–3 files)  
**Depends on:** I4

**Work:** reject standard OOS and hard-limit variants; allow oversell/preorder above limit; browser state never becomes authority.

**Acceptance:** cart cannot create obviously ineligible lines.

**Verification:** per-mode/hard-limit cart tests.

## I6a — Implement approved atomic reservation primitive
**Estimated scope:** M (2–5 files)  
**Depends on:** I1, approved G5

**Work:** reserve/release/commit inside DB transaction per G5; concurrent attempts cannot consume the same last unit; retry identifiers are idempotent where required.

**Acceptance:** deterministic concurrency test proves hard limit cannot be crossed.

**Verification:** focused `pnpm test:db` + domain invariants.

## I6b — Integrate reservation boundary into guest checkout
**Estimated scope:** M (2–5 files)  
**Depends on:** I5, I6a

**Work:** reserve capacity at the server-authoritative transition; failure cannot leave a submit-capable draft or leaked reservation; preserve quote/order-state protections.

**Acceptance:** concurrent checkout cannot race past limit; standard checkout stays green.

**Verification:** checkout domain + DB tests; HTTP smoke in V2.

## I7 — Snapshot preorder state, preparation date and mixed-order hold
**Estimated scope:** M (2–5 files)  
**Depends on:** I1, I6b

**Work:** snapshot accepted mode/availability; start 15-calendar-day preparation at successful system confirmation; mixed ready+preorder order ships once after latest preorder readiness; later policy changes do not rewrite history.

**Acceptance:** confirmed orders truthfully render preorder/ETA without rereading current policy.

**Verification:** deterministic date tests including month/year boundaries + mixed-order cases.

## I8 — Integrate Pancake submission/reconciliation under selling modes
**Estimated scope:** M (3–5 files)  
**Depends on:** I6b, G2

**Work:** enable only G2-proven cases; preserve ambiguous-write protection; commit/release local capacity according to confirmed/rejected/unknown outcomes.

**Acceptance:** no capacity leak/double release; unsupported upstream state fails closed with operator-visible reason.

**Verification:** mocked contract tests + controlled live acceptance where available.

## I9 — Merchant + structured-data availability for oversell/backorder
**Estimated scope:** M (3–5 files)  
**Depends on:** I4, G1

**Work:** standard sold-out → out of stock; oversell above hard limit → in stock; internal preorder on released sold-out product → exact G1-approved Merchant backorder/date contract and matching structured-data availability/date semantics; hard limit → out of stock.

**Acceptance:** Merchant feed and structured data reflect buyer ability using valid external vocabulary/date semantics and remain in parity while storefront says `Đặt trước`.

**Verification:** mapper/feed + structured-data tests + Merchant/structured-data parity audits.

### Checkpoint C — inventory modes
Required: boundary-table tests green; DB concurrency proof green; admin auth/input green; Pancake controlled acceptance satisfied or feature remains non-production/disabled; Merchant + structured-data exact-state/parity tests green; 0 Critical/0 Required review findings.

---

# WORKSTREAM F — GIAI ĐOẠN 3: STOREFRONT FE

## F1 — Approved assets and visual tokens
**Estimated scope:** M (2–5 files)  
**Depends on:** Checkpoint A

**Work:** master logo only header/footer; separate approved social card/favicon; warm brown/chocolate + cream; serif display/product names and sans UI/body/price. Never regenerate approved assets.

**Acceptance:** correct asset roles, responsive tokens, contrast passes.

**Verification:** build + browser visual/contrast check.

## F2a — Header, mega nav and mobile navigation
**Estimated scope:** M (3–5 files)  
**Depends on:** A6, F1, M2

**Work:** desktop transparent over hero then cream on scroll; mega menus for Áo dài/Set đồ with admin media when present; full-screen mobile nav; hamburger left/logo center/cart right; keyboard/focus/escape support.

**Acceptance:** approved order/hierarchy; logo `/`; no `Trang chủ` or Wishlist; not hover-only.

**Verification:** responsive browser + keyboard + Axe + boundary tests.

## F2b — Full-screen search overlay
**Estimated scope:** M (2–4 files)  
**Depends on:** F2a, F3

**Work:** build full-screen search using real product + category suggestions; accessible focus trap/restore, Escape, loading/empty/error and polite result announcements.

**Acceptance:** real data only; category suggestions link to F3 routes; keyboard/mobile flow works.

**Verification:** search domain/component tests + desktop/mobile keyboard/Axe walkthrough.

## F2c — Account header interaction
**Estimated scope:** S (1–2 files)  
**Depends on:** F2a

**Work:** wire unauthenticated Account interaction to existing `/login` route/auth boundary; do not introduce new account features.

**Acceptance:** unauthenticated click reaches `/login`; no auth bypass or Wishlist/account scope creep.

**Verification:** focused route/component test + browser click/keyboard check.

## F2d — Cart drawer header interaction
**Estimated scope:** M (2–4 files)  
**Depends on:** F2a

**Work:** open the existing cart state in a right-side drawer; preserve cart server authority; implement focus trap/restore, Escape and accessible empty/error states.

**Acceptance:** cart icon opens/closes drawer without changing cart semantics; keyboard/mobile flow works.

**Verification:** cart regression/component tests + desktop/mobile keyboard/Axe walkthrough.

## F3 — Crawlable category routes, breadcrumbs and SEO hierarchy
**Estimated scope:** M (3–5 files)  
**Depends on:** A6, A8, F1

**Work:** build clickable parent categories + crawlable child URLs; keep `/collections` for real editorial collections; natural La.na/Lana handling without doorway pages; draft exact category SEO copy for owner approval where pending.

**Acceptance:** route existence, canonical/breadcrumb/internal links agree for parent → child → product hierarchy.

**Verification:** route/metadata tests + crawlable-link inspection.

## F4a — Server PLP filter/order/pagination contract
**Estimated scope:** M (3–5 files)  
**Depends on:** F3, M3

**Work:** validate size/price/color/sale filters; manual default order; stable page/cursor URLs capable of server rendering/crawlable discovery; no bestseller sort.

**Acceptance:** validated server-owned filter/order/cursor; stable URL reconstructs page.

**Verification:** query/domain tests + canonical/noindex facet expectations.

## F4b — Accessible filter UI + infinite loading
**Estimated scope:** M (3–5 files)  
**Depends on:** F4a, F5

**Work:** infinite UI consumes F4a cursor; preserve back-navigation/scroll as framework permits; explicit loading/error/empty and polite announcements; crawler fallback remains.

**Acceptance:** keyboard/mobile users can filter/load more; JS is not the only discovery path.

**Verification:** browser scroll/back/keyboard + Axe + route tests.

## F5 — Editorial product-card contract
**Estimated scope:** M (2–4 files)  
**Depends on:** F1

**Work:** 4:5 media, second-image hover if present; serif name/sans price; no size/color/quick-add; sale price/original/% badge; one marketing badge priority `Sale > Hàng mới > Bán chạy` from real data; reserve availability slot for F8a.

**Acceptance:** no fake badge; stable missing-second-image behavior; preorder availability can coexist with marketing badge priority.

**Verification:** component/domain + desktop hover/mobile/a11y.

## F6a — Empty-aware hero slider shell
**Estimated scope:** M (2–4 files)  
**Depends on:** F1

**Work:** 0 slides omit, 1 static, 2–3 autoplay; pause hover/focus/interaction; swipe/drag+dots; no arrows; CTA `Khám phá thiết kế`; desktop overlay/mobile below; reduced-motion safe.

**Acceptance:** no placeholder fiction or broken empty carousel.

**Verification:** browser motion/keyboard/reduced-motion tests.

## F6b — Remaining homepage composition
**Estimated scope:** M (3–5 files)  
**Depends on:** F1, F5, M2, F6a

**Work:** exact order Hero → Hàng mới → Áo dài → Featured → Set/Váy editorial → Service strip → Brand story → Footer; hide Collections until real child collection exists; manual Featured only; approved service/story copy.

**Acceptance:** links real/crawlable; empty admin content omitted, never fabricated.

**Verification:** render tests + responsive visual/a11y.

## F7a — PDP 2-column editorial gallery
**Estimated scope:** S (1–3 files)  
**Depends on:** F1

**Work:** desktop 2-column grid, responsive mobile; preserve trusted-media/fallback behavior; meaningful alt.

**Acceptance:** usable with one/missing image; no duplicate/broken media UI.

**Verification:** component tests + responsive browser/image check.

## F7b — PDP purchase panel, mapped size modal and related products
**Estimated scope:** M (3–5 files)  
**Depends on:** F1, M1, M3, F7a

**Work:** sticky right buy panel; Add + Mua ngay; no auto-selected size; missing size message; standard OOS visible+disabled; mapped guide in accessible modal; mobile sticky bar; details order per spec; manual related fallback same category.

**Acceptance:** server authority preserved; modal/purchase controls accessible; related fallback deterministic.

**Verification:** component/domain + browser purchase/modal/mobile sticky flow.

## F8a — Product-card and PDP inventory presentation
**Estimated scope:** M (2–4 files)  
**Depends on:** Checkpoint C, F5, F7b

**Work:** consume canonical sellability projection. Preorder at `stock <=0 && >limit` says `Đặt trước` on card/PDP/CTA; oversell looks normal; hard-limit/standard OOS remains unavailable.

**Acceptance:** buyer cannot mistake preorder for ready stock on discovery/detail surfaces; no duplicated threshold logic in UI.

**Verification:** projection/component boundary tests + desktop/mobile PDP/card walkthrough.

## F8b — Cart and checkout preorder presentation
**Estimated scope:** M (2–5 files)  
**Depends on:** F8a, I7

**Work:** show preorder state and 15-day preparation + shipping estimate in cart/checkout; mixed ready+preorder order clearly states one shipment after preorder readiness; do not claim guaranteed delivery.

**Acceptance:** checkout truth matches server snapshot and mixed-order rule; oversell remains visually normal.

**Verification:** cart/checkout projection tests + browser checkout flow.

## F8c — Confirmation and tracking historical preorder presentation
**Estimated scope:** M (2–4 files)  
**Depends on:** F8b, I7

**Work:** render preorder/ready date and mixed-order hold from immutable order snapshot on confirmation/tracking, never from current product policy.

**Acceptance:** later policy/stock changes cannot rewrite historical customer messaging.

**Verification:** snapshot projection tests + confirmation/tracking browser check.

## F9a — Footer final UX
**Estimated scope:** M (2–4 files)  
**Depends on:** A7a, A7b, F1

**Work:** four conceptual groups, non-accordion mobile, master logo/strapline/support links, all required policy destinations, exact legal bottom block, no representative/newsletter.

**Acceptance:** every footer link resolves; legal/support roles are correct; mobile remains readable without accordion.

**Verification:** render/link tests + desktop/mobile keyboard/Axe walkthrough.

## F9b — Real contact-form delivery
**Estimated scope:** M (3–5 files)  
**Depends on:** A7a, approved G3

**Work:** implement contact form through approved transport with bounded validation, rate/abuse controls, sender identity and secret-safe error handling.

**Acceptance:** success means provider accepted the delivery attempt; failure is explicit; no credential exposure or fake success.

**Verification:** input/abuse/provider tests + browser form/a11y; live delivery claimed only if actually observed.

---

# WORKSTREAM V — CONVERGENCE / VERIFICATION

## V1 — Full Brand #2 browser, accessibility and performance acceptance
**Estimated scope:** verification-only  
**Depends on:** F2a, F2b, F2c, F2d, F3, F4a, F4b, F5, F6a, F6b, F7a, F7b, F8a, F8b, F8c, F9a, F9b, Checkpoint C

**Scenarios:** desktop/mobile header/nav/search/cart; homepage order/motion/reduced-motion; Áo dài/Set/Váy PLP filters/infinite loading; PDP gallery/size modal/required size; standard OOS/oversell/preorder/hard limit; mixed preorder checkout/confirmation/tracking; About/policy/contact/footer truth.

**Performance baseline:** use the same browser/harness against pre-redesign baseline `main@8f7b20552d7dee0df4dff8e662ce508276a65f72` and the integrated head. Measure representative Home, one PLP and one PDP using the same test data/network profile; record observations rather than claiming improvement without measurement.

**Acceptance:** representative flows work mobile+desktop; keyboard usable; automated accessibility has no blocking violation; measured representative routes have no unexplained regression versus the named baseline.

**Verification:** browser runtime + keyboard + Axe + same-harness baseline/current measurements.

## V2 — Full regression, security review and release-readiness with indexing off
**Estimated scope:** verification-only  
**Depends on:** V1

**Commands to actually run:**
```bash
pnpm lint
pnpm typecheck
pnpm test:domain
pnpm test
pnpm test:db
pnpm build
pnpm release:check
```

Run mirror/Merchant audits only after a real catalog sync makes them meaningful.

**Review gates:** correctness → security → architecture → simplicity → performance; no secrets/provider credentials; migration rollback/compatibility documented; admin mutations server-authorized/validated; exact-head CI green; indexing still false; no deploy/indexing enablement.

**Acceptance:** applicable commands pass with captured evidence, CI exact-head is green, no unresolved blocker, and `SEARCH_INDEXING_ENABLED=false` remains fail-closed.

**Done:** 0 Critical / 0 Required plus project Definition of Done. Production launch is a later `/ship` task.

---

## 4. Parallelization

Safe after plan approval:
- G1/G2/G3/G4 can run concurrently with Workstream A.
- A2/A3/A4/A5/A6 may split after A1, coordinating shared `schema.ts` edits.
- **M1 may start immediately after A4**; it does not wait for Checkpoint A/G4 because it reuses the existing `ProductContent.sizeGuide` owner.
- **M2/M3 wait for Checkpoint A + approved G4.** If the approved G4 design requires a schema migration, that migration/DB slice additionally waits for Checkpoint B; no-migration reuse may proceed before Checkpoint B.
- After Checkpoint A, F1 can proceed while inventory architecture is resolved.
- F2b/F2c/F2d may parallelize after F2a when they do not touch the same header composition file concurrently.
- F6a can be built before campaign content because it supports truthful 0/1/2–3 states.

Must remain sequential:
- G2 → G5 → Checkpoint B → I1 → I6a → I6b → I7/I8.
- Two tasks touching the same Prisma persistence/migration owner.
- F8a → F8b → F8c for consistent buyer/history projection.
- Convergence tasks must integrate accepted dependency heads before verification.

Prefer one PR/branch per task or approved sub-slice; if actual task scope exceeds ~5 files, split before implementation rather than silently widening it.

## 5. Human checkpoints

1. Plan approval — required before `/build`.
2. Checkpoint A — Brand Config/static truth review.
3. Checkpoint B — approve merchandising migration if needed, capacity/reservation architecture, Merchant/structured-data mapping, Pancake evidence and mail provider where applicable.
4. Visual checkpoint — representative desktop/mobile homepage + PLP + PDP with real assets/media.
5. Final implementation review — V2 before `/ship`.

## 6. Definition of Done overlay

Every behavior-changing task must satisfy the project DoD: acceptance criteria met with runtime evidence where relevant; new behavior has tests that fail without the change; existing tests pass; no unrelated refactor/dead/debug code; integration/migration/backward compatibility considered; docs describe current truth; security reviewed for admin/user/external input; observability/rollback/human approval exist for risky production paths.

This plan is implementation-free. It does not authorize migrations, new dependencies/providers, deployment or public indexing until the named checkpoints approve them.
