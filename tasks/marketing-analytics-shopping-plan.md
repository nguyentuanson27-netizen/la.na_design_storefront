# Marketing analytics & Google Shopping — implementation plan

**Meta amendment (2026-10-07, PR #110):** [ADR 0015](../docs/decisions/0015-direct-meta-capi.md) governs the direct five-event Pixel/CAPI contract, signed shared IDs, committed positive cart deltas, persisted verified PDP provenance, reconciliation Purchase and bounded attribution retention. This extends the implementation; it does not activate Meta accounts or change Catalog ID semantics. [Audit/tests](../docs/audits/meta-ads-2026-10-07.md).

Status: **T1–T7, M1, M2, M3 and M4 IMPLEMENTED; Checkpoint D PASSED and Checkpoint E PASSED. T8 and M5/V1 remain proposed and require human approval before `/build`.**

T1–T3 (PR #157), T4 (PR #164 + #165), T5/T6 (PR #186), M2 (U12 / PR #180), T7 (U24 / PR #193), and M1 (PR #175 durability + PR #194 read-only audit + exact-SHA operational closure) are delivered. See `tasks/marketing-analytics-shopping-todo.md` for per-item state. **Checkpoint D is GREEN / PASSED** and **Checkpoint E is GREEN / PASSED** (M4 delivered by U26 / PR #198). T8, M5 and V1 are not implemented and still need approval before `/build`. No GTM loader exists in the repository: T8 owns the first actual GTM load and CSP opening.

Source specification: `docs/specs/marketing-analytics-shopping.md`.

PR #153 intentionally keeps `/spec` + `/plan` together as a docs-only review unit. This plan is the normative v1 implementation narrowing of the specification. Where a conceptual example in the spec is broader than the repository can truthfully support today, the reviewed decisions below govern implementation. Runtime code must land in focused implementation PRs, not in this planning PR.

## 1. Goal and invariants

Implement GA4 + Google Ads + TikTok Pixel through GTM, preserve the existing direct Meta Pixel + CAPI integration, and expose an automated Google Merchant product-data source without moving commerce truth into vendor tooling or weakening current CSP/search-exposure behavior.

Core invariants:

- business/order/cart state owns commerce truth;
- GTM is routing/mapping only;
- Purchase exists only for `OrderMirror.state === CONFIRMED`;
- `publicCode` is the shared Purchase transaction/event identity;
- no GTM container may load before the exact reviewed container version is available;
- only approved production configuration may send live vendor traffic;
- preview/test traffic must be mechanically isolated from production destinations;
- tracking failure must never break shopping/checkout;
- no customer PII enters the generic commerce `dataLayer`;
- upper-funnel events must not invent a selected variant when the UI has not selected one;
- PDP AddToCart means one committed positive cart increment, not an absolute quantity reset;
- cart/Purchase events use server-committed identity, price and quantity facts rather than stale browser facts;
- `view_cart` / `begin_checkout` require one complete canonical cart analytics projection; unsafe mixed carts fail the whole analytics event rather than emitting partial items/totals;
- Merchant output is fail-closed when identity, price, landing context, serialization, cache, backoff, or resource limits are unsafe.

## 2. Planning-base repository facts that shaped implementation

The bullets in this section record the pre-T5/T6 planning baseline used to derive the contracts below. Delivered slices supersede any former-gap wording here; current delivery status is the status block above, `tasks/marketing-analytics-shopping-todo.md`, and the integrated evidence in `docs/audits/wave-2-checkpoint-b.md`.

- `next.config.mjs` currently has no Cache Components opt-in and builds a fail-closed CSP from build-time tracking configuration.
- `src/app/layout.tsx` owns the direct Meta mount point and is the app-level location where future GTM loading can be enabled.
- `StorefrontProductCard` represents one product card, links to `/shop/<slug>`, and may show an exact product price or `Từ <minimum>`; it does not select one variant.
- `ProductPurchasePanel` starts with kind/color/size unselected and shows product-level exact/range pricing until a concrete option is selected.
- current PDP AddToCart captures `selection.selectedPrice` in the browser before awaiting the server action.
- `storefront-purchase.ts` always asks its cart port for `quantity: 1`; that port is wired to `setAnonymousCartItemQuantity()`.
- `anonymous-cart.ts#setItemQuantity()` is an **absolute set** operation: under the cart lock its upsert writes `quantity` directly for both create/update. Therefore reusing it for the PDP “Thêm vào giỏ hàng” button can report success while producing zero or negative delta when the line already exists.
- `storefront-purchase.ts` re-fetches the current product and re-resolves the authorized option on the server before the cart mutation, while the public action currently collapses success to `{ ok: true }`. Therefore the browser price is not an authoritative post-mutation fact.
- current storefront cart resolution can derive product name, color, size and current resolved price server-side, but `StorefrontCartLine` exposes only local `variantId`; `storefront-cart-repository.ts` does not currently select/propagate `pancakeVariationId`, and `/checkout` consumes the same resolved cart lines. Therefore current cart/checkout facts cannot yet satisfy the canonical external variant identity required by `view_cart` / `begin_checkout`.
- current `canSetQuantity` storefront pre-check is outside the cart mutation transaction. It is advisory only for the future analytics/cart correctness contract; T6 must re-resolve current item/price/stock eligibility at the serialized mutation boundary before accepting an absolute update.
- `/checkout` renders only when current cart, price, stock, and shipping facts resolve, so it is the current `begin_checkout` truth point.
- `/checkout/success` checks `OrderMirror.state === CONFIRMED` before browser Purchase.
- `OrderLineSnapshot` stores `pancakeVariationId`, product name, color, size, quantity, and immutable prices, but not SKU/slug/Merchant/composite context.
- `VariantMirror.pancakeVariationId` is DB-unique; SKU is nullable and not DB-unique.
- mirror sync reconciles variants by `pancakeVariationId` and products by `pancakeProductId`; this proves repository identity semantics but not upstream lifetime durability by itself.
- cart mutations serialize on the cart row, but current update/remove results do not return old/removed quantity or authoritative event-item facts from inside that lock.
- composite storefront projection can sell a component variation through a different public parent PDP; presentation keys such as `component-1` are not stable external IDs.
- current PDP JSON-LD is aggregate, not exact variant authority.
- Next.js Route Handlers are not cached by default. Current repo does not enable Cache Components, so v1 must not assume `use cache` without a separate framework/config decision.
- current VPS Compose topology declares one `app` service instance behind the proxy path; v1 single-flight/backoff requirements are scoped to that reviewed topology. If deployment is changed to multiple application replicas before Merchant activation, V1 must add/prove a shared cross-replica cache/single-flight/backoff layer rather than assuming process-local protection is sufficient.

## 3. Locked v1 decisions

### 3.1 Two commerce identity levels: product impression vs selected variant

The earlier conceptual `CommerceItem` sketch in the spec must **not** be interpreted as requiring a `pancakeVariationId` for every ecommerce event. The repository has upper-funnel states where no variant is selected.

Use two fact shapes.

#### Product-level impression fact

Used for `view_item_list`, `select_item`, and the initial unselected PDP `view_item`:

```ts
type CommerceProductImpression = {
  productExternalId: string; // candidate: pancakeProductId
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

- `productExternalId` candidate is `pancakeProductId`, not a guessed variant.
- one rendered card produces one product impression; do not explode one card into every variation.
- `select_item` describes the product card the shopper selected, even though no size/color variant exists yet.
- initial PDP `view_item` is product-level unless the route itself authoritatively preselects a valid variant in a later approved contract.
- if all currently represented resolved options have the same price, `exactPriceVnd` may be set and vendor `price`/`value` may use it.
- if represented prices form a range, carry min/max only as canonical/custom facts and **omit vendor fields that would pretend the minimum is the exact selected price**.
- if there is no resolved price, omit monetary fields rather than fabricate one.
- GA4 mapping may use `item_id = productExternalId`; Merchant offer matching is not promised for these unselected upper-funnel impressions.

#### Selected/committed variant fact

Used for `add_to_cart`, `remove_from_cart`, `view_cart`, `begin_checkout`, and Purchase items:

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

Rules:

- `variantExternalId = pancakeVariationId` only when the application has a concrete selected/committed variant.
- internal `VariantMirror.id` remains the mutation/authorization identity and must never be substituted as a vendor external item ID.
- browser/cart/Purchase values use server-authoritative committed facts at their truth point.
- Manufacturer MPN is owner-confirmed Pancake variation `display_id`, mirrored as `VariantMirror.pancakeDisplayId` and governed by ADR 0008. The authoritative exact-tree operational run on `84c99db3de6757c3ded4396644eb4dae25869e09` found all 149 intended standalone MPNs present, valid and unique; **Checkpoint D is GREEN / PASSED**. Immediate T0/T1/T2 reads are consistency evidence; lifecycle evidence is the time-separated `a132` restoration/observation across 2026-09-02 → 2026-09-04 on the same variation IDs. Website-owned `VariantMirror.sku` remains a separate local field and is not overwritten or used as Merchant MPN fallback.
- Pancake barcode is never assumed to be GTIN.

Purchase `transaction_id` / `event_id` remains `OrderMirror.publicCode`.

### 3.2 Merchant scope — standalone only in v1

Merchant v1 **does not emit composite projections**.

Reason: a component variation sold through a parent composite PDP does not yet have a proven durable Merchant family identity, and a composite set/component relationship is not automatically the same thing as a normal color/size variant family. Until a separate design proves a durable composite public-context family contract, composite offers fail closed with `COMPOSITE_DEFERRED`.

For standalone products only:

- `id` candidate = `pancakeVariationId` after durability/format audit;
- `item_group_id` candidate = `pancakeProductId` when the standalone product has variants and after durability/format audit;
- each submitted variation gets a distinct deep link `/shop/<slug>?variant=<pancakeVariationId>`;
- the deep link preselects only a valid current public standalone option;
- organic-search canonical remains the base PDP contract; the variant query must not silently create an independent organic canonical/indexing policy.

Composite Merchant support is a separate later design/plan, not an implicit extension of M3.

### 3.3 External-ID durability gate

DB uniqueness/current upsert semantics are insufficient evidence for a live Merchant identity. Before Merchant activation M1 must collect at least one durability proof for both `pancakeVariationId` and `pancakeProductId`:

1. provider/API contract evidence that the IDs are stable for the lifetime of the same upstream product/variation; or
2. controlled repeated full-catalog resync evidence showing the same upstream objects retain the same IDs, combined with repository tests proving mirror rows are reconciled by those IDs; or
3. equivalent historical evidence approved in review.

If durability cannot be established, Merchant activation is blocked. Do not silently fall back to slug, color/size text, array position, presentation key, or local cuid.

### 3.4 GTM load gate: PR-A prepares dataLayer; PR-C owns the first actual GTM load

**No GTM script/container is loaded in PR-A.**

PR-A may implement validated desired mode/config inputs, `dataLayer` initialization, immutable `la_tracking_mode`, consent-default commands/state, canonical events queued into `dataLayer`, and fail-safe tests.

But before T8:

- both requested `preview` and requested `live` resolve operationally to **no GTM load**;
- Google/TikTok CSP origins stay closed unless another already-active reviewed integration needs them;
- no production GA4/Ads/TikTok network delivery is possible from the new integration.

T8 / PR-C owns the first GTM loader and CSP opening, and it may do so only after the exact container version below is reviewed.

### 3.5 Immutable GTM version contract

GTM workspace state is mutable, so a generic checked-in export is not enough. T8 must create and record an immutable version before final preview/publish.

Required record:

- GTM container ID;
- saved **container version number/ID**;
- export JSON produced from that exact saved version;
- repository path + checksum/Git identity for the reviewed export;
- destination IDs/labels redacted only if actually secret;
- review result proving every production GA4/Ads/TikTok destination tag is gated by `la_tracking_mode == live`.

Required lifecycle:

1. configure workspace;
2. save/create an immutable GTM version;
3. export that exact version and commit/review it;
4. preview **that exact saved version**, not an unversioned mutable workspace;
5. verify production destinations are blocked in preview/test mode;
6. only then allow application preview mode to load GTM;
7. for live activation, publish that exact reviewed version and record the published version ID;
8. any later console change requires a new GTM version + new export/review before production publish.

Tag Assistant is runtime evidence, not the isolation mechanism.

### 3.6 Consent

The application owns vendor-neutral consent state. Current production policy is tracking granted immediately and visible consent UI remains deferred, but the implementation must queue/establish Google consent defaults before GTM measurement and keep the policy replaceable later without changing the commerce event contract.

### 3.7 Destination semantics

- Exactly one GA4 page-view authority: application-owned canonical `page_view`; overlapping automatic/history page view must be disabled in the reviewed GTM version/property setup.
- Before each ecommerce event, clear/reset the prior ecommerce object so stale keys cannot bleed into the next event.
- Google Ads: Purchase is the only required primary conversion in v1; `transaction_id = publicCode`; conversion-linking functionality is required; Enhanced Conversions are out of scope.
- TikTok Pixel runs through GTM; Purchase/CompletePayment uses `event_id=publicCode` now so later Events API can share identity.
- Existing Meta Pixel + CAPI remain direct and no Meta tag is added to GTM.

### 3.8 PDP AddToCart is a distinct atomic increment with an authoritative event snapshot

The PDP button means “add one unit”. It must **not** call the cart editor’s absolute set-quantity mutation with `quantity=1`.

T5 introduces a distinct server mutation with these semantics:

- lock the live anonymous cart using the existing serialized cart boundary;
- resolve/authorize the selected storefront option using current server facts;
- read `previousQuantity` under that same lock (`0` if the line is absent);
- validate the prospective `previousQuantity + 1` against integer/stock/current commerce eligibility bounds;
- commit exactly `quantity = previousQuantity + 1`;
- each successful PDP click therefore has `addedQuantity = 1`; a no-op or decrease is never a successful PDP AddToCart.

The same transaction must also capture/resolve a bounded non-PII event item snapshot at the accepted mutation truth point, including at minimum:

- `pancakeVariationId`;
- current authoritative resolved `unitPriceVnd`;
- product/item name;
- color/size when available;
- optional safe product external ID/projection context;
- `previousQuantity`, committed `quantity`, and `addedQuantity=1`.

The browser builds canonical `add_to_cart` only from this success payload and reports `quantity = addedQuantity`, never from stale `selection.selectedPrice`, rendered quantity, or a client-side assumption that success means +1.

If the cart mutation succeeds but a safe analytics snapshot cannot be produced, commerce remains successful and canonical analytics fails closed: emit no new vendor event and never fall back to stale browser facts. Meta remains direct with existing public PDP slug semantics; ADR 0015 extends twins and fixes their authority/delivery boundaries with regression coverage.

### 3.9 Cart mutation and cart/checkout analytics use authoritative complete projections

The cart editor keeps its current **absolute quantity** UX; only the PDP add path becomes increment semantics.

For absolute update/remove, analytics facts are captured under the same cart lock/transaction that commits the mutation:

- any existing `canSetQuantity`/rendered pre-check outside the transaction is advisory only; the serialized mutation must re-resolve current commerce eligibility, requested-quantity stock sufficiency, identity and price before accepting the update;
- update captures `previousQuantity`, committed `quantity`, and a bounded canonical item snapshot;
- remove captures `removedQuantity` and the canonical item snapshot **before destructive delete**;
- snapshot includes `pancakeVariationId`, authoritative resolved `unitPriceVnd`, product/item name, color/size where available, and optional safe product/projection context;
- public actions expose only these bounded non-PII facts required for event construction;
- browser derives delta and event payload only from returned committed facts;
- if snapshot identity/price cannot be resolved safely, tracking fails closed with no rendered/client fallback and without changing the authoritative commerce result.

For read-only cart/checkout funnel events, T4/T6 extend the canonical resolved cart facts (or one dedicated equivalent analytics projection) so every analytics-safe line carries the actual purchased `pancakeVariationId` in addition to the internal local ID. Composite component lines use the component variation external ID; parent/composite presentation identity is optional context, never a replacement external variant ID.

`view_cart` and `begin_checkout` use an explicit **all-or-nothing** projection policy:

- every non-empty line must resolve a safe `pancakeVariationId`, authoritative non-negative unit price, positive integer quantity, and item name;
- if any line fails that contract, suppress the entire event rather than dropping only that line;
- local CUID/`VariantMirror.id` is never used as vendor `item_id` fallback;
- event merchandise value is exactly `sum(unitPriceVnd × quantity)` over the complete emitted line set; partial items/partial totals are forbidden;
- `view_cart` is built from current canonical cart truth;
- `begin_checkout` is built only after the existing checkout commerce-validity gates pass;
- inability to build the analytics projection never blocks or alters cart/checkout commerce behavior.

This means price/catalog/identity changes between render and mutation cannot cause stale mutation events, and mixed/unresolvable carts cannot create internally inconsistent cart/checkout funnel events.

### 3.10 Merchant public-route envelope, cache, single-flight, and failure backoff

A finite per-generation envelope plus success caching is insufficient when persistent failures can make every sequential public GET trigger another heavy rebuild. V1 therefore uses **complete-feed success cache + single-flight + fixed-key negative failure backoff**.

Current repo does not enable Cache Components. During `/build`, re-verify Next.js 16.2.x APIs; the baseline approach remains the smallest source-verified cache implementation without enabling an unrelated framework-wide model.

Initial contract:

- `MAX_MERCHANT_OFFERS = 5_000` emitted offers;
- `MAX_MERCHANT_FEED_BYTES = 16 * 1024 * 1024` bytes;
- `MAX_MERCHANT_DB_ROUND_TRIPS = 8` database round trips per heavy generation;
- `MERCHANT_FEED_CACHE_TTL_SECONDS = 300`;
- `MERCHANT_FEED_FAILURE_BACKOFF_SECONDS = 60`;
- one fixed key domain per configured shop + feed schema/version; URL query/header values must not create unbounded cache/backoff dimensions;
- cache **only a complete successful serialized feed** as feed body;
- failure sentinel stores only bounded non-sensitive failure class + retry timestamp; it is not a substitute feed body;
- collapse concurrent cache misses/retries through a proved single-flight mechanism for the current deployment runtime;
- if production topology changes to multiple app replicas, activation is blocked until shared cross-replica cache/single-flight/backoff protection is proved;
- repeated requests inside success TTL return cached bytes without DB-heavy generation;
- no per-record/N+1 query path.

Serialization remains incrementally bounded: validate bounded fields, maintain running UTF-8 byte count, and abort before the next chunk exceeds 16 MiB.

Failure/backoff behavior:

- offer/query/byte envelope overflow or heavy generation failure returns non-success (target `503 Service Unavailable`) with bounded diagnostics;
- after such a failed heavy attempt, install a 60-second negative backoff sentinel for the same fixed key;
- requests during active backoff return a cheap bounded `503` and bounded `Retry-After` without invoking heavy generation;
- backoff expiry admits one single-flight retry attempt, not one heavy attempt per concurrent caller;
- failure/backoff state never overwrites, corrupts, or marks a valid complete success-cache body as failed;
- never silently truncate and never return a partial `200`;
- route accepts no request-controlled shop/source URL or expensive filter dimension.

Required amplification tests:

- first successful miss invokes heavy generation once;
- repeated GETs within success TTL invoke heavy generation zero additional times;
- many concurrent GETs on one cold key cause at most one heavy generation per proved runtime/cache domain;
- TTL expiry causes one rebuild, not one rebuild per concurrent caller;
- first failing miss invokes heavy generation once and installs backoff;
- repeated sequential failed GETs during 60-second backoff cause zero additional heavy generations;
- concurrent callers around the same failure share one failed heavy attempt;
- backoff expiry permits one retry through single-flight;
- failure sentinel cannot poison/replace a valid successful feed cache entry;
- query-string noise does not create new generation/cache/backoff keys;
- offer limit, limit+1, byte limit/overflow, and query budget remain enforced.

## 4. Owner/account gates

These do not block pure foundations but block the affected live destination:

- **O1 — Google Ads Purchase value:** choose merchandise-only vs `OrderMirror.totalVnd` before Ads Purchase publish. GA4 remains merchandise value with shipping separate.
- **O2 — Merchant market:** proposed initial market Vietnam / Vietnamese / VND; confirm before Merchant activation. M3 must keep this fail-closed while unresolved, and caller/request data may never be treated as owner approval.
- **O3 — Apparel facts — policy decision resolved by ADR 0007 and runtime implemented by U25/M3:** Merchant v1 uses owner-approved shop defaults `gender=male`, `age_group=adult`, `condition=new`, with independent product-level overrides stored in local website-owned data. Resolution is `explicit product override → approved shop default`; no value may be inferred from Pancake fields, product name/category/description/size/model output. Persistence, server validation, admin editing, effective-fact projection and fail-closed tests are implemented; Merchant activation remains independently blocked on unresolved O2 and the remaining Gate M prerequisites.
- **O4 — Vendor configuration:** provide/review GTM container, GA4 Measurement ID, Google Ads conversion ID/label, and TikTok Pixel ID through their proper account owners.

## 5. Dependency graph

```text
T1 canonical event + identity-level contracts
 ↓
T2 desired tracking config / fail-closed interlock
 ↓
T3 dataLayer + consent + page_view preparation (NO GTM load)
 ↓
T4 product + variant + canonical cart projection facts
 ├──────────────────────┐
 ↓                      ↓
T5 atomic PDP add +     T6 atomic cart update/remove + cart/checkout projection events
server event snapshot   server event snapshot + complete funnel snapshot
 └──────────┬───────────┘
            ↓
T7 confirmed Purchase
            ↓
T8 immutable GTM version + loader/CSP + destination mapping + preview/live enablement

T4 → M1 Merchant identity/durability audit
       ↓
     M2 standalone variant deep link + canonical/query contract
       ↓
     M3 standalone Merchant mapper
       ↓
     M4 cached bounded route + failure backoff
       ↓
     M5 Merchant activation

T8 + M5 → V1 final verification / rollback gate
```

## 6. Implementation slices

ADR 0005 governs reviewability; file count is only a signal.

- **PR-A — tracking preparation:** T1–T3. It must produce zero new GTM/vendor network delivery.
- **PR-B — commerce browser events:** T4–T6, including a dedicated atomic PDP increment, server-authoritative mutation snapshots, and complete canonical cart/checkout analytics projection.
- **PR-C — confirmed Purchase + immutable GTM activation:** T7–T8, including actual GTM loader/CSP opening, saved-version export, static live-guard audit, preview enablement, and later live publish gate.
- **PR-D — Merchant identity + standalone deep link:** M1–M2.
- **PR-E — Merchant feed:** M3–M4, including O3 product-owned override support plus cache/single-flight/backoff/resource controls.
- **PR-F — Merchant activation + final convergence:** M5 + V1; primarily operational/verification records unless a verified launch defect requires code.

Do not split directly affected tests away from their behavior merely to hit a line target; do split independent subsystems when review/revert boundaries are cleaner.

---

## T1 — Canonical event contracts and dataLayer publisher

**Build:** typed product-impression, selected-variant, Purchase, and event facts plus one browser publisher.

**Acceptance:** upper funnel can represent a product without a selected variant; selected/cart/Purchase events require concrete variant identity; no customer PII; reset ecommerce before every push; publisher never replaces initialized `window.dataLayer`; malformed/unavailable tracking fails closed.

**Verification:** RED/GREEN deterministic mapping, product-vs-variant identity separation, sequential A→B isolation, malformed values, browser unavailable path.

## T2 — Desired tracking configuration and fail-closed deployment interlock

**Build:** validate desired `disabled | preview | live` configuration and future GTM container ID without loading GTM.

**Acceptance:** desired `live` cannot come from Host/query/client input; malformed/missing config fails closed; until T8 artifact exists, requested preview/live produce no GTM load; no new production wildcard/unsafe-eval/Google/TikTok CSP hole in PR-A.

**Verification:** disabled/requested-preview/requested-live config tests, malformed IDs, zero loader/CSP vendor exposure.

## T3 — dataLayer, consent default, and page-view authority — still no GTM loader

**Build:** initialize/queue `dataLayer`, `la_tracking_mode`, consent defaults, and App Router canonical page-view events. Preserve direct Meta mount.

**Acceptance:** deterministic ordering; no GTM script/iframe/network loader; requested preview/live cannot deliver new vendor traffic; consent defaults queued before eventual measurement; exactly one initial/navigation `page_view`.

**Verification:** source/component ordering, one page-view, zero loader, no Meta duplication.

### Checkpoint A

Focused tests + `pnpm typecheck` + `pnpm lint`; security review proves PR-A cannot load GTM in any mode and adds no new third-party network path.

---

## T4 — Product-impression, selected-variant, and canonical cart projection facts

**Build:** expose stable `pancakeProductId` on product/list/detail facts and `pancakeVariationId` on concrete options, server cart mutation lookup facts, and canonical resolved cart/checkout line facts while retaining local variant ID for authorization.

**Acceptance:** one card has product-level identity independent of variant choice; concrete options/mutation snapshots carry variation identity; every analytics-safe resolved cart line carries the actual `pancakeVariationId`; standalone and composite component cart lines preserve the purchased variation external identity; local `VariantMirror.id` remains internal mutation identity only; presentation `kindKey` never becomes external identity; existing price/stock/ambiguity/privacy behavior unchanged.

**Verification:** list/PDP standalone + multi-price + composite projection tests, server cart mutation snapshot identity tests, standalone resolved cart-line external ID, composite component resolved cart-line external ID, and unresolvable/private line that never fabricates an external identity.

## T5 — List/PDP/select events and atomic server-authoritative AddToCart

**Build:** emit upper-funnel events from product facts; add a dedicated atomic PDP `+1` mutation; return canonical committed item snapshot; emit AddToCart from that success payload.

**Acceptance:**

- `view_item_list` contains one item per visible product card, not every variant;
- `select_item` uses clicked product identity;
- initial unselected `view_item` uses product identity;
- exact vendor price/value only when product-level pricing is exact; ranges are not reported as selected exact price;
- PDP add does not reuse absolute `setItemQuantity(..., 1)`;
- absent line commits `0→1`; existing `q` commits `q→q+1` when current stock/bounds allow;
- each successful PDP add returns `previousQuantity`, committed `quantity`, `addedQuantity=1` and authoritative server item snapshot from the same serialized mutation boundary;
- `add_to_cart.quantity = addedQuantity`; no successful no-op/decrease can be mislabeled AddToCart;
- event identity, unit price, name/color/size come only from returned server snapshot; never stale pre-request values;
- snapshot failure emits no canonical tracking but does not roll back an otherwise successful commerce mutation;
- direct Meta delivery semantics remain compatible; any value-source change has regression tests.

**Verification:** multi/equal/no-price products, click-before-selection, absent→1, existing1→2, existing>1 increment, stock-bound failure, **concurrent repeated PDP clicks against the same live cart identity**, stale-browser-price/server-current-price, snapshot failure, failed mutation, no duplicate Meta.

## T6 — Atomic cart delta events, authoritative mutation snapshot, complete cart/checkout projection, and BeginCheckout

**Build:** extend absolute update/remove transaction results so analytics receives committed quantity transitions plus canonical item facts rather than stale UI state; build one pure complete cart analytics projection from current canonical resolved cart/checkout facts for `view_cart` / `begin_checkout`.

Required mutation facts captured **inside the existing cart lock/transaction**:

- any pre-transaction `canSetQuantity` result is advisory only; re-resolve current commerce eligibility and requested-quantity stock sufficiency before accepting the write;
- update success returns `previousQuantity`, committed `quantity`, and bounded canonical item snapshot;
- remove success captures `removedQuantity` and snapshot before delete, and distinguishes already-missing line;
- snapshot includes `pancakeVariationId`, authoritative resolved `unitPriceVnd`, item/product name, color/size where available, plus optional safe product/projection context;
- public action returns only bounded non-PII facts needed for event construction;
- browser derives delta and event payload only from returned committed facts;
- no rendered/client-cached identity/price/name/quantity fallback;
- unsafe snapshot resolution fails tracking closed without changing commerce success/failure semantics.

Required cart/checkout projection contract:

- every non-empty canonical line must have safe `pancakeVariationId`, authoritative non-negative `unitPriceVnd`, positive integer quantity, and item name;
- composite lines use their actual purchased component `pancakeVariationId`;
- projection returns the entire canonical item array plus `currency="VND"` and merchandise value `sum(unitPriceVnd × quantity)`, or returns unavailable;
- **all-or-nothing:** one unsafe/unresolvable/missing-external-ID line suppresses the whole event; do not drop one line, do not report a partial item array, and do not report a partial/rebased total;
- internal local variant CUID is forbidden as a fallback vendor item ID;
- `view_cart` uses the complete projection from current cart truth;
- `begin_checkout` uses the same complete projection only after existing checkout commerce-validity gates pass;
- analytics projection failure never blocks or alters cart/checkout UX.

**Acceptance:** increase → delta AddToCart; decrease/remove → delta RemoveFromCart; same quantity/failure/already-removed/snapshot-unavailable → no fabricated mutation event; fully safe cart → complete `view_cart`; fully safe commerce-valid checkout → complete `begin_checkout`; mixed/unresolvable cart → no whole cart/checkout tracking event; cart/checkout payloads contain no customer PII; shipping/payment milestones remain absent until real accepted states exist.

**Verification:** concurrent absolute updates, concurrent remove/already-removed, same quantity, failed mutation, price/catalog/stock change between pre-check/render and serialized mutation, full remove pre-delete snapshot, enrichment disappearance/snapshot failure, existing cart behavior; standalone safe cart line, composite component safe line, multiple safe lines with exact full merchandise sum, and mixed safe+unresolvable/private/missing-external-ID cart proving **no `view_cart` and no `begin_checkout` event** with no partial totals.

### Checkpoint B

Focused cart/PDP/checkout tests + `pnpm test` + `pnpm typecheck` + `pnpm lint`; review product-vs-variant identity, canonical cart/checkout external IDs, exact full-cart value, committed delta, failure-closed tracking and Meta compatibility.

---

## T7 — Canonical confirmed Purchase

**Build:** vendor-neutral Purchase snapshot from immutable order facts; browser event on existing confirmed-success boundary.

**Acceptance:** only `CONFIRMED`; `transactionId/eventId = publicCode`; item quantities/prices/variation IDs from `OrderLineSnapshot`; mutable catalog enrichment optional and non-authoritative; repeat visit keeps same identity; tracking failures do not alter checkout success.

**Verification:** non-confirmed states, catalog deletion/enrichment loss, money bounds, repeat identity; existing Meta browser+CAPI tests stay green.

## T8 — Immutable GTM version, actual loader/CSP, destination mapping, preview/live gates

**Build:** create/review exact GTM saved version; only then add actual GTM loader and required CSP origins.

**Acceptance:** record container ID + saved version; export exact saved version with immutable repository identity/checksum; every production tag live-gated; GA4 auto/history page views disabled; Ads Purchase uses O1 + `publicCode` + linker; TikTok uses `event_id=publicCode`; preview targets isolated destinations; app preview only after exact export audit; live publishes same reviewed version; later console edit invalidates approval.

**Verification:** static export assertion + version ID + Tag Assistant exact-version preview + GA4 DebugView/test destination + Ads/TikTok diagnostics; prove zero preview traffic to production destinations.

---

## M1 — Read-only Merchant identity, durability and catalog audit

**Delivery status:** **IMPLEMENTATION + OPERATIONAL CLOSURE DELIVERED** via PR #175 (Option B durability), PR #194 (Merchant format validation, manufacturer-MPN audit from mirrored `pancakeDisplayId`, storefront media parity, and read-only ownership regressions), and the authoritative production/current-mirror audit on exact committed SHA `84c99db3de6757c3ded4396644eb4dae25869e09` (tree `ac2e395edafaf5acc83fe98c632145ef7b084aa3`) with CLEAN worktree provenance. ADR 0008 preserves website-owned `VariantMirror.sku`; M1 does not repurpose that field. **Checkpoint D is GREEN / PASSED.** Evidence is recorded in `docs/audits/merchant-identity-m1.md`. That exact-SHA artifact remains historical evidence; current executable M1 metadata reports the U25 override runtime as `IMPLEMENTED` with verdict `NOT_AUDITED_BY_M1` rather than rewriting the historical audit or falsely claiming the runtime is absent.

**Build:** bounded audit over current mirrored catalog.

**Acceptance:** validate format/length for `pancakeVariationId` and standalone `pancakeProductId`; prove durability gate; audit the owner-approved manufacturer MPN from `VariantMirror.pancakeDisplayId` per ADR 0008 without changing local `VariantMirror.sku` ownership; classify composites `COMPOSITE_DEFERRED`; audit price/media/content without PII. The legacy M1 mirror-only summary does not read the U25 `ProductMerchantFacts` rows and must state that limitation explicitly rather than infer or restate apparel values.

**Verification:** missing/duplicate/overlong IDs, missing/blank/malformed/overlong/duplicate manufacturer MPN, local-SKU preservation across Pancake resync, composite deferred, out-of-stock, `PRICE_UNRESOLVED`, malformed text, bounded product-level media parity, **authorized real-catalog evidence attributable to an exact committed post-fix SHA**, and time-separated representative MPN lifecycle evidence.

## M2 — Standalone variant deep link and search contract

**Delivery status:** **IMPLEMENTED AND MERGED** via U12 / PR #180.

**Build:** `/shop/<slug>?variant=<pancakeVariationId>` only for valid current standalone variation.

**Acceptance:** exact preselection/matching price/color/size/image; forged/stale/inactive/private/composite query cannot expose unauthorized option; base PDP canonical/search exposure remains authoritative; variant query does not independently enable indexing.

**Verification:** valid/stale/forged/composite-rejected tests + browser regression + SEO canonical/query regression. PR #180 exact-head evidence is recorded in the merged PR; integrated M2 compatibility is also covered by `docs/audits/wave-2-checkpoint-b.md`.

### Checkpoint D

**GREEN / PASSED.** The authoritative exact-tree M1 audit on `84c99db3de6757c3ded4396644eb4dae25869e09` confirms intended standalone identity/MPN/media/composite readiness for this checkpoint, while PR #175 supplies external-ID durability and U12 / PR #180 supplies standalone deep-link/addressability evidence. Composite inventory remains intentionally absent from Merchant v1. **M3 is delivered by U25 and M4 by U26 / PR #198. M5 retains its own feed-safety, O2/activation and approval gates.**

---

## M3 — Standalone Merchant mapper and diagnostics

**Delivery status:** **IMPLEMENTED** via U25. `src/commerce/merchant-offer-mapper.ts` is the pure mapper, `merchant-offer-repository.ts` is its bounded canonical loader, `merchant-apparel-facts.ts` owns the ADR 0007 resolution, and `product-merchant-facts-{admin,repository}.ts` plus the product-editor panel own the website-owned override. No public feed route, serializer or cache exists: those stay with M4. **O2 is still unapproved**, so the mapper reports `market: UNRESOLVED` with `activationBlockedReasons: ["MERCHANT_MARKET_UNRESOLVED"]` and emits `priceVnd` rather than a currency-qualified Merchant `price`; Merchant activation stays blocked. The mapper accepts no caller-supplied market authority: a future O2 approval must enter through one reviewed trusted configuration source.

**Build:** add the local product-owned O3 override support required by ADR 0007, then map canonical standalone product/variation facts into Merchant offers. Keep the actual offer mapper pure; persistence/admin concerns must not leak Pancake-mirror ownership into mapping logic.

**Acceptance:** stable audited ID/grouping, `brand=LA Clothing`, audited MPN from `VariantMirror.pancakeDisplayId` per ADR 0008, no inferred GTIN, canonical price, trusted image and exact deep link; apparel `title`/`description`/`color`/`size` are XML-safe and inside current Merchant bounds, with required color/size failing closed rather than being omitted; O2 remains an explicit activation gate and, until owner approval exists, market is unresolved, no currency-qualified Merchant `price` is emitted, and caller/request data cannot create an approved market; Merchant activation itself still requires approved O2; O3 resolves as `explicit product override → approved male/adult/new shop default`; override values are restricted to reviewed Merchant enums, clearing means inheritance, Pancake sync cannot erase local overrides, and no heuristic/text/model inference is allowed; malformed/unavailable apparel policy or override data fails closed with a bounded `APPAREL_FACT_UNRESOLVED`-class diagnostic; zero-stock remains `out_of_stock`; unsafe/unresolved/composite rows are excluded with bounded reasons.

**Verification:** normal variant, out-of-stock, missing content, invalid manufacturer MPN, price/media mismatch, composite exclusion; exact Merchant title/description/color/size boundary and overflow/malformed cases; caller-supplied syntactically valid market cannot bypass unresolved O2; inherited O3 defaults, each independent override, mixed overrides, clearing back to inheritance, invalid override values, Pancake-resync preservation and fail-closed unresolved apparel facts; current M1 metadata states U25 runtime implementation without pretending legacy M1 audits product overrides; promotion reads prove bounded 200-variant batching rather than a false constant-round-trip invariant.

## M4 — Cached, single-flight, backoff-protected bounded serializer and public Merchant route

**Build:** standards-aware serializer + fixed public GET `/feeds/google-merchant` route + complete-feed success cache + fixed-key failure backoff.

**Acceptance:**

- heavy generator bounded by 5,000 offers and ≤8 DB round trips;
- serializer counts UTF-8 bytes incrementally and aborts before >16 MiB;
- complete successful result cached 300 seconds under fixed shop/schema key;
- `MERCHANT_FEED_FAILURE_BACKOFF_SECONDS=60`;
- repeated success-cache hits do not re-run DB-heavy generation;
- concurrent cold requests are single-flight for current one-app-service topology;
- first failed/overflow heavy attempt installs bounded non-sensitive 60s failure sentinel;
- sequential/concurrent GETs during active failure backoff return cheap bounded `503`/`Retry-After` with zero heavy regeneration;
- backoff expiry permits one single-flight retry;
- failure sentinel never overwrites/corrupts a valid complete success-cache entry;
- if deployment changes to multiple app replicas, activation is blocked until shared cross-replica cache/single-flight/backoff protection is proved;
- failed/overflow generation never publishes/caches partial output;
- correct content type and safe escaping/Unicode/control chars;
- route cannot become arbitrary shop/source URL fetch or expensive query API;
- envelope overflow returns non-success, never partial/truncated 200.

**Verification:** parse output; limit/limit+1; byte boundary/overflow; malformed URLs/text; deterministic order; query budget; success miss/hit; concurrent cold requests; TTL-expiry concurrency; query-string noise; sequential failure backoff; concurrent failure; backoff-expiry single retry; success-cache/failure-sentinel isolation; real Next runtime status/content type/complete body/cheap repeated failure.

---

## M5 — Merchant Center Scheduled Fetch activation

**Build/ops:** verify/claim site, configure data source, O2 market, shipping/returns and Ads linkage; point Scheduled Fetch to production HTTPS feed.

**Acceptance:** highest practical account-supported schedule; Merchant Automations reviewed and price/availability/condition correction off until exact variant structured data is proven; Google can fetch landing pages/images while `SEARCH_INDEXING_ENABLED=false` remains unchanged.

**Verification:** Merchant Latest update/Diagnostics for in-stock/out-of-stock/variant records; crawler/landing checks; no composite v1 expectation.

---

## V1 — Final convergence, review and rollback gate

**Verification on exact implementation head:**

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:db`
- `pnpm build`
- `pnpm release:check`
- applicable browser/runtime suites
- exact GTM container/version/export record + Tag Assistant + GA4 + Ads + TikTok diagnostics
- Merchant cache/backoff/fetch/diagnostics/crawler checks
- verify production topology still matches single-app-service cache/single-flight/backoff assumption; otherwise require shared cross-replica protection before Merchant activation

Final review order: correctness → security → architecture → simplicity → performance. Re-check Definition of Done, rollback for GTM delivery and Merchant data source, PII/secret boundaries, and `SEARCH_INDEXING_ENABLED=false` unless separately approved.

## 7. TDD rule

For every behavior change: add the smallest discriminating RED test, implement minimum GREEN behavior, run focused suite, then refactor only within scope. Existing already-green behavior is baseline evidence, not a fake new RED.

## 8. Source-driven checks during `/build`

Re-check current official docs for Next.js 16.2.x Route Handler/cache/CSP behavior; GTM preview/version/export/consent APIs; GA4 ecommerce item requirements/page-view semantics; Google Ads conversion/linker behavior; TikTok GTM/dedup; and Merchant identity/variant/landing/data-source requirements. Version-sensitive APIs must not be implemented from memory.

Do not enable Cache Components merely to implement M4. If the source-verified chosen cache mechanism cannot satisfy the tested success-cache, single-flight and failure-backoff contract, stop and choose the smallest alternative rather than weakening the requirement.

## 9. Explicitly deferred

- Meta migration into GTM.
- Meta delivery-system migration / Catalog-specific ID redesign without verified Catalog/Pixel/feed evidence. Direct funnel CAPI is implemented under ADR 0015.
- TikTok Events API.
- Google Enhanced Conversions / hashed customer PII.
- Merchant API realtime sync.
- Composite Merchant offers/item-group design.
- Visible consent UI/default-denied policy.
- Search-indexing/permanent-domain change.
- Unrelated SEO/catalog/admin refactor.

## 10. Human approval gate

Before `/build`, reviewer approves this task split, two-level product/variant identity contract, dedicated atomic PDP increment semantics, authoritative mutation event snapshots, **complete all-or-nothing cart/checkout external-ID projection**, GTM no-load-until-T8 interlock + immutable version workflow, standalone Merchant identity/durability gate, composite Merchant deferral, Merchant success-cache/single-flight/failure-backoff/resource envelope, owner gates O1–O4 or their continued activation block, and PR slicing.

Approval authorizes implementation work only. It is not approval to publish GTM tags, enable Merchant listings/campaigns, change consent defaults, or enable search indexing.
