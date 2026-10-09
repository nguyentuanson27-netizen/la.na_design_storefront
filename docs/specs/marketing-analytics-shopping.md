# Spec: Marketing Analytics, Ads Tracking & Google Shopping

Status: **T1–T7, M1, M2, and M3 implemented; M1 operational real-catalog closure is GREEN and Checkpoint D PASSED. T8 and M4–M5/V1 remain proposed and require reviewed approval before `/build`.** M3 builds Merchant items internally only — no feed is published, and the O2 market gate keeps Merchant activation blocked.

This specification defines the approved product outcome and safety boundaries. The implementation-level choices are normative in `tasks/marketing-analytics-shopping-plan.md`. In particular, the plan intentionally narrows conceptual examples here where the current storefront cannot truthfully supply a variant-level fact yet.

## 1. Objective

Build a production marketing-measurement and catalog-export foundation for LA Clothing covering:

- Google Tag Manager (GTM);
- Google Analytics 4 (GA4);
- Google Ads Purchase conversion tracking;
- TikTok Pixel through GTM;
- existing direct Meta Pixel + Meta Conversions API;
- automated Google Merchant Center product data for Google Shopping.

The storefront and order system remain the source of truth. Tracking/catalog vendors consume canonical application facts; they must not invent commerce truth from DOM text, button clicks, mutable client state, duplicated pricing rules, or raw mirror ownership that conflicts with the public storefront projection.

## 2. Confirmed product decisions

1. GA4 + Google Ads + TikTok Pixel run through GTM.
2. Meta Pixel + Meta CAPI stay direct; no Meta-to-GTM migration in this scope.
3. TikTok Events API is a later phase.
4. One canonical commerce fact/event layer supplies new tracking destinations.
5. Purchase exists only for `OrderMirror.state === CONFIRMED`.
6. `OrderMirror.publicCode` is the canonical Purchase transaction/event ID.
7. Only approved production configuration may send real production vendor traffic.
8. Consent/tracking-policy abstraction is built now; visible consent UI is deferred; current production owner policy grants analytics/advertising tracking immediately.
9. Merchant Center uses public HTTPS product-data URL + Scheduled Fetch.
10. Merchant v1 is **standalone product/variant only**. Composite Merchant offers are deferred until a separate durable family/context identity design exists.
11. `brand = LA Clothing`; manufacturer MPN authority is the owner-confirmed Pancake variation `display_id`, mirrored as `VariantMirror.pancakeDisplayId` per ADR 0008, only after presence/uniqueness/stability audit. Website-owned `VariantMirror.sku` is a separate local field and is not Merchant MPN authority.
12. Pancake/internal barcode is not assumed to be GTIN.
13. Structurally valid zero-stock standalone offer remains in feed as `out_of_stock`.
14. Search indexing remains separately governed; this feature does not enable `SEARCH_INDEXING_ENABLED`.
15. PDP “Thêm vào giỏ hàng” means one committed positive unit increment; cart quantity controls remain absolute set semantics.
16. Public Merchant failure paths are bounded as well as success paths; persistent rebuild failure cannot trigger unbounded heavy regeneration from sequential public GETs.

## 3. Repository invariants to preserve

### Existing Meta

PR #110 / [ADR 0015](../decisions/0015-direct-meta-capi.md) extends the direct integration to PageView, ViewContent, AddToCart, InitiateCheckout and Purchase. Browser occurrence signals carry only a path/UUID or a signed receipt. Prices/items remain server-owned. ViewContent/InitiateCheckout IDs are signed by the server; AddToCart IDs and deltas come from committed mutations; confirmed Purchase retains `publicCode`, its original POS submission instant and frozen payload, including reconciliation. Receipts bind occurrence IDs and the existing DB limiter bounds endpoint abuse. Acknowledgement or replay expiry removes stored attribution, retaining browser business facts. This supersedes the earlier CAPI-extension deferral; real account activation remains unverified.

Compatibility constraints:

- no second Meta Pixel through GTM;
- Meta Purchase remains confirmed-order only;
- `publicCode` remains Meta Purchase event identity;
- current Meta content-ID semantics remain unless a focused correctness regression proves a value-source fix is needed;
- tracking failure never changes checkout success.

### Public order identity

`publicCode` is unique and non-PII. No vendor adapter may replace it with email/phone/session/cart identity for Purchase dedup.

### Storefront visibility and price

Storefront visibility follows current active/present storefront rules, not editorial `ProductContent.status === PUBLISHED`.

Current storefront sell price is authoritative. Where `pancakeRetailPrice` and `pancakeRetailPriceAfterDiscount` differ, storefront behaviour was `PRICE_UNRESOLVED` until the upstream pricing contract was separately proven. That proof landed (`#152` W3 real-catalog evidence, verdict PASS): Pancake evaluates promotions as dynamic order rules rather than catalog price mutations, so the differing after-discount field is not website pricing authority. The equality gate was removed for the product page and `/shop` in Wave 2, and for the cart, the checkout render and the order snapshot in Wave 3, so every currently enabled price-bearing consumer now resolves through `src/commerce/promotion-pricing.ts`. `resolveStorefrontPrice` remains the default only for surfaces that have not opted in.

### Structural eligibility vs availability

A structurally valid option with zero stock may remain a Merchant offer as `out_of_stock`. `PRICE_UNRESOLVED`, malformed, forged, unreachable, ambiguous, or private options are structurally ineligible rather than merely out of stock.

### Composite storefront

Composite storefront/cart/checkout remain supported. A component may be sold through another parent PDP. Raw `VariantMirror.productId` and presentation `kindKey` are therefore not universal Merchant family identity.

For Merchant v1 this complexity is resolved conservatively: **all composite projections are excluded** with a bounded diagnostic such as `COMPOSITE_DEFERRED`. This does not disable composite analytics/storefront commerce.

### Purchase snapshot

`OrderLineSnapshot` preserves purchased `pancakeVariationId`, product name, color, size, quantity, unit price and line total. New rows also freeze `metaContentId` from the committed add's public PDP slug (`CartItem.sourceProductSlug`), verified through the complete server PDP projection. Components bought through a parent retain that parent even when their owner is public; cart quantity edits do not guess another parent. Legacy private lines without provenance suppress Meta tracking. This does not establish SKU, Merchant family identity or an actual Meta Catalog mapping.

Immutable Purchase facts come from the snapshot. Current catalog enrichment is optional and must not override immutable price/quantity facts.

### SKU/MPN

Manufacturer MPN authority is the owner-confirmed Pancake variation `display_id`, mirrored as `VariantMirror.pancakeDisplayId` and governed by ADR 0008. Merchant activation must prove emitted MPN presence, uniqueness and sufficient stability; missing/duplicate/invalid values fail closed with diagnostics. Website-owned `VariantMirror.sku` remains nullable, non-DB-unique, locally owned, and **must not** be treated as the Merchant MPN source or overwritten by Pancake sync.

### Media

Merchant must reuse trusted normalized storefront media rather than bypassing the existing external-media trust boundary.

### Structured data

Current PDP JSON-LD is aggregate and is not exact variant authority. Merchant price/availability/condition automations start disabled until exact submitted-variant structured-data matching is proven.

### CSP/deployment

Third-party origins remain closed unless the reviewed integration actually needs them. Build/runtime configuration must stay aligned.

### Search exposure

ADR 0004 remains authoritative. Merchant crawlability must not silently enable organic indexing, canonical exposure policy, or sitemap exposure.

### Current runtime topology

Current VPS Compose declares a single `app` service instance behind the proxy path. Merchant v1 may use process/runtime-scoped single-flight and failure-backoff protection only while that topology remains true. If production changes to multiple app replicas before Merchant activation, shared cross-replica cache/single-flight/backoff protection becomes a launch prerequisite.

## 4. Canonical commerce event contract

### 4.1 General rules

- Business code owns event truth.
- GTM routes/maps events; it does not reconstruct business logic.
- No DOM price scraping or generic click-derived Purchase/AddToCart.
- Tracking is fail-safe.
- Before each ecommerce push, clear/reset the previous ecommerce object; never replace initialized `window.dataLayer`.
- No customer name, phone, address, email, note, or other checkout PII enters the generic commerce dataLayer.

### 4.2 Product-level upper funnel vs selected variant

The storefront has legitimate states where a variant has **not** been selected. Therefore the implementation must distinguish product impressions from selected/committed variant items.

Product-level facts are used for:

- `view_item_list`;
- `select_item`;
- initial unselected PDP `view_item`.

Conceptually:

```ts
type CommerceProductImpression = {
  productExternalId: string;
  itemName: string;
  exactPriceVnd?: number;
  minimumPriceVnd?: number;
  maximumPriceVnd?: number;
  listId?: string;
  listName?: string;
  index?: number;
};
```

Rules:

- candidate product external ID is `pancakeProductId` after repository propagation;
- one visible card produces one product impression, not one impression per hidden variant;
- do not guess first/cheapest variant to obtain a `pancakeVariationId`;
- GA4 upper-funnel mapping may use `item_id = productExternalId`; a selected Merchant-offer ID is not promised before a variant exists;
- if all represented resolved options have one exact common price, that exact value may be mapped to vendor price/value;
- if prices form a range, min/max may remain canonical/custom facts but the minimum must not be reported as if it were a selected exact variant price;
- unresolved product price omits monetary vendor fields rather than fabricating values.

Selected/committed variant facts are used for cart/checkout/Purchase stages:

```ts
type CommerceVariantItem = {
  variantExternalId: string; // pancakeVariationId
  productExternalId?: string;
  itemName: string;
  unitPriceVnd: number;
  quantity: number;
  color?: string;
  size?: string;
  projectionContext?: string;
};
```

Exact variation identity begins only when the application actually has a concrete selected/committed variant.

### 4.3 Event vocabulary/truth points

Supported baseline events:

- `page_view`
- `view_item_list`
- `select_item`
- `view_item`
- `add_to_cart`
- `remove_from_cart`
- `view_cart`
- `begin_checkout`
- `purchase`

`add_shipping_info` and `add_payment_info` remain absent until the application has distinct accepted milestones worth measuring.

Truth rules:

- list/select/view_item use canonical rendered facts and the identity level described above;
- PDP AddToCart only after one successful atomic positive server increment;
- cart quantity AddToCart/RemoveFromCart only from committed server delta;
- RemoveFromCart only after committed cart mutation;
- ViewCart/BeginCheckout use resolved canonical cart/checkout state;
- Purchase only after confirmed-order truth.

### 4.4 Atomic server-authoritative PDP AddToCart

The PDP button means “add one unit”. The implementation must not route it through an absolute `set quantity = 1` operation, because a pre-existing line could otherwise produce zero or negative committed delta while the UI/action still reports success.

Under the same serialized cart lock used for cart mutation, the PDP add operation must:

- resolve/authorize the current selected option;
- read `previousQuantity` (`0` if absent);
- validate prospective `previousQuantity + 1` against current stock/integer/commerce bounds;
- commit exactly one additional unit;
- return `previousQuantity`, committed `quantity`, and `addedQuantity = 1` on success.

The same accepted transaction must capture/resolve a bounded non-PII event snapshot containing at minimum:

- `pancakeVariationId`;
- authoritative current resolved unit price;
- item/product name;
- color/size when available;
- the committed quantity transition.

Canonical PDP `add_to_cart` is built only from those returned success facts, with event quantity equal to `addedQuantity`, never from a stale pre-request price/quantity or the assumption that any `{ ok: true }` means +1.

If commerce mutation succeeds but a safe analytics snapshot cannot be resolved, commerce success stands and analytics fails closed: emit no new canonical vendor event and do not fall back to stale client/rendered facts.

### 4.5 Atomic cart quantity events and mutation snapshots

The cart editor keeps absolute-set quantity semantics. Any rendered/pre-transaction quantity/availability pre-check is advisory only; the serialized mutation must re-resolve current commerce eligibility and requested-quantity stock sufficiency before accepting an absolute update.

Update/removal analytics must use facts captured under the same serialized cart transaction that commits the mutation.

Required success facts:

- update: `previousQuantity`, committed `quantity`, plus bounded canonical event item snapshot;
- remove: `removedQuantity`, plus the canonical event item snapshot captured **before destructive delete**;
- snapshot identity/value: `pancakeVariationId`, authoritative current resolved unit price, item/product name, color/size when available, optional safe product/projection context.

Client/pre-read/rendered quantity, price, item name or variant identity is not authoritative for mutation event construction. Browser derives positive/negative delta only from returned committed facts.

If safe snapshot resolution fails, tracking fails closed without altering the authoritative cart mutation result. A catalog/price/stock change between render or pre-check and mutation must not produce a stale or no-longer-valid accepted update/event.

### 4.6 Purchase truth

Purchase requires:

```text
OrderMirror.state === CONFIRMED
```

Never emit Purchase for DRAFT, VALIDATING, POS_SUBMITTING, REJECTED or SYNC_UNKNOWN.

Canonical Purchase facts include:

```ts
type CommercePurchase = {
  transactionId: string; // publicCode
  eventId: string;       // publicCode
  currency: "VND";
  merchandiseValueVnd: number;
  shippingVnd: number;
  totalVnd: number;
  items: CommerceVariantItem[];
};
```

Purchased price/quantity/variation identity comes from immutable order snapshots. Refresh/revisit reuses the same transaction/event ID.

### 4.7 Destination value semantics

- GA4 Purchase value = merchandise item sum; shipping separate.
- Meta keeps total-order Purchase semantics in this scope.
- Google Ads Purchase value remains owner decision: merchandise-only vs total order.
- TikTok mapping is re-verified at build time; Purchase event identity remains `publicCode`.

Intentional arithmetic differences must be documented/tested.

## 5. GTM / GA4 / Ads / TikTok requirements

### 5.1 No GTM load before reviewed immutable version

The implementation plan owns a strict interlock:

- PR-A prepares dataLayer, consent defaults/policy, page-view events and desired tracking configuration;
- PR-A must not load a GTM script/iframe in any requested mode and must not open new Google/TikTok CSP origins for the new integration;
- both requested `preview` and requested `live` remain operationally no-GTM until T8/PR-C;
- T8 creates/reviews an immutable saved GTM container version and only then adds the actual GTM loader/CSP requirements.

This prevents a partially merged application from loading an old/unreviewed mutable container.

### 5.2 Immutable GTM version evidence

Before preview/live enablement, record:

- container ID;
- exact saved container version number/ID;
- export JSON from that exact version;
- immutable repository identity/checksum for the reviewed export.

Every production GA4/Ads/TikTok tag in that version must require application `la_tracking_mode == live`.

Final preview must preview that exact saved version, not a later mutable workspace. Live publish must publish the same reviewed version. Any later console edit requires a new version/export/review cycle.

Tag Assistant is verification evidence, not a network-isolation control.

**Release gate for `src/tracking/reviewed-gtm-version.json`.** The runtime and the CSP only check the
record's shape. CI (`tests/domain/reviewed-gtm-evidence.test.ts`) binds it to the evidence: the
referenced export must be checked in, its SHA-256 must equal `exportSha256`, its container and saved
version ids must equal `containerId` / `versionId`, and `auditGtmContainerExport()` must pass against
the record's `approvedDestinations`. The loader requests the container by public id, which serves
whatever is *published*, so at every release (and after any console republish) confirm in Tag Manager
that the live version equals `versionId`; there is no automated check for that.

### 5.3 Page views

Application code owns canonical initial/App Router `page_view`. The GTM/GA4 configuration must disable overlapping automatic/history page-view behavior so one navigation is counted once.

### 5.4 Consent compatibility

A vendor-neutral consent abstraction exists from the start. Current owner policy grants tracking immediately, with UI hidden. Google consent defaults must be established/queued before measurement. Later visible consent UI/default-denied behavior must be possible without changing commerce event contracts.

### 5.5 Google Ads

Purchase is the required primary conversion in this phase. Use `publicCode` as transaction ID and preserve conversion-linking functionality. Enhanced Conversions/customer PII are out of scope.

### 5.6 TikTok

TikTok Pixel runs through GTM. Purchase/CompletePayment uses `event_id = publicCode` now so a later Events API implementation can share the same identity.

## 6. Google Merchant Center requirements

### 6.1 Delivery

Use a public HTTPS GET-only product-data route and Merchant Center Scheduled Fetch. Do not use Merchant API realtime sync in v1.

### 6.2 Standalone identity only

V1 candidate identifiers:

```text
id            = pancakeVariationId
item_group_id = pancakeProductId (for standalone variant family)
brand         = LA Clothing
mpn           = audited LA Clothing manufacturer MPN from VariantMirror.pancakeDisplayId (Pancake variation display_id), per ADR 0008
gtin          = omitted unless real assigned valid GTIN exists
```

`VariantMirror.sku` remains website-owned/local and is explicitly **not** the Merchant MPN authority or fallback. Before activation, `pancakeVariationId`, `pancakeProductId`, and the emitted manufacturer MPN require the reviewed durability/stability evidence and an attributable real-catalog gate run.

Composite Merchant offers are excluded in v1.

### 6.3 Exact variant landing URL

Standalone feed item links to:

```text
/shop/<slug>?variant=<pancakeVariationId>
```

The query may preselect only a currently valid public standalone option and must show matching visible price/color/size/image. Forged/stale/private/composite values fail closed.

Organic canonical/search exposure remains the base PDP contract; the variant query does not create independent indexing policy.

### 6.4 Feed truth

Feed mapper derives from canonical storefront facts:

- active/present public standalone product/option;
- current storefront price resolver;
- trusted media;
- stock mapped separately to `in_stock`/`out_of_stock`;
- truthful required apparel facts;
- safe customer-facing description source;
- audited identifiers.

Never infer GTIN from Pancake barcode.

### 6.5 Safe serialization

External catalog/editorial text is untrusted input. Use standards-aware serialization; escape XML correctly; reject/normalize illegal controls/malformed URLs/oversized fields; parse generated output in tests. No hand-built raw XML interpolation.

### 6.6 Public route resource, cache, single-flight and failure-backoff boundary

The public route must not regenerate a bounded-but-expensive feed for every request, including persistent failure paths.

Initial v1 envelope:

```text
MAX_MERCHANT_OFFERS                   = 5_000
MAX_MERCHANT_FEED_BYTES               = 16 MiB
MAX_MERCHANT_DB_ROUND_TRIPS           = 8 per heavy generation
MERCHANT_FEED_CACHE_TTL_SECONDS       = 300
MERCHANT_FEED_FAILURE_BACKOFF_SECONDS = 60
```

Requirements:

- complete successful serialized feed is cached under a fixed configured-shop/feed-schema key;
- request query/header noise must not create unbounded cache or failure-backoff dimensions;
- repeated GETs within success TTL perform no additional heavy DB generation;
- concurrent cold requests are collapsed by a tested single-flight mechanism for the current single-app-service runtime;
- failed/overflow heavy generation installs a fixed-key 60-second negative backoff sentinel containing only bounded non-sensitive failure class/retry time;
- sequential or concurrent GETs during active backoff return cheap bounded `503` with bounded `Retry-After` and perform no additional heavy DB generation;
- backoff expiry admits one new single-flight retry, not one retry per concurrent caller;
- failure/backoff state must not overwrite, corrupt or mark a complete successful feed body as failed;
- if production topology changes to multiple app replicas, activation is blocked until shared cross-replica cache/single-flight/backoff protection is proved;
- serialization maintains incremental UTF-8 byte accounting and aborts before exceeding 16 MiB;
- overflow/failure returns non-success, never truncated/partial 200;
- failed rebuild cannot publish/cache partial output as successful feed;
- no N+1 per-offer query path.

The current repo does not enable Next.js Cache Components. `/build` must re-check the current Next 16.2.x supported caching API; do not enable a framework-wide cache model merely for this route unless separately justified.

### 6.7 Merchant Automations

Start automatic price/availability/condition updates disabled until exact variant-level structured-data matching is proven. Current aggregate PDP Offer is not variant authority.

## 7. Security/privacy requirements

- Generic dataLayer contains no checkout/customer PII.
- No Enhanced Conversions in this phase.
- Secrets remain server-only; GTM/GA/Ads/TikTok public IDs are configuration identifiers, not authorization secrets.
- Tracking failures are no-op for commerce.
- GTM CSP changes are least privilege; no convenience production `unsafe-eval`, wildcard origins or unreviewed Custom HTML/JS.
- Merchant route has fixed configured source scope, finite work limits, success caching, single-flight and bounded failure-backoff protection; no arbitrary request-driven upstream fetch.
- External catalog text cannot inject markup/XML/script.

## 8. Environment/activation policy

### Production

After the corresponding reviewed implementation/activation gates:

- Meta direct continues;
- GTM may load the exact approved container version;
- GA4/Ads/TikTok production destinations require `la_tracking_mode=live`;
- Merchant Scheduled Fetch may use production feed.

### Local/CI/staging before GTM activation

- no new real production vendor traffic;
- PR-A has no GTM loader;
- dataLayer can be tested locally without third-party delivery.

### Preview after T8

- only exact reviewed saved GTM version;
- production destination tags remain live-gated;
- isolated test/debug destinations only;
- zero production destination traffic must be demonstrated.

## 9. Acceptance criteria summary

Implementation is ready for live activation only when:

1. canonical product-vs-variant event contracts pass focused tests;
2. PDP AddToCart is a distinct atomic +1 mutation and each successful event reflects exactly the committed positive delta;
3. PDP/cart mutation events use authoritative server snapshots for variation identity, price, name/options and quantity delta; snapshot failure has no stale fallback;
4. cart absolute update/remove delta facts and requested-quantity validity are transactionally authoritative, including pre-delete remove snapshot;
5. Purchase is confirmed-only and uses `publicCode` identity;
6. exact GTM saved version/export has been reviewed and previewed; production tags all have live guard;
7. one GA4 page view per navigation is demonstrated;
8. existing Meta direct behavior/dedup remains healthy;
9. standalone Merchant identity/MPN/durability audit is green on an attributable exact-SHA real-catalog run;
10. exact standalone variant deep links match feed-visible facts;
11. Merchant feed serialization/resource/success-cache/single-flight/failure-backoff tests pass;
12. repeated sequential failed feed GETs during backoff do not re-run heavy generation;
13. current production topology is verified; multi-replica topology has shared cache/single-flight/backoff protection before activation;
14. Merchant diagnostics/crawler checks are acceptable;
15. `SEARCH_INDEXING_ENABLED=false` remains unchanged unless separately approved;
16. owner decisions for Ads value, Merchant market/apparel facts and vendor account configuration are resolved before affected activation;
17. repository Definition of Done and exact-head verification gates are satisfied.

## 10. Explicitly out of scope / deferred

- Meta Pixel migration into GTM.
- Meta migration to another delivery system and Catalog-specific content-ID redesign without verified Catalog/Pixel/feed evidence. Direct funnel CAPI correctness and extension are covered by ADR 0015.
- TikTok Events API.
- Google Enhanced Conversions / hashed customer PII.
- Merchant API realtime sync.
- Composite Merchant offer/item-group design.
- Visible consent banner/default-denied policy.
- Search-indexing/permanent-domain changes.
- Product pricing-policy change for retail vs after-discount mismatch.
- Unrelated SEO/catalog/admin refactor.

## 11. Planning handoff

Implementation source of truth is `tasks/marketing-analytics-shopping-plan.md`, with executable checklist in `tasks/marketing-analytics-shopping-todo.md`.

The implementation lifecycle remains:

```text
PR-A tracking preparation (no GTM load)
→ PR-B commerce browser truth (atomic PDP add + mutation snapshots)
→ PR-C Purchase + immutable GTM version/loader
→ PR-D Merchant identity/deep-link
→ PR-E cached/backoff-protected bounded Merchant feed
→ PR-F activation/final verification
```

No runtime implementation belongs in this docs-only PR.