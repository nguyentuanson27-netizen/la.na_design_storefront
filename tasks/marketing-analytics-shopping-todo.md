# Marketing analytics & Google Shopping — task checklist

**Meta amendment (2026-10-07, PR #110):** [ADR 0015](../docs/decisions/0015-direct-meta-capi.md) governs the direct five-event Pixel/CAPI contract, signed shared IDs, committed positive cart deltas, persisted verified PDP provenance, reconciliation Purchase and bounded attribution retention. This extends the implementation; it does not activate Meta accounts or change Catalog ID semantics. [Audit/tests](../docs/audits/meta-ads-2026-10-07.md).

Status: **PR-A (T1–T3), T4, T5, T6, M2, T7 (U24 / PR #193), M1 (PR #175 + PR #194 + operational closure), M3 (U25), and M4 (U26 / PR #198) IMPLEMENTED; Checkpoint D PASSED and Checkpoint E PASSED. U27a closed the availability divergence; **PR #214 implemented the approved Merchant↔JSON-LD one-survivor convergence contract and PR #216 completed its proof set, closing the feed↔JSON-LD convergence gate as of #216**. O1 is resolved as merchandise-only and O2 is resolved as Vietnam / `vi` / `VND`; PR #226 (`403671ec5d0bff890a8d69fd26626df03d7ad7dc`) wired and verified the trusted server-owned O2 runtime authority, so the public Merchant route now serves the configured feed while activation remains blocked on the remaining M5/Gate M operations. T8 remains blocked on O4, M5 operational activation is not complete, and V1 remains proposed.**

Delivered slices: **T1–T3** (U2, PR #157 — still loads no GTM in any mode), **T4** (U8, PR #164 resolved cart lines
+ PR #165 product/option facts), **T5/T6** (U18/U19, PR #186), **M2** (U12, PR #180), **T7** (U24, PR #193 canonical confirmed Purchase), and **M1** (U9, PR #175 durability + PR #194 identity/MPN/media read-only closure + exact-SHA operational closure audit). Checkpoint D is **GREEN / PASSED**. T4 evidence is in `docs/audits/wave-1-checkpoint-a.md`; integrated U12–U19 evidence is in `docs/audits/wave-2-checkpoint-b.md`; M1/Checkpoint D evidence is in `docs/audits/merchant-identity-m1.md` and MPN ownership/lifecycle is recorded in ADR 0008.

T8 and V1 are **not** implemented. M5 operational activation is **not complete**; its trusted-market runtime prerequisite landed in PR #226. No GTM loader exists: T8 still owns the first actual GTM load and CSP opening. **M3 (U25) is implemented** as the standalone Merchant mapper/O3 runtime, and **M4 (U26 / PR #198) adds the bounded public delivery layer**: GET `/feeds/google-merchant`, RSS serialization, whole-generation query/offer/byte envelopes, complete-success cache, process-local single-flight, and fixed-key failure backoff. **PR #226 implements the reviewed trusted server-owned O2 runtime authority for Vietnam / `vi` / `VND`; the real production-entrypoint runtime smoke returns configured `200` RSS and proves hostile query market values cannot override the feed. Missing, malformed or unapproved server configuration still fails closed.** M3/M4 accept no caller/request market authority.

Source spec: `docs/specs/marketing-analytics-shopping.md`

PR #153 itself is docs-only; runtime work lands in the focused PRs below. T1–T7, M1, M2, M3 and M4 are implemented on their focused branches/PRs; **Checkpoint D is passed and Checkpoint E is PASSED on PR #198's exact head `1d003dc4d917c138a2c12f93c98b4a38be487754`.** Current owner decisions are reconciled by `docs/specs/la-clothing-owner-approved-facts-and-decisions.md` and do not retroactively mark runtime/configuration work complete.

## Owner/account gates

- [x] **O1 Google Ads value:** **merchandise-only**. Google Ads Purchase must reuse authoritative immutable order merchandise value/canonical purchase facts and exclude shipping.
- [x] **O2 Merchant market:** **Vietnam / `vi` / `VND`**. Owner decision is complete and PR #226 implements the reviewed trusted server-owned runtime authority; caller/request data may never convert syntax-valid values into approval or override the configured market.
- [x] **O3 Apparel facts — policy decision resolved by ADR 0007, runtime implemented by U25/M3:** Merchant v1 shop defaults are `gender=male`, `age_group=adult`, `condition=new`; standalone products override each fact independently through the website-owned `ProductMerchantFacts` table. Persistence, server-authoritative allowlist validation, admin editing with an explicit inheritance state, effective-fact resolution and fail-closed `APPAREL_FACT_UNRESOLVED` behaviour are implemented and covered by tests, including a Pancake-resync preservation regression. Merchant activation still requires the remaining Gate M prerequisites.
- [ ] **O4 Vendor config:** provide/review GTM container, GA4 Measurement ID, Google Ads conversion ID/label, TikTok Pixel ID.

## Review-resolution gates

### Review `5061555088`
- [ ] **R1 Preview isolation:** production destination tags require `la_tracking_mode=live`; preview never relies on Tag Assistant as a sandbox.
- [x] **R2 Atomic cart deltas:** update/remove transaction returns committed old/new/removed quantities from inside the cart lock. *(Delivered T6 / PR #186.)*
- [x] **R3 Merchant composite:** composite Merchant offers are deferred in v1 and standalone IDs have accepted durability evidence. *(Satisfied by M1 / PR #175 + PR #194 + exact-SHA operational closure.)*
- [x] **R4 Merchant envelope:** max 5,000 offers, 16 MiB, ≤8 DB round trips; overflow never partial `200`. *(Implemented U26 / PR #198; Checkpoint E verified below on the exact head.)*

### Review `5062244480`
- [ ] **R5 GTM live interlock:** PR-A contains **no GTM loader**. Requested preview/live stay operationally disabled until T8 has an exact saved GTM version + reviewed export. PR-C owns first GTM script/CSP opening.
- [x] **R6 Server-truth AddToCart:** successful server purchase action returns canonical bounded item facts from the same authorized selection committed to cart; browser does not use stale pre-request price. *(Delivered T5 / PR #186.)*
- [x] **R7 Product vs variant identity:** list/select/initial unselected PDP use product-level `pancakeProductId`; exact variant `pancakeVariationId` begins only when a concrete variant is selected/committed. Price ranges are never reported as an exact selected price. *(Delivered T5 / PR #186.)*
- [x] **R8 Feed amplification:** complete successful Merchant feed is cached for 300s under a fixed bounded key; concurrent cold requests are single-flight for current one-app-service topology; byte counting is incremental; repeated GETs within TTL do not re-run heavy DB generation. Multi-replica deployment requires shared cross-replica protection before activation. *(Implemented U26 / PR #198.)*

### Review `5062693858`
- [x] **R9 PDP atomic add semantics:** PDP “Thêm vào giỏ hàng” uses a distinct server mutation that atomically increments the existing line by exactly `+1` under the cart lock; it must not reuse absolute `setItemQuantity(..., 1)` semantics. Success returns `previousQuantity`, committed `quantity`, and `addedQuantity=1`; no successful no-op/decrease may be reported as `add_to_cart`. *(Delivered T5 / PR #186.)*
- [x] **R10 Mutation event snapshot:** PDP add, cart absolute update, and remove return a bounded non-PII `CommerceVariantItem` snapshot captured/resolved server-side at the accepted mutation truth point under the same serialized cart transaction. It includes `pancakeVariationId`, authoritative resolved `unitPriceVnd`, item name, color/size where available, and the relevant committed delta quantity. Any pre-transaction availability check is advisory only; accepted absolute update must revalidate current eligibility/stock under the serialized mutation. If a safe snapshot cannot be resolved, the commerce mutation remains authoritative but analytics fails closed with no stale client fallback. *(Delivered T5/T6 / PR #186.)*
- [x] **R11 Merchant failure backoff:** a failed/overflow heavy rebuild installs a fixed-key negative backoff sentinel for `MERCHANT_FEED_FAILURE_BACKOFF_SECONDS=60`. Sequential or concurrent requests during backoff return a cheap bounded `503` (with bounded `Retry-After`) and do not invoke heavy generation. Failure state never overwrites/poisons a valid successful feed cache entry. *(Implemented U26 / PR #198.)*

### Review `5062818394`
- [x] **R12 Canonical cart/checkout analytics projection:** propagate `pancakeVariationId` through canonical resolved cart facts used by cart/checkout (or one dedicated equivalent projection). `view_cart` and `begin_checkout` are **all-or-nothing**: if any non-empty line lacks safe external variant identity, authoritative price, positive quantity, or item name, suppress the whole event. Never substitute local `VariantMirror.id`, never drop only the unsafe line, and never report a partial merchandise total. *(Delivered T6 / PR #186.)*

## PR-A — tracking preparation; zero new GTM/vendor network delivery

### T1 Canonical event/dataLayer contracts
- [x] Define `CommerceProductImpression` separately from selected `CommerceVariantItem`.
- [x] Product impression supports product external ID + exact/min/max price without requiring a fake variant.
- [x] Selected variant item requires `pancakeVariationId`, exact unit price, quantity.
- [x] Typed Purchase/event facts contain no customer PII.
- [x] Reset ecommerce state before every ecommerce push.
- [x] Tracking publisher is fail-safe and never replaces initialized `window.dataLayer`.
- [x] RED/GREEN tests cover product-vs-variant identity, sequential-event isolation, malformed/unavailable tracking.

### T2 Desired tracking mode/config + CSP interlock
- [x] Parse/validate desired `disabled | preview | live` + future GTM container ID.
- [x] `live` is deployment-owned; no Host/query/client activation.
- [x] Before T8, both requested `preview` and requested `live` resolve to **no GTM load**.
- [x] PR-A opens no new Google/TikTok CSP origins and adds no production `unsafe-eval`/wildcard.
- [x] Update env examples and focused config/CSP tests.

### T3 dataLayer + consent + page-view preparation; still no GTM loader
- [x] Initialize/queue `dataLayer` and immutable `la_tracking_mode` fact.
- [x] Queue current Google consent default before eventual measurement.
- [x] Emit exactly one application-owned initial/App Router `page_view` into dataLayer.
- [x] Preserve existing direct Meta mount.
- [x] Assert no GTM script/iframe/network loader exists in PR-A.

### Checkpoint A
- [x] Focused tests green.
- [x] `pnpm typecheck` green.
- [x] `pnpm lint` green.
- [x] Security review proves PR-A cannot load GTM in any mode and adds no new third-party network path.

## PR-B — commerce browser events

### T4 Product + selected-variant projection facts
- [x] Expose stable `pancakeProductId` on list/PDP product facts.
- [x] Propagate `pancakeVariationId` + optional SKU through concrete standalone/composite options and server cart mutation lookup facts.
- [x] Extend canonical resolved cart/checkout line facts with `pancakeVariationId` for every analytics-safe line; composite component lines use the actual purchased component variation ID, not parent/presentation identity.
- [x] Keep local `VariantMirror.id` as mutation/authorization identity only; it must never be mapped as vendor `item_id` fallback.
- [x] Presentation `kindKey` never becomes external identity.
- [x] Existing price/stock/composite privacy behavior unchanged.
- [x] RED/GREEN projection tests cover standalone cart line, composite component cart line, and unresolvable/private line without fabricating external identity.

### T5 Product-level list/PDP/select + atomic server-authoritative AddToCart
- [x] `view_item_list` emits exactly one product impression per visible card.
- [x] `select_item` uses clicked product identity even though no size/color is selected yet.
- [x] Initial unselected `view_item` uses product identity.
- [x] Equal resolved product price may map as exact price; multi-price range does **not** map minimum as selected exact price; unresolved price omits monetary fields.
- [x] Introduce a dedicated PDP atomic add mutation; do not call the cart’s absolute set-quantity path with `quantity=1`.
- [x] Under the existing cart lock, absent line → `0→1`; existing quantity `q` → `q→q+1`, subject to current stock/integer bounds. Each successful repeated/concurrent PDP add against the same live cart identity contributes exactly one committed unit.
- [x] Successful PDP add returns `previousQuantity`, committed `quantity`, `addedQuantity=1`, plus bounded canonical item snapshot from the same accepted transaction.
- [x] `add_to_cart.quantity = addedQuantity`; a no-op/decrease/failure can never emit PDP `add_to_cart`.
- [x] AddToCart event uses server-returned `pancakeVariationId`, `unitPriceVnd`, item name/color/size and accepted delta; never stale `selection.selectedPrice` or rendered cart data.
- [x] Direct Meta event name/content IDs/direct-delivery/success boundary remain compatible; any Meta value-source correction has regression coverage.
- [x] RED/GREEN tests: absent→1, existing 1→2, existing >1 increments rather than resetting, stock-bound failure, concurrent repeated PDP clicks against the same live cart identity, stale browser price vs current server snapshot, failed snapshot → no canonical tracking, no duplicate Meta behavior.

### T6 Atomic cart delta + authoritative mutation snapshot + checkout events
- [x] Any `canSetQuantity`/rendered pre-check outside the mutation is advisory only; re-resolve current commerce eligibility and requested-quantity stock sufficiency inside the serialized mutation before accepting an absolute update.
- [x] Under existing cart lock, update returns `previousQuantity` + committed `quantity`.
- [x] Under the same lock, remove captures `removedQuantity` before destructive delete; already-missing line is not a real removal.
- [x] The transaction also captures/resolves bounded non-PII event item facts: `pancakeVariationId`, authoritative `unitPriceVnd`, product/item name, color/size where available, plus optional safe product/projection context.
- [x] Increase → delta `add_to_cart`; decrease/remove → delta `remove_from_cart`; zero delta/failure → no event.
- [x] Browser builds quantity events only from the returned server snapshot + delta. It never falls back to server-rendered/client-cached name, price, variant ID, or quantity after a mutation.
- [x] If safe identity/price snapshot resolution fails, cart mutation result remains commerce truth but tracking emits nothing and must not throw into cart UX.
- [x] Build one pure canonical cart analytics projection from current resolved cart facts. It succeeds only when **every** non-empty line has safe `pancakeVariationId`, authoritative non-negative unit price, positive integer quantity, and item name; otherwise it returns unavailable without a partial items array.
- [x] `view_cart` and `begin_checkout` use only that complete projection. Event merchandise `value` is the sum of `unitPriceVnd × quantity` across the exact full emitted line set. If projection is unavailable, suppress the whole event; do not drop unsafe lines or recalculate/report a partial total.
- [x] `view_cart` may emit only from current cart truth. `begin_checkout` may emit only after the existing checkout commerce-validity gates pass; analytics projection failure never blocks cart/checkout UI.
- [x] Local CUID/`VariantMirror.id` is forbidden as GA4/Ads/TikTok item identity fallback.
- [x] RED/GREEN mutation tests: two absolute updates, remove/already-removed, same quantity, failed mutation; price/catalog/stock change between render/pre-check and mutation; full remove snapshot captured before delete; enrichment disappearance/snapshot failure → no stale event.
- [x] RED/GREEN cart/checkout projection tests: all-safe standalone lines → complete `view_cart`; all-safe composite component line → real component `pancakeVariationId`; multiple safe lines → full item set and exact full merchandise sum; one safe + one unresolvable/private/missing-external-ID line → **no whole `view_cart`** and **no `begin_checkout` tracking event**; no partial totals.
- [x] Keep `add_shipping_info` / `add_payment_info` absent until a real accepted milestone exists.

### Checkpoint B
- [x] Focused cart/PDP/checkout tests green.
- [x] `pnpm test`, `pnpm typecheck`, `pnpm lint` green.
- [x] Review product-vs-variant IDs, canonical cart/checkout external identity, exact full-cart values, committed delta, server snapshot and all-or-nothing failure-closed tracking semantics.

This is the PR-B tracking checkpoint. The separate growth-commerce storefront Checkpoint B covering U12–U17 has also now passed on `main@649e04c328353c016e4ba41831b6eec7d49d1d54`; see `docs/audits/wave-2-checkpoint-b.md`.

## PR-C — confirmed Purchase + immutable GTM activation

### T7 Canonical confirmed Purchase
- [x] Purchase only for `OrderMirror.state === CONFIRMED`. *(Evidenced via Regression A in `canonical-purchase-snapshot.test.ts` & `canonical-confirmed-purchase.test.ts`)*
- [x] `transaction_id = event_id = publicCode`. *(Evidenced via Regression E & live acceptance report on order #23258)*
- [x] Immutable item quantity/price/variation identity from `OrderLineSnapshot`; mutable enrichment optional. *(Evidenced via Regressions B, C, D)*
- [x] Refresh/revisit keeps same ID; tracking failure cannot affect checkout success. *(Evidenced via Regressions E & F)*
- [x] Existing Meta Pixel+CAPI dedup remains healthy. *(Evidenced via Regression G & `meta-purchase-reporting.test.ts`)*

### T8 Exact GTM saved version + loader/CSP + destination mapping

**Status: BLOCKED on owner gate O4 and GTM account access.** One slice has landed — the static audit
that every later step is gated on (`src/tracking/gtm-container-audit.ts`, 128 cases in
`tests/domain/gtm-container-audit.test.ts`). It is fail-closed by construction: a malformed export,
an export format version it was not written against, a field whose type does not match the schema
or a collection entry that is not an object, a `triggerId`, tag `name` or variable `name` that is
missing, unusable or declared twice, a tag-sequencing edge naming no tag in the version, a parameter
row declaring one cell key twice (a reference must identify exactly one node, and a row that says
two things about one key says nothing about it, before either can prove anything), a `firingTriggerId` entry that is not a non-empty string, a `usageContext` entry it
cannot read (shape and graph identity are both established before anything is read for meaning, so
malformed data cannot become ignored data), a container that does not prove it is a
`web` container, a version that disagrees with its own nested container about which container it is,
a deleted container version, a top-level
`containerVersion` field it does not account for — matched by exact schema name, so an unknown
field refuses whatever it holds and a future scalar flag cannot pass as harmless metadata — a
populated `zone`, `gtagConfig`, `client` or `transformation`, a tag type it has no reviewed parser
for, a
`la_tracking_mode` variable that is not a single Data Layer Variable reading that exact dataLayer
key, a delivering tag that takes part in tag sequencing, a dangling trigger reference, a tag whose
firing paths are not *all* live-guarded, a Meta payload
nested anywhere in the parameters or reached through a variable, a Google configuration tag that
does not prove `send_page_view` is false, a destination id that is unapproved, unresolvable, or
carried on a field its tag type does not deliver through, a Google Ads conversion whose
`(id, label)` pair is not approved as a pair, an export from another container, or an empty approval
set all refuse the container. It refuses a workspace export that names no saved version, so a
mutable container cannot be certified.

**Blocker this raised — the TikTok GTM tag needs a parser bound to that exact template.** The audit
certifies only tag types whose vendor the type itself fixes (Google's built-ins). A Custom HTML tag
is refused because its payload is arbitrary script. A gallery template is refused for a different
reason, and the distinction matters: the saved version *does* carry the template — `customTemplate[]`
holds each one's `templateData`, and a gallery template also carries a `galleryReference` naming its
owner, repository, version and signature. What is missing is not the code but the review. The audit
has no parser bound to any specific template, so it cannot say which of a template's parameters names
a destination, and a live firing guard says when a tag fires but nothing about where it sends.
TikTok's GTM tag is a gallery template, so it does not pass the gate as the audit stands.

Under the locked v1 contract — plan §3.7 and spec, *TikTok Pixel runs through GTM* — the valid path
is a parser bound to that exact TikTok template, identified from a **real saved export**: review its
`galleryReference` and a checksum over its `templateData` first, then write the mapping for Pixel ID
and event fields. The `cvt_*` type-to-template mapping must not be guessed from a fixture or a
secondary source. Delivering TikTok outside GTM is **not** an option available at this level: it
would be an architecture change requiring an explicit, separately approved spec and plan amendment,
not a choice this checklist can open.

Nothing else in T8 may proceed: with no container id, GA4/Ads/TikTok ids (O4) and no Tag Manager
access, there is no container to configure, no immutable version to save, and no export to checksum.
Per the interlock below, the loader and CSP origins must not land without that artifact, so
`REVIEWED_GTM_VERSION_AVAILABLE` stays `false` and every mode still resolves to no GTM load.

**The durable blocker is the normative gate: O4 is OPEN.** Nothing below may be satisfied with a
guessed, fixture or dummy production ID, and only the proper account owners can close it.

*Dated observation — 2026-09-07 preflight on `main@be7e5f628f86e71f8fc9769bed210501e15e03ed`.* Scoped
to the execution context used for that preflight, and evidence of that context only, not of
project-wide account state: no GTM container ID, GA4 Measurement ID, Google Ads conversion ID/label
or TikTok Pixel ID was present in the repository or the environment, and that context had no Google
Tag Manager, Tag Assistant or GA4 DebugView access. `.env.example` carries only the documented
`GTM-XXXXXXX` placeholder, which is a placeholder and not an approved ID. `pnpm release:check` was
executed in that context and reported `trackingMode=disabled`,
`trackingLoadsGoogleTagManager=false`. Consequence for T8 while O4 stays open: no container version
can be saved, no export can be checksummed, and no TikTok `customTemplate[]` / `galleryReference`
can be identified from a real artifact.

- [ ] Configure GTM workspace, then **create/save immutable container version before final review**.
- [ ] Record GTM container ID + exact saved container version number/ID.
- [ ] Export JSON from that exact saved version and commit it with repository identity/checksum.
- [ ] Static assertion proves every production GA4/Ads/TikTok tag has explicit `la_tracking_mode == live` firing guard. *(Audit implemented and unit-proved against fixtures; it has no real export to run against until O4 and GTM access land, so the assertion is not yet made about a production artifact.)*
- [ ] GA4 auto/history page views disabled under app-owned page-view strategy.
- [ ] Google Ads Purchase uses **O1 merchandise-only value** + `publicCode` + conversion-linking functionality; no Enhanced Conversions.
- [ ] TikTok Purchase/CompletePayment uses `event_id=publicCode`.
- [ ] Preview/test tags use isolated debug/test destinations only.
- [ ] Only after static audit passes: add actual GTM loader and required least-privilege CSP origins; enable app preview for that exact saved version.
- [ ] Tag Assistant previews that exact saved version, not a mutable unversioned workspace.
- [ ] Live publish publishes the same reviewed saved version and records published version ID.
- [ ] Any later console edit requires new version + export + review before publish.

### Checkpoint C — tracking activation readiness
- [ ] Exact GTM version/export/checksum recorded.
- [ ] Tag Assistant proves preview sends zero traffic to production destinations.
- [ ] GA4 DebugView/test destination proves expected ecommerce + exactly one page view per navigation.
- [ ] Ads/TikTok diagnostics prove transaction/event IDs and no supported duplicate reporting.
- [ ] Existing direct Meta remains healthy.

## PR-D — Merchant identity + standalone deep link

### M1 Merchant read-only identity/durability audit
- [x] Audit implementation validates `pancakeVariationId` and standalone `pancakeProductId` against current Merchant format/length limits. Recorded observation: 149/149 variations and 35/35 products within 50 characters; current values contained no rejected invalid Unicode. LA Clothing rejects whitespace rather than relying on Google normalization.
- [x] Prove external-ID durability by provider contract, controlled repeated full-catalog resync evidence + repository reconciliation tests, or equivalent approved history. **PROVEN via §3.3 Option B.** A controlled experiment on production product `a132` (`scripts/pancake-m1-durability-experiment.ts`) with independent owner-controlled cryptographic markers at the raw Pancake API boundary proved that the same upstream product and variations retain the exact same `pancakeProductId` and `pancakeVariationId` across controlled reversible mutations and repeated full-catalog observations, with zero remap and verified restoration; combined with repository reconciliation tests (`tests/database/merchant-identity-audit.test.ts`). Recorded in `docs/audits/merchant-identity-m1.md`.
- [x] Audit implementation covers manufacturer MPN presence/uniqueness/stability. **Authority is ADR 0008:** owner-confirmed manufacturer SKU/MPN is Pancake variation `display_id`, mirrored in `VariantMirror.pancakeDisplayId` and audited directly; website-owned `VariantMirror.sku` remains preserved and is not an MPN fallback. Recorded full-catalog observation: 149/149 PRESENT, 0 MISSING/BLANK/UNTRIMMED/TOO_LONG/INVALID_FORMAT, 0 duplicates. Immediate T0–T2 reads provide 356/356 consistency; lifecycle stability is supported separately by the time-separated `a132` evidence from PR #175 (2026-09-02 exact restore) to PR #194 (2026-09-04 same `A132-*` values on the same variation IDs). Intentional owner reassignment is an explicit metadata change, not offer-identity remapping.
- [x] Every composite projection becomes `COMPOSITE_DEFERRED` in v1. Recorded observation: 116 composite records classified `COMPOSITE_DEFERRED`, 0 leak into standalone set.
- [x] Audit price/media/content/apparel **runtime readiness at the exact pre-U25 operational SHA** with bounded non-PII diagnostics. Authoritative post-fix observation: Media 149/149 READY with storefront product-level parity; the **post-query copied candidate list** is bounded by the shared 100-candidate limit while raw Prisma JSON materialization occurs earlier. Price 149/149 READY; Availability 77 IN_STOCK, 71 OUT_OF_STOCK, 1 AVAILABILITY_UNRESOLVED reported PARTIAL / NOT READY; Content 0 published, 149 draft/missing; Apparel policy RESOLVED, runtime BLOCKED **at that historical SHA before U25/M3 landed**. The current executable M1 summary now reports U25 overrides `IMPLEMENTED` with verdict `NOT_AUDITED_BY_M1` instead of rewriting that historical evidence.
- [x] **Operational closure evidence:** executed `npm run merchant:identity:audit` on the production mirror on exact committed post-fix SHA `84c99db3de6757c3ded4396644eb4dae25869e09` (tree `ac2e395edafaf5acc83fe98c632145ef7b084aa3`) at `2026-09-04T18:43:31.120Z` with verified CLEAN worktree state. Refreshed counts: 149/149 valid variation IDs, 35/35 valid product IDs, 149/149 manufacturer MPNs present/valid/unique (`mpnReady = true`), 116 composite deferred, 149/149 media ready, 149/149 price ready. Recorded in `docs/audits/merchant-identity-m1.md`.

### M2 Standalone variant deep link + canonical/query contract
*(Delivered via U12 / PR #180, merged.)*
- [x] Implement `/shop/<slug>?variant=<pancakeVariationId>` only for valid current standalone options.
- [x] Exact selected price/color/size/image matches the authorized current option projection used by downstream feed facts.
- [x] Stale/forged/inactive/private/composite query cannot expose/select unauthorized option.
- [x] Base PDP remains organic canonical; variant query does not create independent indexing policy.
- [x] Regression aligns with merged SEO/GEO audit W4 dependency order; browser coverage includes `variant-deep-link.spec.ts`.

### Checkpoint D
- [x] Real-catalog identity/MPN/durability audit green for every intended standalone launch record **on an attributable exact committed post-fix SHA** (`84c99db3de6757c3ded4396644eb4dae25869e09`).
- [x] Standalone deep-link contract and representative variant addressability regressions are green via U12/M2.
- [x] Composite products intentionally absent, not silently regrouped (`COMPOSITE_DEFERRED: 116`).

## PR-E — Merchant feed

### M3 Standalone Merchant mapper
*(Implemented on the U25 branch; `src/commerce/merchant-offer-mapper.ts` + `merchant-offer-repository.ts` + `merchant-apparel-facts.ts` + `product-merchant-facts-{admin,repository}.ts`. O2 owner decision and the trusted runtime authority are now both implemented; PR #226 wires the trusted server configuration.)*
- [x] Stable audited ID/grouping, `brand=LA Clothing`, audited MPN from `VariantMirror.pancakeDisplayId` per ADR 0008, no inferred GTIN. `VariantMirror.sku` and `pancakeBarcode` are not selected by the loader at all, so neither can become an MPN fallback or a GTIN.
- [x] Add local website-owned product-level O3 override persistence and server-authoritative validation for the reviewed Merchant enums; Pancake sync cannot erase overrides. New `ProductMerchantFacts` table plus `MerchantGender` / `MerchantAgeGroup` / `MerchantCondition` database enums; catalog sync writes only `ProductMirror` / `VariantMirror`, proved by a resync regression.
- [x] Add product admin editing with an explicit “use shop default” state; clearing an override returns to inheritance rather than copying the current default. Clearing every fact deletes the row.
- [x] Resolve effective apparel facts as `explicit product override → ADR 0007 shop default`; never infer from product name/category/description/size/model output. The resolver takes overrides and nothing else.
- [x] Map canonical price, availability, trusted image, description, exact deep link, color/size, current required variant fields and effective O3 values. Price is the shared promotional storefront rule, availability is the M1 Merchant classifier, media is the trusted storefront resolver, and the landing URL is built **and proved** with U12's own `resolveDeepLinkedVariantSelection`.
- [x] Enforce current Merchant apparel bounds fail-closed: title ≤150 code points, description ≤5,000, required color/size ≤100 each, XML-safe; missing/blank/untrimmed/malformed/overlong color or size is excluded rather than omitted/repaired.
- [x] Structurally valid zero-stock offers remain `out_of_stock`.
- [x] Malformed/unavailable apparel policy or overrides exclude the offer with a bounded `APPAREL_FACT_UNRESOLVED`-class reason; unsafe/unresolved/composite records remain excluded with bounded reasons in one fixed diagnostic order.
- [x] RED/GREEN tests cover inherited defaults, each independent override, mixed overrides, clearing back to inheritance, invalid values, Pancake resync preservation, fail-closed unresolved apparel facts, and exact Merchant text/apparel boundaries.
- [x] **O2 owner decision and trusted runtime implementation are both resolved without becoming caller-controlled configuration.** Approved market is Vietnam / `vi` / `VND`; PR #226 resolves the production mapper from the reviewed server-owned environment, while missing/malformed/unapproved server configuration remains `MERCHANT_MARKET_UNRESOLVED`. The mapper accepts no market argument and caller-supplied extra market properties cannot approve or override it.
- [x] Current executable `MerchantIdentitySummary.apparelFacts` reports `productOverrides: IMPLEMENTED` with `verdict: NOT_AUDITED_BY_M1`; the historical exact-SHA `docs/audits/merchant-identity-m1.md` remains unchanged evidence of the pre-U25 state.
- [x] U26 keeps the same M3 mapping authorities while replacing the public-feed loader's catalog-size-dependent promotion batching with flat bounded reads. Generic storefront/cart promotion candidate batching remains unchanged; the feed path is now independently covered by the stricter R4/M4 ≤8 whole-generation query envelope.

### M4 Cached/single-flight serializer + bounded public route + failure backoff
*(Implemented on U26 / PR #198; PR #226 now wires the trusted O2 runtime authority. Under approved server configuration the runtime route returns `200` RSS; missing/malformed/unapproved configuration still fails closed with bounded `503`.)*
- [x] GET-only `/feeds/google-merchant` with safe standards-aware RSS 2.0 serialization.
- [x] `MAX_MERCHANT_OFFERS = 5_000`.
- [x] `MAX_MERCHANT_FEED_BYTES = 16 MiB` with **incremental UTF-8 byte accounting**; abort before next chunk exceeds limit.
- [x] `MAX_MERCHANT_DB_ROUND_TRIPS = 8`; no N+1. Public-feed repository uses at most eight flat, bounded Prisma model reads and refuses over-bound product/variant catalogs rather than truncating.
- [x] `MERCHANT_FEED_CACHE_TTL_SECONDS = 300`.
- [x] `MERCHANT_FEED_FAILURE_BACKOFF_SECONDS = 60`.
- [x] Fixed success-cache and failure-backoff key domain is configured shop + feed schema/version only; query/header noise cannot create unbounded keys.
- [x] Cache only complete successful serialized feed; failure sentinel stores bounded non-sensitive failure class/retry time only.
- [x] Repeated GETs within success TTL perform zero additional heavy DB generations.
- [x] Concurrent cold requests are collapsed by a tested process-local single-flight mechanism for current one-app-service topology.
- [x] After a failed/overflow heavy rebuild, sequential or concurrent requests inside 60s backoff return cheap `503` with bounded `Retry-After` and perform zero additional heavy DB generations.
- [x] Backoff expiry admits one new single-flight rebuild attempt, not one attempt per waiting request.
- [x] Failure/backoff state never overwrites, corrupts, or marks a complete successful feed body as failed.
- [x] If production changes to multiple app replicas, activation remains blocked until shared cross-replica cache/single-flight/backoff protection is proved; U26 makes no multi-replica protection claim.
- [x] Failed/overflow rebuild never publishes/caches partial result as success.
- [x] Overflow target `503`; never partial/truncated `200`.
- [x] Tests cover RSS output, escaping/Unicode/control chars, deterministic order, offer/byte boundaries, whole-generation query budget, success miss/repeated hit, concurrent cold miss, concurrent TTL expiry, request-noise key isolation, sequential/concurrent failure backoff, backoff expiry single retry, and success-cache/failure-sentinel isolation.

### Checkpoint E
**GREEN / PASSED** on PR #198's final exact head `1d003dc4d917c138a2c12f93c98b4a38be487754` (merged to `main` as `2d5ea84045f61fc1249076379dd0816d37499546`). Evidence is exact-head, not stale-head: CI #1964, Merchant feed runtime #27, Catalog indexation runtime #952, P18 final QA runtime #746 and VPS container verification #889 all concluded `success` on that SHA.
- [x] Focused Merchant mapping/route/cache/backoff tests green on final exact PR-E head.
- [x] `pnpm test`, `pnpm test:db`, `pnpm typecheck`, `pnpm lint`, `pnpm build` green on exact PR-E head (CI #1964 `verify`).
- [x] Real Next runtime smoke confirms cached/backoff route status/content type/complete body/no secrets and cheap repeated failure behavior on final exact PR-E head (Merchant feed runtime #27: bounded `503`, `retry-after: 60`, `x-la-merchant-feed-failure: MARKET_UNRESOLVED`, one `cold_generation`, request query noise ignored).

### Merchant feed ↔ U27 variant JSON-LD parity (Wave 5 convergence gate)
- [x] One catalog fixture and one storefront projection feed both consumers, and the Merchant side is read back from serialized RSS bytes rather than the mapper's in-memory result: `tests/domain/merchant-structured-data-parity.test.ts`.
- [x] Variation identity, `item_group_id` ↔ `productGroupID`, ADR 0008 manufacturer MPN, exact U12 variant URL and exact promotion-aware price all MATCH for publishable variant-family states.
- [x] Availability semantics and the publishable standalone variant set MATCH across the whole resolvable stock domain — no warehouse rows, an explicit zero, and any positive quantity.
- [x] **U27a:** any malformed mirrored warehouse row makes a variant's availability unstatable, and both consumers omit it. U27's MPN-uniqueness domain is also aligned with the Merchant mapper's, so a variant excluded on its own facts can no longer suppress a sibling that shares its part number. The rule is per row, not on the total, so `[5, -3]`, `[3, -3]` and `[100, -1]` are unresolved as surely as `[-3]`. Carried by a server-only `variantAvailabilityResolvedById` from the catalog read to the U27 boundary, and applied to the product-level fallback offer as well as to exact variant offers, so a suppressed availability claim cannot reappear one node up. No extra DB query, no client contract widening, shopper-facing PDP stock behaviour and Merchant both unchanged.
- [x] Missing/blank/untrimmed/duplicate MPN, unresolved price, unaddressable identity and composite candidates fail closed compatibly on both sides; neither consumer invents a fallback identifier, URL or price.
- [x] **O2 decision is resolved** as Vietnam / `vi` / `VND`. **Historical proof context:** when PR #214/#216 established the parity contract, the suite used a clearly named test-only market fixture because the production trusted runtime authority had not landed yet. **Current truth:** PR #226 now provides that trusted server-owned authority and the public feed runtime is configured from it; nothing in `src/` imports the historical test fixture.
- [x] **Convergence launch gate** (`Before Merchant/index launch, prove feed vs JSON-LD ... consistency` in `tasks/growth-commerce-master-todo.md`) is **implemented by PR #214** (merged as `be7e5f628f86e71f8fc9769bed210501e15e03ed`, exact head `5fcb7a4cda5e1def6028b30abd3bb459cdd51f5e`) and **CLOSED by PR #216**, which supplied the missing discriminating promotion-aware price proof required by contract clause 5. Approved contract, now implemented: when exclusion leaves exactly one publishable standalone sibling, Merchant keeps the exact survivor; U27 emits a standalone `Product` representing that same exact survivor with the same U12 variant deep-link and verified variant facts; U27 does **not** emit a one-member `ProductGroup`; and a product that started with exactly one option keeps the ordinary product-level fallback. Focused parity coverage proves variation identity, exact U12 URL, ADR 0008 MPN, promotion-aware price and resolved availability for the survivor state: `tests/domain/merchant-structured-data-family-collapse.test.ts`, `tests/domain/merchant-structured-data-family-collapse-eligibility.test.ts` and the survivor cases in `tests/domain/merchant-structured-data-parity.test.ts`. Evidence/decision: `docs/audits/merchant-jsonld-parity.md` + `docs/specs/la-clothing-owner-approved-facts-and-decisions.md`. **This closes the parity blocker only; it activates no Merchant destination.**

## PR-F — Merchant activation + final convergence

### M5 Merchant Center setup
- [x] Wire the approved O2 market **Vietnam / `vi` / `VND`** through reviewed trusted server-owned configuration; no Host/query/request/caller market authority.
- [ ] Verify/claim website and configure shipping/returns, product data source, Ads linkage.
- [ ] Scheduled Fetch uses production HTTPS route at highest practical regular account-supported cadence.
- [ ] Review Merchant Automations; keep automatic price/availability/condition updates off until exact variant structured data is proven.
- [ ] Google can fetch landing pages/images while `SEARCH_INDEXING_ENABLED=false` remains unchanged.
- [ ] Merchant diagnostics show representative in-stock/out-of-stock/variant records; no composite v1 expectation.

### V1 Definition of Done / launch gate
- [ ] Exact-head `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:db`, `pnpm build`, `pnpm release:check`.
- [ ] Applicable browser/runtime suites green.
- [ ] Exact GTM container/version/export record + GTM/GA4/Ads/TikTok diagnostics recorded.
- [ ] Merchant cache/backoff/fetch/diagnostics/crawler evidence recorded.
- [ ] Verify production topology still matches one-app-service cache/single-flight/backoff assumption; otherwise shared cross-replica protection is mandatory.
- [ ] Final review: correctness → security → architecture → simplicity → performance.
- [ ] Rollback documented for GTM exact-version delivery and Merchant data source/cache/backoff.
- [ ] Human approval before publishing live GTM version / enabling Merchant listings or campaigns.

## Explicitly deferred

- [ ] TikTok Events API.
- [ ] Meta Pixel migration into GTM.
- [ ] Meta delivery-system migration / Catalog-specific ID redesign without verified Catalog/Pixel/feed evidence. Direct funnel CAPI is implemented under ADR 0015.
- [ ] Google Enhanced Conversions / hashed customer PII.
- [ ] Merchant API realtime sync.
- [ ] Composite Merchant offer / `item_group_id` design.
- [ ] Visible consent UI/default-denied policy.
- [ ] Search-indexing/permanent-domain changes.
- [ ] Unrelated SEO/catalog/admin refactor.
