# La.na Design implementation plan — Brand Config, storefront FE, inventory selling modes

Status: **DRAFT PLAN — awaiting human approval before `/build`**  
Source of truth: `docs/specs/la-na-design-master-spec.md`  
Planning baseline: `main@8f7b20552d7dee0df4dff8e662ce508276a65f72`  
Scope: Giai đoạn 2 Brand Config/static truth, Giai đoạn 3 storefront FE, and cross-cutting `standard | oversell | preorder` inventory selling modes.

## 1. Objective and constraints

Implement the merged master spec without carrying stale LA Clothing truth into Brand #2, without weakening existing auth/commerce/security boundaries, and without inventing product, collection, campaign, legal, inventory or SEO facts.

Execution order is deliberately:

1. **Brand truth / Giai đoạn 2** — config, policy, taxonomy, size guides, static routes.
2. **Risk gates** — Merchant semantics, Pancake stock behavior, mail transport, persistence design, atomic capacity design.
3. **Website-owned merchandising + inventory modes** — only after the architecture gates are approved.
4. **Storefront FE / Giai đoạn 3** — buyer-facing redesign on top of stable truth/headless contracts.
5. **Convergence / verification** — browser, accessibility, performance, regression, security and exact-head CI.

Hard boundaries:

- `SEARCH_INDEXING_ENABLED=false` remains fail-closed throughout this plan.
- No production deploy/indexing enablement.
- No Core Kit upstream refactor.
- No generic CMS/design-system/inventory platform for hypothetical future brands.
- Pancake remains the external commerce integration.
- Bank transfer remains disabled on the website.
- Meta Pixel/CAPI stays pending.
- No fake collection/campaign/bestseller state.
- Significant migrations/new providers require the named human checkpoint before implementation.

## 2. Current-code evidence used for planning

- `src/brand/schema.ts` has one customer contact address/email, flat `NavigationLink[]`, and mandatory numeric `toleranceCm`.
- `src/brand/brand.config.ts`, `navigation.config.ts`, `size-guide.config.ts`, and parts of `fulfillment.config.ts` still contain Brand #1/menswear truth.
- `src/content/public-brand-facts.ts` binds public brand/legal/fulfillment/size facts and assumes fixed size tolerance.
- `ProductContent.sizeGuide` already exists and is website-owned; prefer constraining it instead of duplicating it.
- `CollectionDefinition` already owns website merchandising/collection state; reuse only where semantics genuinely fit.
- `storefront-product.ts` currently treats `sellableStock <= 0` as out-of-stock unconditionally.
- `guest-checkout-snapshot.ts` already uses PostgreSQL transactions/row locks for order snapshot integrity, but physical stock remains mirrored external data rather than a local capacity counter.
- Merchant offer mapping currently supports only `in_stock | out_of_stock`.
- Admin writes already use `requireAdminSession`; all new admin mutation paths must preserve that boundary.
- Public routes still include `/lookbook` and `/flash-sale`; Brand #2 requires `/sale` and no public lookbook/flash-sale.

## 3. Dependency map

```text
merged master spec
  |
  +--> A1 fact/policy authority sync
  |      +--> A2 legal/contact schema
  |      +--> A3 identity/contact/merchant/SEO
  |      +--> A4 size guides
  |      +--> A5 fulfillment/payment
  |      +--> A6 nested navigation
  |              +--> A7a About/contact
  |              +--> A7b policy surfaces
  |              +--> A8 route policy
  |                     -> Checkpoint A
  |
  +--> G1 Merchant availability decision
  +--> G2 Pancake zero/negative/composite probe
  +--> G3 contact mail transport decision
  +--> G4 merchandising persistence design
  +--> G5 atomic capacity design (after G2)
         -> Checkpoint B

Checkpoint A + approved G4
  +--> M1 size-guide mapping
  +--> M2 homepage/category merchandising
  +--> M3 related products + PLP ordering

Checkpoint B
  +--> I1 persistence
       +--> I2 admin service -> I3 admin UI
       +--> I4 sellability -> I5 cart eligibility
              +--> I6a atomic reservation -> I6b checkout integration
                     +--> I7 preorder snapshot/ETA
                     +--> I8 Pancake submission/reconciliation
       +--> I9 Merchant mapping (also G1)
              -> Checkpoint C

Checkpoint A
  +--> F1 assets/tokens
       +--> F2a header/nav -> F2b search/account/cart
       +--> F3 taxonomy routes -> F4a PLP server -> F4b PLP UI
       +--> F5 product card
       +--> F6a hero -> F6b homepage
       +--> F7a gallery -> F7b purchase/size/related

Checkpoint C + F5 + F7b
  +--> F8 preorder/oversell buyer states

A7a + A7b + approved G3 + F1
  +--> F9 footer/contact

F2a/F2b/F3/F4a/F4b/F5/F6a/F6b/F7a/F7b/F8/F9
  +--> V1 browser/a11y/performance
       +--> V2 full regression/security/release-readiness with indexing off
```

---

# WORKSTREAM A — GIAI ĐOẠN 2: BRAND CONFIG / STATIC TRUTH

## A1 — Synchronize owner-fact and policy authorities
**Depends on:** merged master spec  
**Likely files:** `docs/specs/la-na-design-owner-approved-facts-and-decisions.md`, new normalized terms/policy source, master spec only for factual typo fixes.

**Work:** update the narrow owner-facts intake from “pending” to current approved truth; preserve `approved / derived / pending`; commit the supplied policy text as a repository authority and apply only explicit interview overrides such as COD-only/current contacts.

**Acceptance:** no approved Brand #2 fact remains marked unknown; no pending campaign/collection/Pixel/bestseller content is invented; owner-facts/policy/master spec agree.

**Verification:** docs diff + search for obsolete “brand fact set empty/pending”, placeholders and old payment truth.

## A2 — Separate legal registration facts from customer/business contact
**Depends on:** A1  
**Likely files:** `src/brand/schema.ts`, `src/brand/brand.config.ts`, `src/content/public-brand-facts.ts`, Brand Config tests.

**Work:** add the smallest typed home for registered address, legal email and tax issue date; retain business/return contact separately; do not add a public legal-representative field.

**Acceptance:** legal/business addresses and emails cannot overwrite each other; existing contact consumers remain compatible; representative stays absent.

**Verification:** RED/GREEN domain tests + focused public-facts tests.

## A3 — Replace Brand #1 identity/contact/merchant truth and bind homepage SEO
**Depends on:** A2  
**Likely files:** `src/brand/brand.config.ts`, `src/seo/root-metadata.ts`, existing social/search identity adapter if needed, metadata tests.

**Work:** apply approved La.na casing/copy/contact/merchant defaults; preserve `Lana Design` only as search alias; bind approved homepage title/meta through existing metadata authority.

**Acceptance:** no default/public metadata says LA Clothing/menswear; merchant defaults are `female/adult`; display name remains `La.na Design`.

**Verification:** metadata/domain tests + brand-leak tests.

## A4 — Replace menswear size guides with the three approved body-measurement guides
**Depends on:** A1  
**Likely files:** `src/brand/schema.ts`, `src/brand/size-guide.config.ts`, `src/content/public-brand-facts.ts`, size-guide tests.

**Work:** model “no fixed tolerance” truthfully as optional/nullable rather than fake `0`; add exact `ao-dai`, `set-vay-form-rong`, `set-vay-form-nho` tables; cm for body/height, kg for weight; chest/waist/hip are body circumferences.

**Acceptance:** tables exactly match master spec; no old garment/menswear values or `±3 cm`; formatters handle missing tolerance without fake text.

**Verification:** exact row/value assertions + focused domain tests.

## A5 — Align fulfillment/payment current truth
**Depends on:** A1  
**Likely files:** `src/brand/fulfillment.config.ts`, public facts/policy projection, focused policy tests.

**Work:** carriers GHN/GHTK/Viettel Post/J&T; Hà Nội 1–3 days, other provinces/cities 3–10; estimates not guarantees; no proactive tracking; approved return/refund/shipping-responsibility rules; COD only; publish `Chuyển khoản ngân hàng hiện tạm thời chưa khả dụng trên website.`

**Acceptance:** checkout-facing and public policy agree; no legacy 3–15 ETA, unsupported return promise or enabled bank transfer.

**Verification:** focused policy tests + stale-text search.

## A6 — Add approved nested navigation taxonomy
**Depends on:** A1  
**Likely files:** `src/brand/schema.ts`, `src/brand/navigation.config.ts`, brand config/presentation seam tests.

**Work:** evolve flat nav only enough for clickable parent + child links; encode exact top-level order and Áo dài/Set đồ children; `/shop` stays out of primary nav; no `Trang chủ`; mutable mega-menu media remains outside static brand truth.

**Acceptance:** exact approved hierarchy/order; child links are real crawlable hrefs; no lookbook primary link.

**Verification:** config/order/href tests + presentation boundary tests.

## A7a — Update About/contact legal/support surfaces
**Depends on:** A2, A3  
**Likely files:** About/contact pages, existing brand document component, focused render tests.

**Work:** render registered legal data and business/return address with distinct labels; publish approved support contacts/hours/complaint target; defer actual outbound mail to G3/F9.

**Acceptance:** no LA Clothing/placeholders; legal representative absent; legal vs support email/address roles are correct.

**Verification:** render tests + runtime page check during V1.

## A7b — Make required policy/footer items publicly reachable
**Depends on:** A1, A5  
**Likely files:** normalized policy view-model, one non-duplicative policy hub/anchors, existing shipping/returns pages, focused route/render tests.

**Work:** reuse dedicated shipping/returns/contact pages; use one policy hub with stable anchors for remaining terms/pricing/privacy/payment/supply limitations/online support/complaints/platform rights; render current Brand Config values where the owner decision supersedes the supplied policy source; do not invent legal commitments.

**Acceptance:** every required footer item resolves; no old ETA/payment/placeholders/Brand #1 policy labels.

**Verification:** route/render tests + destination-link resolution + stale-text search.

## A8 — Align public route policy without deleting promotion-engine semantics
**Depends on:** A6  
**Likely files:** new `/sale`, old `/flash-sale`, old `/lookbook`, sitemap, route tests.

**Work:** make `/sale` the single public discounted-products route; remove Brand #2 public lookbook/flash-sale surfaces; keep lower-level promotion data model; keep `/collections`, `/new-arrivals`, `/shop`, `/contact`.

**Acceptance:** route/sitemap/canonical contract matches master spec; removed routes are not advertised/indexable; promotion engine remains intact.

**Verification:** route + sitemap tests + build route output.

### Checkpoint A — Brand Config/static truth
Do not claim Giai đoạn 2 complete until A1–A8 have 0 Critical/0 Required findings and the combined head passes `pnpm lint`, `pnpm typecheck`, `pnpm test:domain`, `pnpm test`, `pnpm build`, plus brand-leak/current-truth checks. UI redesign is not required for this checkpoint.

---

# WORKSTREAM G — HIGH-RISK INTEGRATION / ARCHITECTURE GATES

These gates should run early in parallel with Workstream A. They produce evidence/approved designs, not speculative implementation.

## G1 — Lock Google Merchant availability semantics
**Depends on:** merged master spec  
**Likely files:** focused ADR/integration note.

**Work:** re-check current official Merchant contract used by this project; decide valid public feed mapping for `standard`, `oversell`, internal `preorder`, and a compliant `availability_date` authority. The per-shopper “15 days after confirmation” date cannot silently become a static feed date.

**Acceptance:** one documented externally valid mapping; no unsupported Google value.

**Verification:** official-source links/date recorded + review.

## G2 — Controlled Pancake zero/negative-stock and composite capability probe
**Depends on:** merged master spec  
**Likely files:** bounded probe under `scripts/`, focused integration test, evidence note.

**Work:** in a network-capable environment determine whether Pancake accepts zero/negative-stock order submission, whether upstream stock mutation/locking changes local capacity design, and how composite parent/components behave. Emit only bounded safe evidence.

**Acceptance:** zero/negative/composite cases are classified supported/unsupported/ambiguous from real evidence.

**Verification:** controlled/read-only evidence. If network is unavailable, remain BLOCKED rather than guessing.

## G3 — Decide outbound contact-form transport
**Depends on:** merged master spec  
**Likely files:** short ADR/integration note only until approved.

**Work:** inspect existing deployment capabilities first; if none can deliver to the approved support inbox, propose the smallest provider/dependency/credential boundary including validation, abuse protection, sender identity and secret storage.

**Acceptance:** existing transport identified or one explicit provider choice awaits/gets human approval; no fake “sent” flow.

**Verification:** configuration/provider evidence; no secret in repo.

## G4 — Design minimal website-owned merchandising persistence
**Depends on:** merged master spec  
**Likely files:** design note; current `ProductContent`/`CollectionDefinition` contracts are read-only inputs to this task.

**Work:** map size-guide selection, Featured order, PLP order, mega/category image and related-product override to existing storage first; propose only real gaps; no generic CMS or fake hidden collections.

**Acceptance:** each admin-controlled value has exactly one owner/source and the smallest additive model is documented.

**Verification:** architecture review; migration blocked until human approval.

## G5 — Design atomic negative-capacity accounting across local DB + Pancake
**Depends on:** G2  
**Likely files:** ADR referencing checkout/order state machine.

**Work:** define reserve/commit/release/reconcile states that prevent concurrent orders crossing per-variant `negativeStockLimit` while physical stock mirror may be stale; cover retries, crashes, ambiguous Pancake writes and composites. If composites cannot be made safe, explicitly forbid selling modes for them in v1.

**Acceptance:** deterministic state machine/invariant; no read-check-write race; recovery/rollback path specified.

**Verification:** adversarial concurrency walkthrough + security/data-integrity review.

### Checkpoint B — human architecture approval before migrations/new provider
Required: approve G4 and G5; accept G1 and G2 evidence; decide G3 if contact delivery is in this build wave. No selling-mode/merchandising migration is authorized before this checkpoint.

---

# WORKSTREAM M — WEBSITE-OWNED MERCHANDISING

## M1 — Constrain per-product size-guide mapping
**Depends on:** A4  
**Likely files:** product-content admin/repository/form + focused test.

**Work:** reuse `ProductContent.sizeGuide` as one of the three approved IDs; reject arbitrary/freehand values; storefront never infers guide from category.

**Acceptance:** admin can persist only an approved guide ID.

**Verification:** auth/input/domain/repository tests.

## M2 — Implement approved minimal homepage/category merchandising storage
**Depends on:** approved G4  
**Likely files:** only the approved persistence owner, Prisma migration if actually required, DB tests.

**Work:** persist only real gaps for manual Featured order and editorial images needed by homepage/mega menu; absence remains absence.

**Acceptance:** choices survive Pancake sync; default state is empty rather than invented.

**Verification:** migrate current DB + fresh DB + CRUD/order tests + rollback note.

## M3 — Add related-product and default PLP merchandising controls
**Depends on:** approved G4, M2 if same owner  
**Likely files:** merchandising domain/repository, admin action/panel, focused tests.

**Work:** admin manually orders related products and default PLP products; referenced products must exist; reject duplicates/self-reference; do not invent a `Bán chạy` truth source.

**Acceptance:** deterministic manual order; related fallback remains same-category when no override.

**Verification:** admin auth/input + repository tests.

---

# WORKSTREAM I — INVENTORY SELLING MODES

## I1 — Add website-owned selling-policy/order/reservation persistence
**Depends on:** Checkpoint B  
**Likely files:** Prisma schema, one migration, generated client per repo convention, DB tests.

**Work:** persist exactly one `STANDARD | OVERSELL | PREORDER` product policy and default limit `-20`; persist only the immutable order/line facts needed for historical preorder truth; reservation/capacity model must match G5 exactly.

**Acceptance:** existing products default standard; Pancake sync cannot overwrite policy; later product-policy changes cannot rewrite order history.

**Verification:** migrate-current + fresh DB + constraints/default tests.

## I2 — Admin selling-policy service/repository
**Depends on:** I1  
**Likely files:** narrow commerce service/repository, admin actions, tests.

**Work:** require admin session; allowlist mode; validate a bounded negative integer limit; mutual exclusion comes from the single enum representation; disabling mode never rewrites mirrored stock.

**Acceptance:** unauthorized/malformed updates fail closed; writes are website-owned/idempotent.

**Verification:** RED/GREEN auth/input + DB repository tests.

## I3 — Admin selling-mode UI
**Depends on:** I2  
**Likely files:** product commerce panel/product admin page + browser/action tests.

**Work:** one mode selector and one relevant limit control; default `-20`; explain enforcement is per variant.

**Acceptance:** oversell/preorder cannot be enabled simultaneously; current value round-trips.

**Verification:** admin browser/accessibility + action tests.

## I4 — One canonical sellability resolver
**Depends on:** I1  
**Likely files:** current storefront product/domain projection + tests.

**Rules:** standard `stock <= 0` unavailable; oversell purchasable while stock is strictly greater than limit with no special customer status; preorder stock `>0` normal, stock `<=0 && >limit` purchasable as `PREORDER`, at limit unavailable. Existing mapping/price/active gates stay intact.

**Acceptance:** storefront/cart/checkout can consume one resolver rather than duplicate thresholds.

**Verification:** boundary table at `1, 0, -1, limit+1, limit` plus malformed/inactive/price/mapping cases.

## I5 — Enforce selling-mode eligibility in cart mutations
**Depends on:** I4  
**Likely files:** anonymous/server cart mutation authority + tests.

**Work:** reject standard OOS and hard-limit variants; allow oversell/preorder above limit; browser quantity/state never becomes authority.

**Acceptance:** cart cannot create obviously ineligible lines.

**Verification:** per-mode/hard-limit cart tests.

## I6a — Implement approved atomic reservation primitive
**Depends on:** I1, approved G5  
**Likely files:** approved capacity repository/domain module + DB concurrency test.

**Work:** reserve/release/commit inside DB transaction per G5; concurrent attempts cannot consume the same last unit; retry identifiers are idempotent where required.

**Acceptance:** deterministic concurrency test proves the hard limit cannot be crossed.

**Verification:** focused `pnpm test:db` + domain invariants.

## I6b — Integrate reservation boundary into guest checkout
**Depends on:** I5, I6a  
**Likely files:** `guest-checkout-snapshot.ts`, submit/state-transition owner, focused checkout/DB tests.

**Work:** reserve capacity at the server-authoritative transition; failure cannot leave a submit-capable draft or leaked reservation; keep money/quote/state protections intact.

**Acceptance:** concurrent checkout cannot race past limit; standard checkout stays green.

**Verification:** checkout domain + DB tests; existing HTTP smoke later in V2.

## I7 — Snapshot preorder state, preparation date and mixed-order hold
**Depends on:** I1, I6b  
**Likely files:** checkout snapshot, order projection/tracking, snapshot tests.

**Work:** snapshot accepted mode/availability; start 15-calendar-day preparation at successful system confirmation; mixed ready+preorder order ships once after latest preorder readiness; mutable later policy does not rewrite history.

**Acceptance:** confirmed orders can truthfully render preorder/ETA without rereading current product policy.

**Verification:** deterministic date tests including month/year boundaries + mixed-order cases.

## I8 — Integrate Pancake submission/reconciliation under selling modes
**Depends on:** I6b, G2  
**Likely files:** Pancake order adapter/state machine, approved reservation reconciliation owner, integration/domain tests.

**Work:** enable only G2-proven cases; preserve existing ambiguous-write protection; commit/release local capacity according to confirmed/rejected/unknown outcomes.

**Acceptance:** no capacity leak/double release; unsupported upstream state fails closed with operator-visible reason.

**Verification:** mocked contract tests + controlled live acceptance where available.

## I9 — Merchant availability for oversell/backorder
**Depends on:** I4, G1  
**Likely files:** merchant offer mapper/feed schema + tests.

**Work:** standard sold-out → out of stock; oversell above hard limit → in stock; internal preorder on released sold-out product → exact G1-approved Google `backorder`/date contract; hard limit → out of stock.

**Acceptance:** feed reflects actual buyer ability and valid external vocabulary while storefront still says `Đặt trước`.

**Verification:** mapper/feed tests + existing Merchant parity/audits.

### Checkpoint C — inventory modes
Required: boundary-table tests green; DB concurrency proof green; admin auth/input green; Pancake controlled acceptance satisfied or feature remains non-production/disabled; Merchant exact-state tests green; 0 Critical/0 Required review findings.

---

# WORKSTREAM F — GIAI ĐOẠN 3: STOREFRONT FE

## F1 — Approved assets and visual tokens
**Depends on:** Checkpoint A  
**Likely files:** existing public/app asset convention, social/favicon source, `globals.css`, shell test.

**Work:** master logo only header/footer; separate approved social card/favicon; warm brown/chocolate + cream; elegant serif display/product names and clean sans UI/body/price. Never regenerate approved assets. If exact uploaded bytes are unavailable to the build agent, ask for re-upload rather than substitute.

**Acceptance:** correct asset roles, responsive tokens, contrast passes.

**Verification:** build + browser visual/contrast check.

## F2a — Header, mega nav and mobile navigation
**Depends on:** A6, F1, M2  
**Likely files:** site header, mega menu, mobile nav, layout, tests.

**Work:** desktop transparent over hero then cream on scroll; mega menus for Áo dài/Set đồ with admin media when present; full-screen mobile nav; hamburger left/logo center/cart right; keyboard/focus/escape support.

**Acceptance:** approved order/hierarchy; logo `/`; no `Trang chủ` or Wishlist; not hover-only.

**Verification:** responsive browser + keyboard + Axe + boundary tests.

## F2b — Search, Account and Cart header interactions
**Depends on:** F2a  
**Likely files:** search overlay, existing search adapter, login route using existing auth, cart drawer interaction, tests.

**Work:** full-screen search with product+category suggestions; unauth account → `/login`; cart → right drawer; focus restoration/escape/live results accessible.

**Acceptance:** real data only; no trending terms/Wishlist.

**Verification:** desktop/mobile keyboard browser + search/cart regressions.

## F3 — Crawlable category routes, breadcrumbs and SEO hierarchy
**Depends on:** A6, A8, F1  
**Likely files:** `/ao-dai` and nested category route adapter, Set/category routes, breadcrumb/SEO helper, tests.

**Work:** clickable parent categories + crawlable child URLs; keep `/collections` for real editorial collections; natural La.na/Lana handling without doorway pages; draft exact category SEO copy for owner approval where still pending.

**Acceptance:** parent → child → product hierarchy and canonical/breadcrumb links agree.

**Verification:** route/metadata tests + crawlable-link inspection.

## F4a — Server PLP filter/order/pagination contract
**Depends on:** F3, M3  
**Likely files:** catalog query/repository, PLP view-model, tests.

**Work:** validate size/price/color/sale filters; manual default order; stable page/cursor URLs capable of server rendering/crawlable discovery; no bestseller sort.

**Acceptance:** validated server-owned filter/order/cursor; stable URL reconstructs page.

**Verification:** query/domain tests + canonical/noindex facet expectations.

## F4b — Accessible filter UI + infinite loading
**Depends on:** F4a, F5  
**Likely files:** filters, grid/infinite loader, route composition, browser test.

**Work:** infinite UI consumes F4a cursor; preserve back-navigation/scroll as framework permits; explicit loading/error/empty and polite announcements; crawler fallback remains.

**Acceptance:** keyboard/mobile users can filter/load more; JS is not the only discovery path.

**Verification:** browser scroll/back/keyboard + Axe + route tests.

## F5 — Editorial product-card contract
**Depends on:** F1  
**Likely files:** product card + projection/test if needed.

**Work:** 4:5 media, 4 desktop/2 mobile grid usage, second-image hover if present; serif name/sans price; no size/color/quick-add; sale price + original strikethrough + percent badge top-right; one marketing badge priority `Sale > Hàng mới > Bán chạy` from real data only; reserve separate availability/status slot for F8.

**Acceptance:** no fake badge; stable missing-second-image behavior; preorder availability can coexist without violating marketing badge priority.

**Verification:** component/domain + desktop hover/mobile/a11y.

## F6a — Empty-aware hero slider shell
**Depends on:** F1  
**Likely files:** hero component + content adapter + tests.

**Work:** accept only real configured slides; 0 slides omit, 1 static, 2–3 autoplay; pause hover/focus/interaction; swipe/drag+dots; no arrows; CTA `Khám phá thiết kế`; desktop overlay/mobile below; respect reduced motion.

**Acceptance:** no placeholder fiction/broken empty carousel.

**Verification:** browser motion/keyboard/reduced-motion tests.

## F6b — Remaining homepage composition
**Depends on:** F1, F5, M2, F6a  
**Likely files:** home route + Áo dài editorial/category/service/story components + render tests.

**Work:** exact order Hero → Hàng mới → Áo dài → Featured → Set/Váy editorial → Service strip → Brand story → Footer; hide Collections until real child collection exists; manual Featured only; exact approved service/story copy.

**Acceptance:** links are real/crawlable; empty admin content is omitted, never fabricated.

**Verification:** render tests + responsive visual/a11y.

## F7a — PDP 2-column editorial gallery
**Depends on:** F1  
**Likely files:** product gallery/detail composition + focused tests.

**Work:** desktop 2-column grid, responsive mobile; preserve trusted-media/fallback behavior; meaningful alt.

**Acceptance:** usable with one/missing image; no duplicate/broken media UI.

**Verification:** component tests + responsive browser/image check.

## F7b — PDP purchase panel, mapped size modal and related products
**Depends on:** F1, M1, M3, F7a  
**Likely files:** purchase panel, size modal, detail/related components, tests.

**Work:** sticky right buy panel; `Thêm vào giỏ` + `Mua ngay`; no auto-selected size; missing size → `Vui lòng chọn size`; standard OOS visible+disabled; exact mapped guide in accessible modal; mobile sticky price+selected size+Add; details order per spec; manual related fallback same category.

**Acceptance:** server authority preserved; modal/purchase controls accessible.

**Verification:** component/domain + browser purchase/modal/mobile sticky flow.

## F8 — Buyer-facing preorder/oversell states
**Depends on:** Checkpoint C, F5, F7b  
**Likely files:** card/PDP view models, cart/checkout/confirmation/tracking projection, tests.

**Work:** preorder at stock `<=0 && >limit` clearly says `Đặt trước` on card/PDP/cart/checkout/confirmation/tracking; oversell looks normal; show 15-day preparation + shipping estimate without claiming guaranteed delivery; mixed order states one shipment after preorder readiness.

**Acceptance:** buyer cannot mistake preorder for ready stock; historical snapshot remains truthful after policy changes.

**Verification:** projection tests + browser purchase flow.

## F9 — Footer and real contact-form delivery
**Depends on:** A7a, A7b, F1, approved G3  
**Likely files:** site footer, contact page/action, approved mail adapter if needed, tests.

**Work:** four-column footer, non-accordion mobile, exact legal bottom block without representative, no newsletter; contact form sends through approved transport with bounded validation/rate/abuse controls and no credential exposure.

**Acceptance:** success means provider accepted delivery attempt; failure explicit; every policy link resolves.

**Verification:** input/abuse/provider tests + browser form/a11y; live delivery claimed only if actually observed.

---

# WORKSTREAM V — CONVERGENCE / VERIFICATION

## V1 — Full Brand #2 browser, accessibility and performance acceptance
**Depends on:** F2a, F2b, F3, F4a, F4b, F5, F6a, F6b, F7a, F7b, F8, F9, Checkpoint C.

**Scenarios:** desktop/mobile header/nav/search/cart; homepage order/motion/reduced-motion; Áo dài/Set/Váy PLP filters/infinite loading; PDP gallery/size modal/required size; standard OOS/oversell/preorder/hard limit; mixed preorder checkout/confirmation; About/policy/contact/footer truth.

**Acceptance:** representative flows work mobile+desktop; keyboard usable; automated accessibility has no blocking violation; performance/image behavior is measured and has no unexplained regression against pre-redesign baseline.

**Verification:** browser runtime + keyboard + Axe + measured representative home/PLP/PDP loading. No unmeasured performance claim.

## V2 — Full regression, security review and release-readiness with indexing off
**Depends on:** V1.

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
- A2/A3/A4/A5/A6 may split by concern after A1, but coordinate shared `schema.ts` edits and do not concurrently edit it from separate branches.
- After Checkpoint A, F1 can proceed while inventory architecture is resolved.
- M1 is independent of selling-mode persistence.
- F2a and F3 can parallelize after shared nav contracts merge; F2b follows F2a.
- F6a can be built before campaign content because it must support 0/1/2–3 truthful states.

Must remain sequential:

- G2 → G5 → Checkpoint B → I1 → I6a → I6b → I7/I8.
- Two tasks touching the same Prisma persistence/migration owner.
- Buyer-facing inventory status F8 waits for the canonical sellability + order-snapshot contract.
- Convergence tasks must integrate accepted dependency heads before verification.

Prefer one PR/branch per task or smaller vertical slice; merge/rebase accepted dependencies before claiming convergence verification.

## 5. Human checkpoints

1. **Plan approval** — required before `/build`.
2. **Checkpoint A** — Brand Config/static truth review.
3. **Checkpoint B** — approve merchandising persistence, capacity/reservation architecture, Merchant mapping, Pancake evidence and mail provider choice where applicable.
4. **Visual checkpoint** — approve representative desktop/mobile homepage + PLP + PDP with real assets/media.
5. **Final implementation review** — V2 before `/ship`.

## 6. Definition of Done overlay

Every behavior-changing task must satisfy the project DoD: acceptance criteria met with runtime evidence where relevant; new behavior has tests that fail without the change; existing tests pass; no unrelated refactor/dead/debug code; integration/migration/backward compatibility considered; docs describe current truth; security reviewed for admin/user/external input; observability/rollback/human approval exist for risky production paths.

This plan is intentionally implementation-free. It does not authorize migrations, new dependencies/providers, deployment or public indexing until the named checkpoints approve them.
