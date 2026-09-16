# Growth + Commerce master execution checklist — PR #151 + #152 + #153

Status: **WAVES 0–4 runtime implementation is delivered through U24; Checkpoint A PASS, Checkpoint B PASS, and Checkpoint D PASS. U9/M1 operational closure is GREEN (executed on `84c99db3de6757c3ded4396644eb4dae25869e09`, tree `ac2e395edafaf5acc83fe98c632145ef7b084aa3`). Wave 5 is partly delivered: U25/M3 is implemented; U26 (PR #198) and U27 are implemented and Checkpoint E is PASSED; U27a closed the availability divergence; PR #214 implemented the Merchant↔JSON-LD one-survivor contract and PR #216 completed its proof set with the missing promotion-aware price case, so the feed↔JSON-LD convergence gate is now GREEN as of #216. O2 is owner-approved as Vietnam / `vi` / `VND`, and PR #226 (`403671ec5d0bff890a8d69fd26626df03d7ad7dc`) wired and verified the reviewed trusted server-owned market authority; the production Merchant route now serves the configured feed while activation remains blocked on the remaining Gate M operational prerequisites. **U28 is the only open Wave 5 unit and remains BLOCKED on O4 vendor configuration and Google Tag Manager account access; Wave 5 is therefore NOT complete.**

Source plan: `tasks/growth-commerce-master-plan.md`

Baseline: `main@36ca06ccc57b89762069e8c0daab575fb6ef1421`.

This checklist tracks orchestration only. Detailed acceptance criteria remain in the source #151/#152/#153 artifacts. Current owner decisions are reconciled in `docs/specs/la-clothing-owner-approved-facts-and-decisions.md` and `docs/audits/owner-facts-reconciliation-2026-09-07.md`; a resolved owner decision does not mark its implementation unit complete.

## Program rules

- [ ] Start each implementation PR from latest reviewed `main` and record exact base SHA.
- [ ] Re-read the owning source task/spec before coding.
- [ ] Keep one authority for pricing, cart truth, identity, variant URL, Purchase, Merchant cache and variant structured data.
- [ ] Split by atomicity/risk/reviewability per ADR 0005; no unrelated refactor.
- [ ] Focused behavior tests first; major checkpoints require 0 Critical / 0 Required.

## Wave 0 — baseline and safety

Wave 0 was delivered from base `main@be1dd63735af358ca6d44c0ad669da2cfd7beb66`. Per ADR 0005 it
was split into five focused pull requests rather than one: **PR-A1 / #156** (U0+U1),
**PR-A2 / #157** (U2), **PR-A3 / #158** (U3), **PR-A4 / #159** (U4) and
**PR-A5 / #160** (U5+U6). They shared one base and owned disjoint subsystems.

All five slices are merged. The post-merge integrated exact-head gate passed on
`main@fe05184518a55e00ba24049fa895c6a4fdc3639c`: CI push run `33413224530` completed both
`verify` and `admin-a11y-runtime` successfully, and Catalog indexation runtime run `33413225233`
(#670) completed successfully. This reconciliation records that merged/integrated state only; it does
not resolve downstream launch gates.

- [x] **U0** Master + #151 P0 — reconcile latest `main`; confirm shared ownership unchanged. *(PR-A1 / #156, merged)*
- [x] **U1** #152 P0/G1 — hard-block indexing on `la.lanadesign.vn`; permanent-domain enablement stays separate. *(PR-A1 / #156, merged)*
- [x] **U2** #153 T1–T3 — canonical events/config/dataLayer/consent/page views; requested preview/live still loads no GTM. *(PR-A2 / #157, merged)*
- [x] **U3** #151 P1 — campaign/target persistence + order audit + bounded durable promotion-pricing revision. *(PR-A3 / #158, merged)*
- [x] **U4** #152 W2a — prove collision-safe metadata uniqueness replacement before slug/path cleanup. *(PR-A4 / #159, merged)* **U4 delivered; B5 is now resolved, and its pair-level publish enforcement is implemented by U29 at the admin publish path. The slug/path copy still remains: removing it additionally needs W2a's database-level enforcement condition, the fallback copy proven collision-free, and real-catalog verification — all still pending.**
- [x] **U5** #152 W15a — inventory dedicated SEO smoke coverage vs existing tests/P18/runtime jobs. *(PR-A5 / #160, merged)* See `docs/audits/seo-runtime-coverage-w15a.md`; all five smokes already run through `pnpm test`, and U13 has two genuinely missing signals to wire.
- [x] **U6** #152 W13A — inventory owner-approved/missing About/Returns/Shipping/Size/Contact facts; missing policy was BLOCKED at the U6 audit point. *(PR-A5 / #160, merged)* See `docs/audits/first-party-content-facts-w13a.md`; B1–B4/B6 are now reconciled as resolved owner decisions below.

## Wave 1 — commerce truth and identity

- [x] **U7** #151 P2 + #152 W3 — central exact pricing resolver + approved real-catalog `pnpm pancake:catalog:audit` evidence. *(PR #162 resolver, PR #163 mirrored-money audit, PR #174 W3 evidence; merged)* W3 verdict **PASS** — real-catalog evidence does not contradict the approved `retailPrice` ownership assumption, so the U7 stop rule was not triggered. The `retailPrice === retailPriceAfterDiscount` availability gate is deliberately still in place and remains U15/P6 work.
- [x] **U8** #153 T4 — propagate `pancakeProductId` / `pancakeVariationId`; keep `VariantMirror.id` internal-only. *(PR #164 cart lines, PR #165 product/option facts; merged)* Composite lines carry the actual purchased component variation ID; unresolvable/private lines fail closed to no external identity.
- [x] **U9** #153 M1 + #152 W4a — **read-only** Merchant identity/durability/catalog audit. **Implementation delivered**: PR #175 proves external-ID durability via §3.3 Option B; PR #194 fixes manufacturer-MPN authority (`display_id` → mirrored `pancakeDisplayId`), media parity, Unicode validation and read-only ownership without repurposing website-owned `VariantMirror.sku`. ADR 0008 records the source/lifecycle contract; no GTIN inference; composites deferred. **Operational acceptance is GREEN**: executed on exact committed post-fix SHA `84c99db3de6757c3ded4396644eb4dae25869e09` (tree `ac2e395edafaf5acc83fe98c632145ef7b084aa3`) on the production mirror with verified CLEAN worktree state; 149/149 MPNs present/valid/unique (`mpnReady = true`), 149/149 media ready, 116 composite deferred. Checkpoint D is GREEN.
- [x] **U10** #151 P3 — repository/lifecycle/runtime health, real component ownership and affected-variant recovery. *(PR #167 lifecycle, PR #168 candidate repository, PR #169 runtime health; merged)* Candidate lookup is two bounded queries with an N+1 guard; lifecycle is derived, so it stays correct across restart and zero traffic.
- [x] **U11** #151 P4 — race-safe admin domain + default-off activation gate + transactional durable revision. *(PR #170 activation validation, PR #171 activation service, PR #172 admin operations; merged)* Activation gate remains **off**; disable/end-early stay campaign-row bounded so rollback survives coverage above 2000.

### Checkpoint A

**PASS** — integrated evidence recorded in `docs/audits/wave-1-checkpoint-a.md`, verified at exact head
`main@d8b1a6696f03bdd683e15577b493e5cf46fa51e0`.

At the Checkpoint A head, the owning source checklists were reconciled to the same then-current truth:
`tasks/promotions-flash-sale-v1-todo.md` recorded P1–P4 + Checkpoint A as delivered with P5 onward open, and
`tasks/marketing-analytics-shopping-todo.md` recorded T1–T3 + T4 as delivered with T5 onward open. Later Wave 2 delivery is tracked below.

- [x] #151 P1–P4 verification green; price evidence accepted; activation gate off. `pnpm lint`,
      `pnpm typecheck`, `pnpm test` (752/752), `pnpm test:db` (292/292) and `pnpm build` all pass;
      migrations deploy clean. Exact-head CI `verify` + `admin-a11y-runtime`, VPS container
      verification and Catalog indexation runtime all succeeded.
- [x] At the Checkpoint A head, identity was ready before consumers depended on it. No storefront, cart, checkout, analytics,
      Merchant or structured-data consumer read the promotion resolver yet; those switches belonged to
      Wave 2 onward.
- [x] Authz/bounds/concurrency/external-data security review green. Admin session required on every
      write before the gate and before any transaction; deterministic revision → campaign → product →
      variant lock order with re-read before commit; mirrored Pancake money treated as untrusted and
      failed closed; no logging of secrets, PII or raw external payloads.
- [x] Fresh review 0 Critical / 0 Required. Three non-blocking observations are carried to U14/P5.

## Wave 2 — addressability and storefront

- [x] **U12** #153 M2 + #152 W4b/W4c — exact standalone variant deep link. *(PR #180, merged; consumes U8 identity and previously accepted external-ID durability evidence.)*
- [x] **U13** #152 W15b — wire only the two missing SEO HTTP/runtime signals from U5 coverage map. *(PR #179, merged; no duplicate smoke suite.)*
- [x] **U14** #151 P5 — promotion admin UX over P4 service boundary; no pricing/overlap authority in React. *(Delivered via P5a PR #184 + P5b PR #185; both merged.)*
- [x] **U15** #151 P6 — PDP promotion projection using central pricing + U8/T4 selected-variant state. *(PR #181, merged; consumes U12 deep-link state rather than defining a second query/canonical contract.)*
- [x] **U16** #151 P7a — `/shop` effective-price discovery; SQL↔TS parity and product-level analytics identity preserved. *(PR #182, merged.)*
- [x] **U17** #151 P7b — `/flash-sale` via same projection; bounded pagination and ≤60s server-relative freshness. *(PR #183, merged.)*

### Checkpoint B

**PASS** — integrated evidence recorded in `docs/audits/wave-2-checkpoint-b.md`, verified at exact head
`main@649e04c328353c016e4ba41831b6eec7d49d1d54` after PR #185 and PR #186 were merged in order.

- [x] P5b / PR #185 integrated on `main`; U18/U19 / PR #186 integrated afterward.
- [x] PDP/cards/shop/Flash share one pricing authority.
- [x] T4 identity regressions and merged U12/M2 addressability regressions are green.
- [x] SQL↔TS parity + required browser freshness/a11y are green.
- [x] Activation remains off.
- [x] Exact-head CI `33739762266`, Catalog runtime `33739762252`, and VPS verification `33739762271` succeeded.
- [x] Fresh integrated review: **0 Critical / 0 Required**.

Checkpoint B no longer blocks U20/P8, which is merged. Later promotion activation and downstream launch work remain gated by their own acceptance criteria and Checkpoint C.

## Wave 3 — canonical analytics/cart APIs

- [x] **U18** #153 T5 — upper-funnel `view_item_list` / `select_item` / initial product-level `view_item` + product-vs-selected-variant semantics + atomic PDP `+1` with authoritative committed event snapshot. Depends U7 + U8; may run in parallel with U15–U17.
- [x] **U19** #153 T6 + #151 shared checkpoint — authoritative update/remove facts + complete all-or-nothing cart/checkout projection; one shared API only.

Wave 3 also converged cart, checkout render and the order snapshot onto the central promotion
resolver, which the #151 shared cart checkpoint required. Before this, a promotion was visible on
the PDP and on `/shop` but the cart and the submitted order still quoted the undiscounted base
price. U20/P8 was unblocked by the master storefront Checkpoint B and is now merged via PR #189, having met its own DRAFT quote/audit acceptance criteria.

## Wave 4 — checkout/order convergence

- [x] **U20** #151 P8 — mutable DRAFT quote/audit after U17 + U19. Merged via PR #189.
- [x] **U21** #151 P9a — bounded stateless server-MAC rendered-quote proof; raw HttpOnly cart UUID remains server-only context. Merged via PR #190.
- [x] **U22** #151 P9b — fresh Pancake reconfirmation through central resolver; mismatch => refreshed DRAFT + `PRICE_CHANGED`, no create. Merged via PR #191.
- [x] **U23** #151 P10 — final Pancake convergence; all three raw-`livePrice` regressions + controlled custom-price acceptance. Merged via PR #192.
- [x] **U24** #153 T7 — confirmed Purchase from immutable order snapshot; `publicCode` remains transaction/event ID. Merged via PR #193.

### Checkpoint C

- [ ] **Blocker:** real discounted promotion activation and live enabling/publishing of price-bearing downstream destinations that rely on finalized transaction truth must wait for Checkpoint C; U25-U27 implementation may proceed from their own prerequisites.
- [ ] Two-stage `PRICE_CHANGED` and three Pancake regressions green.
- [ ] Custom-price acceptance succeeds or promotion activation remains blocked.
- [ ] Immutable Purchase identity/value + direct Meta compatibility green.
- [ ] Fresh review 0 Critical / 0 Required.

## Wave 5 — downstream consumers

- [x] **U25** #153 M3 — standalone Merchant mapper from audited IDs + canonical effective price + exact U12 URL. **Implemented.** Pure `mapMerchantOffers` over a bounded canonical loader, reusing the shared promotional pricing rule, the M1 availability/identity/text classifiers, the trusted storefront media resolver and U12's own deep-link resolver as the addressability proof. The ADR 0007 O3 runtime (website-owned `ProductMerchantFacts`, server-authoritative validation, admin editing, effective-fact resolution, resync preservation) lands with it. Composites stay `COMPOSITE_DEFERRED`; unresolved facts fail closed with bounded reasons. **Historical U25 context:** O2 was already owner-approved as Vietnam / `vi` / `VND`, but trusted runtime market authority had not landed yet. **Current truth:** PR #226 now provides that reviewed server-owned authority; the mapper remains caller-independent and fails closed when server configuration is missing, malformed or unapproved.**
- [x] **U26** #153 M4 + #151 — bounded public feed/cache/single-flight/backoff + durable promotion revision; no request-controlled cache dimensions. **Implemented** (PR #198, merged as `2d5ea84045f61fc1249076379dd0816d37499546`). Checkpoint E verified on exact head `1d003dc4d917c138a2c12f93c98b4a38be487754`. **Historical U26 context:** before PR #226, missing trusted O2 runtime configuration made the route fail closed with bounded `503`. **Current truth:** PR #226 wires the approved authority and its production-entrypoint runtime smoke proves configured `200` RSS while hostile query market noise cannot change the feed.**
- [x] **U27** #152 W4d + **variant-level portion of W5 only** — ProductGroup/variant Product+Offer after U12/U17; no `AggregateOffer`; own focused HTTP/structured-data verification; do not wait for U13. **Implemented**; `scripts/structured-data-http-smoke.ts` owns its real-HTTP evidence.
- [x] Before Merchant/index launch, prove feed vs JSON-LD identity/price/availability consistency. **Implemented by PR #214** (merged as `be7e5f628f86e71f8fc9769bed210501e15e03ed`, exact head `5fcb7a4cda5e1def6028b30abd3bb459cdd51f5e`), which proved the survivor's identity, exact U12 URL, ADR 0008 MPN and availability; **CLOSED by PR #216**, which added the missing discriminating promotion-aware **price** case that no earlier collapse-state test made. U27a had closed the availability divergence. `tests/domain/merchant-structured-data-parity.test.ts` proves variation identity, `item_group_id`/`productGroupID`, ADR 0008 MPN, exact U12 URL and exact promotion-aware price MATCH for variant-family states, that availability semantics and the publishable standalone set MATCH across the whole resolvable stock domain (no rows, zero, positive), and that unresolved-price/duplicate-MPN/composite/unaddressable candidates fail closed compatibly.

  **Approved one-survivor contract — implemented.** When filtering/exclusion leaves exactly one publishable standalone sibling, Merchant continues to publish that exact survivor and U27 emits a standalone `Product` representing the same survivor, using the same U12 variant deep-link and verified variant facts; U27 emits no one-member `ProductGroup`, and a product that started with exactly one option keeps the ordinary product-level fallback. Focused evidence: `tests/domain/merchant-structured-data-family-collapse.test.ts`, `tests/domain/merchant-structured-data-family-collapse-eligibility.test.ts`, and the survivor identity/promotion-aware-price cases in `tests/domain/merchant-structured-data-parity.test.ts`. See `docs/audits/merchant-jsonld-parity.md` and `docs/specs/la-clothing-owner-approved-facts-and-decisions.md`. **Closing this parity gate activates nothing**: Merchant activation still requires the remaining Gate M prerequisites.
- [ ] **U28** #153 T8 — exact saved GTM version/export/checksum; preview isolation; only then actual loader/CSP; live publishes the same reviewed version.

## Wave 6 — SEO/search follow-through

- [ ] **U29** #152 W2b — metadata cleanup after U4 uniqueness proof. **B5 enforcement is IMPLEMENTED at the admin publish path; the W2a database-level enforcement condition and the slug/path metadata cleanup itself remain OPEN.** *(The B5 owner decision was already resolved before this work; what landed here is its enforcement. **Pair semantics:** uniqueness is pair-level `(seoTitle, seoDescription)`, never either field alone — a shared title with a different description publishes, and so does a shared description with a different title. **Equality:** `normalizeMetadataText` in `src/seo/product-metadata-uniqueness.ts` is the one authority — Unicode NFC then `String.prototype.trim()`, matching the editor's own `parseTextField` and `hasText` presence reading. Deliberately **case-sensitive**, with no whitespace collapsing and no similarity scoring: B5 approves uniqueness of the pair, and a looser rule would refuse copy the owner never banned. Widening it is an owner decision. `findProductMetadataCollisions` now keys on the same helper, so the W2a evidence report and the publish gate cannot disagree. **Draft:** may be missing or duplicate and still saves; the editor renders a persistent, non-blocking collision warning naming the published product holding the pair — advice, not an alert, and it gates no control. **Publish:** both fields must carry text and the normalized pair must not be held by another **published** product; a draft holding the same pair is outside the domain and never blocks. Enforced server-side at the persistence boundary in `src/commerce/product-content-repository.ts` — `saveContent` re-checks rather than trusting its caller — for the single-product editor path and for bulk status, where a batch is refused whole if any member is incomplete, two members claim one pair, or a member collides outside the batch. Unpublishing carries no precondition. **Concurrency:** the read-then-write was reproduced under Read Committed (two transactions both saw a conflict-free catalog and both wrote), so every publish transaction takes one fixed `pg_advisory_xact_lock` before its check. **The application owns this invariant, not the database.** The protocol is cooperative: every write path shipped here joins it, so no admin action can produce a duplicate published pair, but the schema still carries no constraint on the normalized published pair and a writer outside the protocol — manual SQL, a data migration, a restore — still can. No unique index was added because nothing has ever constrained these columns, so the migration could fail on legacy duplicate published copy that no owner decision covers, and forcing it here would risk a failed production deploy. **W2a's exit path 1 asks for enforcement "in the database **and** in the admin publish path"; only the second is met.** Closing the first needs a constraint plus an owner decision about violating legacy rows, or an explicit owner/source-contract decision accepting application-level enforcement in its place — U29 asserts neither. **Discriminator retained** — `buildStorefrontProductMetadata` still appends the slug and `/shop/<slug>`, and none of it was touched. **Real-catalog verification of slug-free copy is PENDING**: no production database or Pancake credential was available in this execution context, no approved read-only collision audit script exists yet, and no result was invented. Removing the discriminator stays gated on **all** of: the W2a database-level enforcement condition; the fallback copy proven collision-free separately (untouched by U29 — two products sharing a non-unique `ProductMirror.name` with no published copy still collide); real-catalog evidence; and owning-source approval. Scorecard and reasoning: `docs/audits/seo-metadata-uniqueness-w2a.md`.)*
- [x] **U30** #152 P3 — W8 OG/Twitter, W10 static canonical, W14 branded/HTML 404 work in focused PRs. All four substates are merged and independently verified; the U30 integrated gate runs on `main` once W14b lands.
  - [x] **W8** root Open Graph/Twitter fallback. *(U30a — `src/seo/root-metadata.ts` + `src/seo/social-identity.ts`; the PDP card and the root fallback now share one brand identity, and the homepage is proved to serve the fallback in the metadata HTTP smoke. Social presentation only: no indexing policy, no canonical, and no relationship to Meta Pixel/CAPI.)*
  - [x] **W10** self-canonical for `/`, `/collections`, `/lookbook` when indexing is enabled. *(U30b — `src/seo/static-page-metadata.ts`. Withheld under noindex and on any query state, matching the existing `/shop` contract; the origin comes from `readSearchExposure()`, so a forged request `Host` cannot reach the canonical. `/shop`, `/collections/<slug>`, pagination, variant queries and PDP canonicals are untouched.)*
  - [x] **W14a** branded route-level HTML 404 with recovery navigation. *(U30c — `src/app/not-found.tsx`. An unmatched route keeps its 404 status and now answers with branded HTML and keyboard-operable recovery links to `/`, `/shop`, `/collections`, `/search`. No canonical, no indexing signal, and no invented support or contact destination.)*
  - [x] **W14b** unknown `/shop/<slug>` returns branded HTML 404 while current/historical slug lifecycle is unchanged. *(U30d — `src/proxy.ts` rewrites an unresolvable slug to the app's own not-found rendering instead of answering `text/plain`. Two assertions carry it: the response renders identical visible text to an unmatched route's 404, and W14a's recovery section is asserted inside `aria-labelledby="not-found-title"` so the site header cannot answer for it. CURRENT stays 200 and HISTORICAL stays an exact 301 to the site-owned path. Falling through to `/shop/[slug]` was measured to produce a soft 200 because `shop/loading.tsx` streams before `notFound()` runs; the rewrite also keeps the requested slug out of the response.)*
- [ ] **U31** #152 W9 — sitemap `lastModified` only after significant public-change timestamp semantics exist.
- [x] **U32** product-level remainder of #152 W5 + W6 — verified product-level identifiers/attributes + Organization only; **do not redefine ProductGroup/variant Offer owned by U27**. Both substates are delivered: U32a shipped the verified product-level identifiers and U32b the Organization enrichment from the resolved B2 facts. U27's ProductGroup/variant Offer topology was not touched by either. Substates below.
  - [x] **U32a** W5 product structured data — verified identifiers/attributes. *(`sku` — the website-owned `VariantMirror.sku`, Schema.org's merchant-specific identifier — is now published on the variant `Product` node it identifies, guarded by the same hardening as the MPN and omitted rather than emitted blank. ADR 0008 stays intact: `sku` is never substituted for `mpn`, and the MPN keeps its own authority. `mpn`, `color` and `size` were already published by U27 and were not reworked. **No GTIN**: `pancakeBarcode` has no proven upstream type, format, check digit or lifecycle, so no `gtin*` property is emitted — asserted structurally in unit tests and over real HTTP against a check-digit-valid EAN-13 seeded in the mirror. **No `itemCondition`**: ADR 0007 resolves condition as shop default + product override, but the PDP read does not load merchant facts, so emitting the default could contradict an owner override; reading them would add a per-PDP query into Merchant-owned data. Recorded as available but out of this slice. At U32a implementation time shipping/return facts were owner-blocked; the later owner reconciliation resolves B1/B4 but does not retroactively change this delivered slice. U27 ProductGroup/Offer topology, price, availability, variant URLs and Merchant parity were unchanged.)*
  - [x] **U32b** W6 Organization enrichment (`sameAs`, `contactPoint`, `address`) — **B2 RESOLVED and now implemented.** *(`PUBLIC_CONTACT_FACTS` in `src/content/public-brand-facts.ts` is the single authority for the approved §2 facts, transcribed and frozen: hotline/Zalo number, email, Fanpage URL, street address, locality and support hours. `buildSiteStructuredData` reads that constant — it copies no literal — so the one `Organization` node now carries `address` (`PostalAddress`), `contactPoint` (`ContactPoint` with `contactType: "customer support"`, telephone, email and an `OpeningHoursSpecification` covering all seven days) and `sameAs` (the Fanpage). Support hours keep the approved **UTC+7** offset inside the ISO 8601 time (`08:00:00+07:00`), so no consumer resolves them against its own timezone. **Entity consistency, not schema stuffing:** still exactly one `Organization`, still referenced by `WebSite.publisher` and by every product `brand` through `@id`; no second copy of the brand was created, and U27's ProductGroup/variant Offer topology, price, availability and Merchant parity were untouched. **Telephone spelling:** the owner approved `0923159666`, a national form with the trunk zero, while Google's Organization guidance asks `contactPoint.telephone` to carry the country code. Both spellings live in the authority (`telephone`, `telephoneInternational`); the calling code comes from **O2** — the owner decision that the country/market is Việt Nam — not from the address, and no subscriber digit changes. A test pins the international form against the repository's existing reviewed `normalizeVietnamesePhone` so a typo in either spelling fails rather than publishing an unreachable number; that function stays test-only, since collapsing free-text buyer input for hashing is a different contract from rendering a published identifier. The footer shows the owner's spelling and dials the international one. **Visible counterpart:** the site footer renders the same facts from the same constant — hotline (`tel:`), email (`mailto:`), address, support hours and the Fanpage link — so every fact marked up in JSON-LD is one a reader can actually see, on the same site-wide surface where that JSON-LD is injected. Support hours are stored as their parts (seven days, local open/close, the approved `UTC+7` offset) with `supportHoursSchemaTime` and `describePublicSupportHours` deriving the schema.org time and the reader's sentence from them, so the markup and the visible text cannot state different hours. **Deliberately omitted, each for a stated reason:** **`logo`** — B2 approved no brand mark, and `SOCIAL_FALLBACK_PATH` is a share card, so publishing it as a logo would misstate the asset; **`addressCountry`/`postalCode`** — the owner approved an address *string*, not a structured postal address, and deriving a country from a city name is an inference; **`availableLanguage`** — what language support answers in is a business capability, not something the site's served locale establishes; **Zalo URL** — the approved fact is one number reachable by phone and Zalo, and no profile URL exists in any source; **`legalName`/`taxID`** — **not** owner-blocked (B6 approves publishing the legal entity and the confirmed MST `0111242251`), simply **outside the B2 contact contract** U32b implements; they belong to the About/legal surface U33 builds. **`founder`/`foundingDate`** do remain unapproved under B6. The U32b guard test did not disappear when the block lifted, it moved: it pins the exact key set, ties every published value back to the fact authority instead of a repeated literal, and still asserts the absence of all of the above. The rendered contract is proved over real HTTP in `scripts/structured-data-http-smoke.ts`, which parses the JSON-LD out of the actual response. The Contact page remains U33's, and it must read this constant rather than re-transcribing the facts.)*
- [x] **U33** #152 P5/W13 — evergreen pages only from human-approved facts; no invented policies. **B1–B4 and B6 are RESOLVED; U33 is fully implemented — all five named pages (About, Contact, Returns, Shipping/Payment, Size Guide) are built from the shared fact authority.** **Current La.na A7b truth: A7b now publishes all eleven §33 policy topics from owner-approved authority; this does not retroactively widen U33a/U33c slice scope.** Split into focused PRs so each policy page's review and revert boundary is its own. Substates below.
  - [x] **U33a** W13 About + Contact, and the shared fact authority the rest of U33 reads. *(`src/content/public-brand-facts.ts` gains `PUBLIC_BRAND_POSITIONING` (§7, the owner's sentence verbatim) and `PUBLIC_LEGAL_FACTS` (§1 legal entity + confirmed MST `0111242251`, published under B6/§7), joining `PUBLIC_CONTACT_FACTS` from U32b. **Contact** renders the approved channels — hotline/Zalo, email, address, support hours, Fanpage — and **About** renders the positioning sentence plus the legal identity. Both read the authority; neither transcribes a fact a second time, so the pages, the footer and the `Organization` structured data cannot state different values. **Nothing invented:** About has no founding year, founder, brand story, mission or values, because B6 withholds all of them; Contact has no form, no live chat and no response-time promise, because no approved source states one. Browser tests assert the absence of each by pattern, so a later edit that writes an origin story into the page goes red. Both paths join `SELF_CANONICAL_STATIC_PATHS` and `STATIC_CANONICAL_PATHS`, so they are self-canonical when indexing is on and present in the sitemap; the W21 capacity pins moved from 4 static/49,996 dynamic to **6/49,994** deliberately — that pin exists so a new static path cannot silently widen the document. The canonical HTTP smoke now checks both paths over real HTTP. Footer links both. **Not in this slice:** Returns (U33b), Shipping/Payment (U33b), Size Guide (U33c). **Historical scope note:** At U33a merge time §15 policy surfaces — general terms, pricing, privacy, complaint handling, rights and obligations — had **no approved facts yet** and stayed unbuilt/unlinked; that blocker is now superseded by A7b, which publishes the owner-approved policy authority.)*
  - [x] **U33b** W13 Returns + Shipping/Payment from B1, B4 and §3. *(`PUBLIC_RETURNS_POLICY` and `PUBLIC_DELIVERY_FACTS` transcribe §4 and §5 into the same authority the earlier slices use. **One source per fact, and no new representation of an existing one:** the payment method, the no-account fact and the server re-verification sentence were already owned by `buildPublicBrandFacts` and rendered by the footer, so `/shipping` reuses that builder instead of restating them; the §3 refund channel lives in `PUBLIC_RETURNS_POLICY` because a way to receive money back is not a way to pay for an order. Facts that render as sentences are stored as sentences — `carrierTrackingNote`, `estimateCaveat`, `customerInitiatedShippingNote`, `shopFaultShippingNote`, `nonReturnableCategoriesNote` — rather than as booleans beside hard-coded copy, since a flag no rendering reads is how a fact changes while the page keeps saying the old thing. **The semantics travel with the numbers**: `describePublicReturnWindow` carries the day the window starts from and `describePublicRefundWindow` the event the refund clock starts at, because those are the halves a buyer argues about and a page holding them as prose could drift from §4 while the numeric fields still matched. The empty `nonReturnableCategories` is *consumed*, not just declared — the page renders the no-exclusion sentence from that state, so adding a category later stops the claim instead of leaving it standing falsely. `/shipping` likewise reuses `buildPublicBrandFacts().orderTracking` rather than retelling the tracking capability the footer already states. **Every clause is a member of a constant**, so `/returns` maps over the approved condition and supported-case arrays rather than restating them as prose — a page cannot grow a condition the owner never wrote, and a browser test walks the whole list, not a sample. `nonReturnableCategories` is an empty array rather than an absent key because §4 states there is no excluded-category list: that is a decision, not a gap. **The shipping price is deliberately not in the content module.** B4 keeps `readGuestShippingPolicy` as the pricing authority because production may legitimately override it, so `/shipping` reads the server-owned policy for the fee and free-shipping terms and the fact constant only for coverage, carriers, estimates, tracking and the verification call; a domain test asserts no price key leaked into `PUBLIC_DELIVERY_FACTS`. **Estimates stay estimates** — §5 says the windows are not a guaranteed SLA, so the page prints them as `dự kiến` and a test fails on `cam kết giao trong`/`đảm bảo giao` copy. The absence of carrier tracking is stated outright rather than left for a buyer to assume. **Payment lists exactly the method checkout supports** (COD): §3 forbids publishing transfer, card or wallet as a checkout method while the site does not support them, so bank transfer appears only as a refund channel, asserted both ways. Both paths join the canonical set and the sitemap — the W21 pins move to **8 static / 49,992 dynamic** — and the canonical HTTP smoke covers them. Footer links both. The evergreen navigation test now starts from `/about` instead of the homepage: the footer is site-wide so any page proves reachability, and the homepage additionally needs the catalog database, which the assertion does not test.)*
  - [x] **U33c** W13 Size Guide from B3 — the two approved charts, cm, circumference semantics, ±3 cm tolerance; height/weight stay guidance and must not become a fit guarantee. *(`PUBLIC_SIZE_GUIDE` in `src/content/public-brand-facts.ts` transcribes Contract B3/§6 into the same reviewed content authority: two approved charts (Chart A for relaxed apparel/elastic waist pants, Chart B for short sleeve shirts), sizes M–2XL, cm units, circumference semantics for chest/waist/hip, ±3 cm apparel tolerance (`describePublicSizeTolerance`), and reference guidance for height/weight. `/size-guide` renders directly from `PUBLIC_SIZE_GUIDE` via accessible semantic `<table>` elements with mobile scroll wrappers. **Nothing invented:** no size calculator, no recommendation engine, no fit guarantee copy (`đảm bảo vừa`, `chắc chắn vừa`), and no per-product measurement inferences. `/size-guide` joins `SELF_CANONICAL_STATIC_PATHS` and `STATIC_CANONICAL_PATHS` (W21 capacity pins updated to **9 static / 49,991 dynamic**), the site footer links to `/size-guide` with label `Bảng size`, and `search-exposure-http-smoke.ts` asserts the self-canonical status over HTTP. All five named evergreen pages were complete in U33. **Historical scope note:** At U33c merge time the remaining §15 policy surfaces remained unbuilt without approved facts; that blocker is now superseded by A7b.)*
- [x] **U34** #152 P6/W16/W17 — SEO admin/operational readiness; advisory UI does not become hard unreviewed policy. Both substates are merged and verified on an integrated head: U34a is advice the save path never reads, U34b is a read-only directory filter, and neither gained a publish gate or a completeness policy. Substates below.
  - [x] **U34a** W16 advisory SEO length guidance in the product editor. *(`src/commerce/seo-length-guidance.ts` holds the reviewed editorial/search-display guidance targets — 60 for `seoTitle`, 155 for `seoDescription` — and `SeoLengthField` counts towards them live. The readout is linked to its field by `aria-describedby` and is deliberately **not** a live region: the count changes on every keystroke, so announcing it would narrate every character. Advice only: the enforced bounds stay `PRODUCT_CONTENT_LIMITS` (500/2000), nothing is disabled or gated, and no publish gate exists. A domain test pins every advisory target strictly below its enforced bound so the advice cannot become a limit; the admin browser spec submits a **61-character title and a 156-character description** together through the real form and Server Action and asserts both persist exactly. The later B5 owner decision now defines pair-level publish uniqueness, but U34a itself remains advisory and does not implement that gate.)*
  - [x] **U34b** W17 SEO/editorial health filters (`missing-seo`, `missing-editorial`) — server-side bounded filter reusing the admin product listing/query authority, with an explicit query-param allowlist. No health score, no client-side load-all-and-filter. *(The audit names both filters and defines neither, so the semantics are taken from `src/commerce/catalog-acceptance.ts`, the only source that already owns both readings for the same fields. **`missing-seo`** = `seoTitle` OR `seoDescription` has no text, matching `missingPublishedSeo` and the editor's own SEO section, which owns exactly those two fields. **`missing-editorial`** = `editorialDescription` has no text, matching `missingPublishedEditorial`; `careInstructions` and `sizeGuide` sit in the same editor section but no source treats them as required — the PDP drops their notes section entirely when absent and neither reaches structured data — so including them would call products incomplete that the readiness contract calls complete. Neither predicate is gated on `PUBLISHED`: acceptance gates there because it measures what reaches the storefront, while these ask whether the copy exists at all, and publication is already the directory's own composable `status` dimension. "Missing" is acceptance's `hasText`, so `NULL`, `""` and whitespace-only all match; the SQL mirrors `String.prototype.trim()` through the existing `JS_TRIM_CLASS` rather than `BTRIM`, which strips ASCII blanks only, so a legacy NBSP-only row cannot read as present in the database while the editor's `parseTextField` reads it as blank. A product with no `ProductContent` row matches both, consistent with the directory's existing unedited-draft convention; no content row is created and no cleanup migration was added. Both values join the existing `health` **allowlist** parsed by `parseAdminProductDirectorySearchParams`, and both conditions join the existing `adminWhere`, so filtering stays **database-side before pagination** and one target still feeds both a chip's count and the page its link opens — asserted for every health key. `health` remains one selected dimension: the two replace each other rather than accumulating. No health score, no severity system, no publish gate, no persisted health column; U29 now owns the separate B5 pair-level publish gate.)*
- [ ] **U35** #152 P6/W18 — permanent-domain Search Console/Bing/Merchant verification; does not itself enable indexing.
- [x] **U36** #152 P6/W19 — **owner policy RESOLVED — ALLOW ALL crawler categories; IMPLEMENTED.** *(Owner decision approves ALLOW ALL across all four categories: traditional search discovery (`Googlebot`, `Bingbot`), user-triggered retrieval / AI search assistants (`OAI-SearchBot`, `ChatGPT-User`, `Claude-SearchBot`, `Claude-User`, `PerplexityBot`), foundation model training (`GPTBot`, `ClaudeBot`, `Google-Extended`, `CCBot`), and vendor-specific research (`GoogleOther`), plus wildcard `*`. Implemented in `src/seo/robots-policy.ts` via `APPROVED_CRAWLER_CATEGORIES` and `ALL_APPROVED_NAMED_CRAWLERS`. Invariant strictly enforced: allowing crawlers does NOT enable organic indexing. When `SEARCH_INDEXING_ENABLED` is false or on temporary domains, canonical sitemap is withheld while public HTML remains crawlable for observable `noindex` signals, and `/api` is disallowed for all crawlers. When indexing is enabled, canonical sitemap is advertised. Verified via unit/domain tests and live HTTP smoke tests against Next.js dev server. Detailed audit and documentation in `docs/audits/crawler-governance-w19.md`.)*
- [x] **U37** #152 P6/W21 — catalog URL-volume trigger before sitemap hard cliff; shard only when evidence warrants it. Capacity audit recorded in `docs/audits/sitemap-capacity-w21.md`. *(Contract verified from source: 4 static canonical paths + `MAX_DYNAMIC_SITEMAP_PATHS` = 50,000-URL single-sitemap budget. Production capacity audit executed on 2026-09-07 against production database at commit `6d2225c16b0b9578cbeea76e31d9b5fad5218f31`: 20 active/present products + 1 published collection = 21 dynamic URLs (0.042% dynamic utilization, 49,975 remaining headroom; `exceedsDynamicBudget = false`). D1 owner approved: `@nguyentuanson27-netizen`. D2 cadence approved: `Per release` (integrated into release preflight before indexing review). D3 trigger contract approved with **integer URL counts as authority**: Warning at 40,000 URLs (≈80.006% of the 49,996 dynamic budget) with `ALLOW_WITH_ACK`; Act at 45,000 URLs (≈90.007%) with `BLOCK`. Sharding action: **NO SHARDING NOW** — catalog uses < 0.1% of single-sitemap capacity and search indexing remains fail-closed. Closing U37 does not enable indexing; Gate S remains a separate human gate requiring a fresh activation-time audit on the exact activation head.)*
- [ ] **U38** #152 P7 — representative mobile/desktop runtime performance measurement after promotion/tag costs are materially present.

## Wave 7 — convergence, readiness and final operations

- [x] **U39** #151 G1 — prove monetary convergence for every currently enabled price-bearing consumer; verified in `tests/domain/monetary-convergence.test.ts` (PR #223). Disabled/fail-closed future consumers (Merchant 503, GTM disabled, search exposure withheld) remain non-blocking.
- [x] **U40** #151 G2 — bounded/redacted observability + readiness/runbook + rollback rehearsal for activation rejection, invalid/recovery/conflict/`PARTIALLY_INVALID`, `PRICE_CHANGED`/quote-proof, Merchant revision mismatch/rebuild, Pancake semantic validation and activation-gate state; no PII/secrets/raw quote proofs/cart UUIDs. Implemented in `src/operations/promotion-observability.ts`, `src/commerce/guest-checkout-submit.ts`, `docs/operations/promotion-rollback-runbook.md`, and verified via `tests/domain/promotion-observability-readiness-rollback.test.ts` and `tests/database/promotion-activation-service.test.ts` (PR #224).
- [ ] **U41** #153 M5 — after Gate M preconditions, execute Merchant Center Scheduled Fetch activation, account/site/data-source/market/shipping/returns/Ads linkage and collect Diagnostics/crawler evidence without implicitly enabling search indexing.
- [ ] **U42** #153 V1 — final marketing convergence/rollback verification after U28 + U41; code only for a focused verified launch defect.
- [x] **U43** #151 G3 — exact-head final integrated DoD after U39 + U40; verify **applicable #153 identity/cart/Purchase/Merchant-cache regressions for slices actually implemented** plus unchanged #152 indexing policy unless separately approved. Disabled/fail-closed future consumers are not prerequisites. Verified in `tests/domain/promotion-integrated-dod.test.ts` and documented in `docs/audits/promotion-integrated-dod-g3.md`.

## Conditional — not on default critical path

- [ ] **#152 W12** remains unscheduled unless target-market/consumer/search evidence justifies listing `ItemList`/`CollectionPage`.
- [ ] **#152 W20** `llms.txt` remains unscheduled for Google SEO/GEO; add only for a named non-Google consumer with owner-approved value.
- [ ] TikTok Events API remains future scope.
- [ ] Meta-to-GTM migration / Enhanced Conversions / customer PII remain out of scope.
- [ ] Composite Merchant offers remain out of v1.
- [ ] Coupons/stacking/BXGY/personalized promotion expansion remains out of #151 v1.

# Owner decision gates

These are **human decisions, not code work.** The owner decisions below are now current truth from
`docs/specs/la-clothing-owner-approved-facts-and-decisions.md`. Their resolution unblocks the named
implementation work but does not mark those units or launch gates complete.

| Gate | Current decision | Owner | Execution consequence | Guardrail |
|---|---|---|---|---|
| **B1** | **RESOLVED** — returns/exchanges within 15 days under approved conditions; customer-initiated change = 50,000 VND/product + two-way shipping; shop/manufacturer fault = LA Clothing pays reasonable shipping; refund 7–10 working days after inspection; no separate excluded-category list | Repository owner / brand authority | U33 Returns owner-unblocked | Implement only from normative facts; do not invent additional policy |
| **B2** | **RESOLVED** — phone/Zalo, email, registered/business address, support hours, Facebook Fanpage | Repository owner / brand authority | U33 Contact + U32b Organization owner-unblocked | Publish only approved contact/legal/social facts |
| **B3** | **RESOLVED** — two approved size charts; cm; circumference semantics; ±3 cm tolerance | Repository owner / brand authority | U33 Size Guide owner-unblocked | Do not derive extra measurements/fit claims |
| **B4** | **RESOLVED** — nationwide delivery; GHN/GHTK; 1–3 day inner-city / 3–15 day other-province estimates; no default carrier tracking; phone verification optional; current server shipping-price policy retained | Repository owner / brand authority | U33 Shipping/Payment owner-unblocked | Runtime/server shipping config remains pricing authority |
| **B5** | **RESOLVED** — pair-level `(seoTitle, seoDescription)` uniqueness among published products; drafts may be missing/duplicate; collision blocks publish | Repository owner / brand authority | U29 admin-publish-path enforcement implemented; W2a database-level enforcement and W2b slug/path cleanup still open | Do not remove slug/path discriminator until enforcement **and** real-catalog verification pass — the admin-publish-path half has landed; database-level enforcement, the fallback-copy proof and real-catalog verification have not |
| **B6** | **RESOLVED FOR MINIMAL ABOUT** — current positioning + legal entity/address/MST/contact may be public; founding year/founder/story/values remain unapproved | Repository owner / brand authority | U33 About owner-unblocked | Do not invent history/mission/values |

Historical W13A/W2a audit classifications remain evidence of the state when those audits were written;
the current owner-decision status above supersedes only their old owner-blocked wording.

## Owner/account gates from #153

- [x] **O1** Google Ads Purchase value: **merchandise-only**; exclude shipping and reuse authoritative immutable order merchandise value/canonical purchase facts.
- [x] **O2** Merchant market/language/currency: **Vietnam / `vi` / `VND`**. Owner decision is complete and PR #226 implements the reviewed trusted server-owned runtime authority; caller/request data cannot choose or override the configured market.
- [x] **O3** Apparel facts — **policy decision resolved by ADR 0007 and runtime implemented by U25/M3**: shop defaults `gender=male`, `age_group=adult`, `condition=new` with website-owned product overrides in `ProductMerchantFacts`. Persistence, server-authoritative validation, admin editing with explicit inheritance, effective-fact resolution, fail-closed `APPAREL_FACT_UNRESOLVED` and Pancake-resync preservation are implemented and tested. Merchant activation still requires the remaining Gate M prerequisites.
- [ ] **O4** GTM container, GA4 Measurement ID, Ads conversion ID/label and TikTok Pixel ID provided/reviewed by proper account owners.

# Separate launch gates

## Gate P — Promotion activation

- [ ] #151 P1–P10 accepted; price/catalog evidence + controlled Pancake custom-price acceptance green.
- [x] **U39/G1** covers every currently enabled monetary consumer; disabled/fail-closed future consumers do not block.
- [x] **U40/G2** readiness/rollback accepted and **U43/G3** exact-head DoD green.
- [ ] Human explicitly enables promotion activation.

## Gate T — GTM live

- [ ] T1–T8 through U28 green.
- [x] **O1** Ads Purchase value approved as merchandise-only.
- [ ] **O4** real vendor configuration approved.
- [ ] Exact immutable GTM version/export/checksum reviewed; preview proves zero production-destination traffic; same reviewed version is published live.
- [ ] If promotions are active, U39/G1 covers analytics/Ads/TikTok monetary paths before publish.

## Gate M — Merchant activation

- [ ] **Pre-activation:** M1–M4 through U9/U12/U25/U26 + exact variant URL + audited IDs/MPN + canonical pricing + cache/single-flight/backoff/topology proof green. U9 includes the attributable exact-SHA real-catalog rerun; supporting observations without immutable execution provenance do not satisfy this line.
- [x] **O2** market approved as Vietnam / `vi` / `VND`.
- [x] **O3** apparel-fact runtime implementation verified.
- [x] Trusted server-owned O2 runtime authority wired and verified; caller/request data cannot choose the market.
- [ ] Merchant site/account/shipping/returns prerequisites satisfied.
- [x] Feed↔JSON-LD one-survivor parity implementation + verification green under the approved contract. **Implementation PR #214, proof set completed by PR #216**; see `docs/audits/merchant-jsonld-parity.md`.
- [ ] If promotions are active, U39/G1 covers Merchant monetary/cache behavior.
- [ ] Human approves activation, then **U41 executes M5**; Gate M completes only after Scheduled Fetch + Diagnostics/crawler verification succeeds.
- [ ] Composite remains excluded.

## Gate S — Organic indexing

- [ ] Temporary-domain hard block green; permanent branded domain confirmed.
- [ ] Applicable #152 Required correctness/regression/operational gates green, including U13 where U5 identifies missing signals.
- [ ] Permanent-domain verification accepted.
- [ ] Human explicitly approves indexing on permanent domain; promotion/GTM/Merchant activation is not implicit approval.

## Final combined program gate

- [ ] If both GTM live and Merchant activation are part of the release, **U42/#153 V1** final marketing convergence/rollback evidence is green.
- [x] **U43/#151 G3** final promotion-integrated DoD is green for implemented scope.
- [ ] Intentionally disabled destinations remain explicitly disabled rather than silently treated as complete.

# Major checkpoint verification

Run only when applicable; never claim execution unless actually run:

```bash
pnpm test
pnpm test:db
pnpm typecheck
pnpm lint
pnpm build
pnpm prisma:validate
pnpm prisma:generate
pnpm release:check
```

- [ ] `pnpm pancake:catalog:audit` only in approved real-catalog context with sanitized evidence.
- [ ] `pnpm merchant:identity:audit` M1 operational closure only in approved real-catalog context; record exact committed SHA + clean/dirty state + sanitized counts.
- [x] Browser/runtime/a11y/SEO checks required by Checkpoint B are green on `main@649e04c328353c016e4ba41831b6eec7d49d1d54`; see `docs/audits/wave-2-checkpoint-b.md`.
- [ ] GTM/Merchant/Pancake external acceptance uses approved credentials/context only.

# Final program Definition of Done

- [ ] Implemented source-task acceptance criteria met.
- [ ] No duplicate pricing/cart/identity/variant-URL/Purchase/Merchant-cache/variant-schema authority.
- [ ] Focused regressions + relevant existing suites green; lint/typecheck/build green.
- [ ] Applicable DB/runtime/browser/a11y verification green.
- [ ] Security review covers authz, untrusted input, quote proof, Merchant public route, serialization, GTM/CSP/secrets and PII.
- [ ] Migration/backward compatibility/rollback + observability reviewed.
- [ ] Docs describe current truth; no unrelated refactor/dead code/debug output.
- [ ] Launch gates remain independent with explicit owner/rollback trigger.
- [ ] Human final review: **0 Critical / 0 Required**.