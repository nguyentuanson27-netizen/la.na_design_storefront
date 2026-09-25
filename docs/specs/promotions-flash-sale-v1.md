# Spec — Promotions & Flash Sale v1

Status: approved product requirements consolidated into an implementation-ready specification. This feature is website-owned: Pancake remains the source of catalog, inventory, and base-price facts, while promotional pricing and campaign lifecycle are owned by LA Clothing.

Planning/review base: `main@323c07cf25c834e36e4a43952df3f0ee7321d756` after merge of PR #152 (SEO/GEO audit) and PR #153 (marketing analytics + Google Shopping planning).

## Objective
Add an admin-managed promotion system that can run regular promotions and flash sales across products or individual variants, render one authoritative effective price consistently across storefront → cart → checkout → order snapshot → Pancake submission, and preserve trustworthy immutable pricing/audit facts once an order is finalized.

The feature must not write promotional catalog prices back to Pancake.

## Current-system constraints
- Catalog and inventory are mirrored from Pancake through `ProductMirror` / `VariantMirror`.
- `VariantMirror.pancakeRetailPrice` is the website base-price input.
- `VariantMirror.pancakeRetailPriceAfterDiscount` remains mirrored external data but is not authoritative for website promotion pricing.
- The current checkout architecture may create an `OrderMirror` in `DRAFT` before Pancake submission. This spec keeps that architecture.
- Current order submission fetches fresh Pancake catalog facts before create-order. Promotion implementation must feed any fresher trusted base fact into the same central effective-price resolver rather than compare a website sale snapshot directly with raw Pancake retail.
- Pancake create-order structurally accepts integer `variation_info.retail_price`; current repository evidence proves the field shape, not semantic acceptance of arbitrary website-owned discounted values.
- PR #152 added `docs/audits/seo-geo-audit.md` as a planning input. Its W3/W4 constraints are binding inputs to promotion rollout and SEO convergence where called out below.
- PR #153 is now a binding planning dependency at shared seams: unselected product analytics identity uses `pancakeProductId`; concrete selected/committed variant identity uses `pancakeVariationId`; Purchase transaction/event identity uses `OrderMirror.publicCode`; cart mutation/event snapshots are server-authoritative; and M2 owns the standalone variant deep-link/preselection/canonical-query contract. Promotion work may adapt current implementation ownership when `main` evolves, but must not silently replace these reviewed contracts.
- PR #153 Merchant M4 owns the fixed-key complete-success cache/single-flight/60-second negative-backoff envelope. Promotion adds price-transition and mutation invalidation requirements to that same cache domain; it does not create a second Merchant cache or request-controlled cache dimension.
- Promotion v1 also owns one durable server-side **promotion pricing revision**, stored as a non-negative `BigInt`/equivalent monotonic integer. Every successful publish/re-enable/Disable/end-early/Scheduled material edit that can change current or future Merchant-visible promotion pricing must advance that revision **inside the same database transaction** as the campaign mutation. A best-effort post-commit callback, `after()`, fire-and-forget task, or external event is not a correctness mechanism for Merchant freshness.

## Campaign model
A campaign has one shared rule across all targets:
- kind: `PROMOTION`, `FLASH_SALE` or `CLEARANCE`;
- name;
- discount type: `PERCENTAGE` or `FIXED_PRICE`;
- one discount value;
- one time configuration;
- one or more targets spanning products and/or variants.

Target semantics:
- `PRODUCT` is a semantic scope over the product's current variants, including variants synced/restored later.
- `VARIANT` targets one concrete variant.
- A campaign may target multiple products and variants across products.
- Duplicate targets are invalid.
- A campaign cannot target PRODUCT A and separately target a variant already covered by A.
- Different discount values require different campaigns.

Do not materialize PRODUCT coverage into a frozen variant list.

`CLEARANCE` ("Xả hàng lẻ size", owner decision on PR #79):
- A manual merchandising choice of **which products appear on `/sale/xa-hang-le-size`**. Choosing a product asserts nothing about its stock.
- Prices, validates, conflicts and audits exactly like `PROMOTION`: no window is required, it takes the same `PERCENTAGE`/`FIXED_PRICE` discount, and it follows the same target rules (PRODUCT and VARIANT targets are both valid). The overlap rule applies across kinds, so a variant covered by a `CLEARANCE` and another campaign is a conflict and resolves to base.
- It persists through checkout and order provenance as `promotionKind = CLEARANCE`, like the other kinds.
- It is its own kind only so the storefront can list it separately and consider the stock-proven tag below.

## Explicit v1 bounds
These are server-authoritative limits, not UI hints:
- `MAX_CAMPAIGN_NAME_LENGTH = 120` JavaScript string code units after trim; empty names are invalid.
- `COPY_NAME_SUFFIX = " - Bản sao"`.
- `MAX_TARGETS_PER_CAMPAIGN = 200` normalized explicit target rows.
- `MAX_PROMOTION_IDENTIFIER_LENGTH = 128` browser-supplied campaign/product/variant identifier code units before lookup.
- `MAX_ADMIN_PROMOTION_PAGE_SIZE = 50`.
- `ADMIN_TARGET_SEARCH_LIMIT = 50`.
- `MAX_RENDERED_QUOTE_PROOF_BYTES = 16 * 1024` ASCII/base64url bytes before verification/decoding. This is sized for the current anonymous-cart cap of 50 distinct items; if that cart bound changes, P9a must re-prove the token envelope before merge rather than silently raising/unbounding it.
- Public product-list page size reuses existing max `48`.
- Public page input reuses `STOREFRONT_DISCOVERY_LIMITS.page = 10_000`.
- Storefront repositories must also preserve the existing `MAX_STOREFRONT_OFFSET = 50_000` guard; page parsing alone is not sufficient.
- `MAX_EXPANDED_VARIANTS_PER_CAMPAIGN = 2000` unique current affected variants for activation/re-enable/Scheduled-edit coverage validation.

Bounds behavior:
- syntactically oversized names/IDs/explicit target arrays are rejected before persistence, including Draft;
- rendered-quote proof input larger than `MAX_RENDERED_QUOTE_PROOF_BYTES` is rejected before decode/MAC verification and follows the normal refreshed-quote/no-submit failure path;
- Draft PRODUCT health may probe expansion with at most `MAX_EXPANDED_VARIANTS_PER_CAMPAIGN + 1` rows and report typed `TARGET_EXPANSION_LIMIT_EXCEEDED`;
- publish, re-enable, and Scheduled material edits fail atomically with `TARGET_EXPANSION_LIMIT_EXCEEDED` when current expansion exceeds `2000`;
- the `2000` cap protects expensive coverage validation and variant lock-set work only;
- an already-Active PRODUCT target that later grows beyond `2000` is not invalid merely because of the cap;
- **Disable/end-early must remain available even when current expansion is above `2000`** and must not require expanding/locking the whole variant set;
- **Copy must remain available from every lifecycle state even when current expansion is above `2000`**; it copies campaign fields plus explicit target rows into a Draft, then Draft health may report expansion-limit invalidity;
- all named bounds require max/max+1 tests.

For `/flash-sale`, use the same bounded storefront page/offset contract as `/shop`. With current page size `48` and `MAX_STOREFRONT_OFFSET=50_000`, a page whose computed offset exceeds `50_000` must fail before the expensive listing query. Current boundary example: page `1042` gives offset `49,968`; page `1043` gives `50,016` and must be rejected for a 48-item page.

## Persistence
Website-owned VND money uses integer storage:
- percentage value: integer;
- fixed sale price: `BigInt`/integer VND;
- target row: exactly one of product/variant populated;
- final order audit money: `BigInt`/integer VND.

The mirrored Pancake price columns remain external `Float?` facts. This feature does not convert them to `BigInt`; trusted integer-VND validation occurs at the website pricing boundary.

Database/server invariants must enforce target shape, campaign relationships, duplicate prevention, additive order-audit integrity, and one durable bounded-cardinality promotion-pricing revision rather than relying on UI checks. The revision may use a singleton row/equivalent additive persistence shape, but it must be transactionally advanceable with effective campaign mutations and readable independently by Merchant cache validation.

No campaign delete action in v1.

## Campaign lifecycle
Persist enough intent/history to distinguish:
- Draft vs Disabled-before-activation;
- never Active vs Active at least once;
- terminal Disabled/Ended after activation.

This must remain correct after restart and when a scheduled active window opens/closes with zero traffic. Never define “ever Active” using a lazy observation write that only happens when a request sees the campaign Active.

Admin-visible statuses:
- `Draft` — explicit work-in-progress, not enabled.
- `Scheduled` — enabled/valid, effective start in future.
- `Active` — enabled/valid and server `now` is inside effective interval.
- `Ended` — campaign crossed a non-empty enabled active interval and its configured window ended.
- `Disabled` — explicitly disabled by admin.

Lifecycle rules:
- Draft is editable and may be business-invalid, but never storefront-effective.
- Scheduled is editable only through an atomic revalidation that leaves the enabled definition valid/non-overlapping and within coverage bounds.
- Disabled-before-Active is editable/re-enableable after full activation validation.
- Active cannot materially change targets, discount, or pricing/time behavior; disable/end early then Copy → Draft for a new run.
- Disabled-after-Active and Ended are terminal/read-only except Copy.
- All states support Copy.

Re-enable of a never-Active Disabled campaign atomically writes a fresh `enabledAt`, sets enabled state, and clears `disabledAt=null`. A campaign whose prior enabled interval contained Active time cannot take this path.

### Copy naming and behavior
Copy always succeeds as a bounded source-snapshot operation when the source campaign/explicit target rows themselves satisfy syntactic storage bounds; it does not require expanding PRODUCT coverage.

Copy:
- creates a new campaign ID in `Draft`;
- copies kind, discount type/value, explicit target rows, and time configuration;
- does not copy runtime status/history/orders/source identity;
- revalidates health before the copy can be enabled;
- computes the name deterministically with the exact suffix `COPY_NAME_SUFFIX`.

Copy-name algorithm:
1. normalize/trim the source name;
2. reserve `COPY_NAME_SUFFIX.length` code units inside the 120-code-unit limit;
3. truncate the source prefix to the remaining code-unit budget **without splitting a UTF-16 surrogate pair**;
4. if avoiding a surrogate split shortens the retained prefix by one code unit, that unused code unit is allowed; do not backfill it with part of another code point;
5. append `COPY_NAME_SUFFIX` exactly; do **not** `trimEnd()` after the length budget is computed, because the suffix begins with a deliberate leading space and trimming/re-expanding would make the boundary algorithm ambiguous;
6. assert final name is non-empty and `<= 120` code units.

Repeated Copy applies the same algorithm to the immediate source name. It may therefore produce repeated visible copy suffixes when they fit; it must never fail solely because a valid source name was already 119/120 code units.

Required tests include source names at 119 and 120 code units, a surrogate-pair boundary, trailing-space normalization before budgeting, and Copy-of-Copy.

## Scheduling and time
Admin displays/accepts time in `Asia/Ho_Chi_Minh`; database stores UTC instants.

Intervals are half-open `[startsAt, endsAt)`:
- start inclusive;
- end exclusive;
- B may start exactly when A ends.

For overlap math:
- null start = `-∞`;
- null end = `+∞`.

Regular Promotion allows null/null, start/null, null/end, or both with `endsAt > startsAt`.

Flash Sale requires both start/end and `endsAt > startsAt`.

Server time is authority. Client countdowns are presentation only.

## Pricing contract
### Base price
`pancakeRetailPrice` is the only Pancake field used as website promotional base in v1.

```ts
function isUsableBasePriceVnd(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value > 0;
}
```

Null, NaN, infinity, fractional, non-positive, or unsafe-integer values are unusable for authoritative website pricing. This is a website-wide commerce money rule, not only a promotion check: unusable base means `BASE_PRICE_UNAVAILABLE` and the variant cannot complete website purchase.

### Mandatory Pancake catalog evidence before resolver rollout
PR #152 W3 identified the current equality-gated sale-price behavior as a commerce/SEO correctness gap and requires evidence rather than guessing upstream semantics.

Before P6 removes the current `retailPrice === retailPriceAfterDiscount` availability gate:
1. run the existing read-only `pnpm pancake:catalog:audit` against the approved real catalog context;
2. record sanitized counts/examples where `pancakeRetailPriceAfterDiscount` differs from `pancakeRetailPrice`, including lower values;
3. verify/document Pancake semantics for those fields from approved integration evidence;
4. verify the impact of the website-owned pricing decision on currently visible/purchasable variants;
5. if evidence materially contradicts the approved ownership assumptions, stop and return to product review rather than silently changing pricing authority.

This evidence gate does **not** by itself make `pancakeRetailPriceAfterDiscount` authoritative. Under the currently approved v1 decision, website pricing still uses `pancakeRetailPrice` + website campaign state.

### Pre-rollout money-data audit
Before activation, report counts/examples for mirrored base values that are:
- null;
- zero;
- negative;
- non-finite if application memory can receive them;
- non-integer;
- outside JS safe-integer range.

Explicitly account for any currently visible variant that becomes unavailable under the positive-safe-integer rule.

### `pancakeRetailPriceAfterDiscount` ownership clarification
This field must not:
- determine storefront effective price;
- cause `PRICE_UNRESOLVED` merely because it differs from base;
- override website campaign state;
- become final order authority.

Therefore, with no active website promotion, the website may intentionally display/charge `pancakeRetailPrice` even when Pancake reports a lower `pancakeRetailPriceAfterDiscount`. That consequence is deliberate and must remain visible in rollout evidence. Pancake downstream repricing risk is separately covered by the controlled custom-price acceptance gate.

### Latest trusted base
Storefront/cart use latest successfully mirrored base. If checkout gets a fresher trusted Pancake base:
- feed it into the same central resolver;
- `%` recalculates;
- FIXED_PRICE remains configured final price but is revalidated against fresher base;
- if buyer-confirmed quote changes, return `PRICE_CHANGED` before create-order;
- refreshed quote must be able to replace mutable DRAFT facts so stale mirror data cannot create an infinite loop.

### Central effective-price authority
One semantic resolver supplies storefront, cart, checkout, order audit, structured data when representable, analytics, and final Pancake line mapping.

Conceptual output:
- `basePriceVnd`;
- `effectivePriceVnd`;
- `isDiscounted`;
- nullable promotion ID/name/kind/type/value;
- start/end facts;
- typed reason such as `BASE_PRICE_UNAVAILABLE`, `PROMOTION_INVALID`, `PROMOTION_CONFLICT`;
- per-variant transition fact for presentation refresh.

Rules:
- no valid active campaign → effective = base;
- valid active campaign → website-owned effective price;
- never stack campaigns;
- browser price is never authority;
- >1 applicable campaign candidate on a variant = conflict → no website promotion for that variant;
- no independent promotion arithmetic in UI/cart/checkout/SEO/analytics/Pancake modules.

Prefer one reusable TypeScript/domain resolver. One sanctioned SQL pricing/membership projection is allowed where pre-pagination bounded listing behavior requires it; it is a projection of the same contract and requires SQL↔TS parity tests.

### Percentage
- integer percentage `1..99`;
- exact positive-integer rational arithmetic; floating `Math.round(base * multiplier / 100)` is not normative over the full safe-integer domain.

```ts
const numerator = BigInt(baseVnd) * BigInt(100 - percent);
const effectiveBigInt = (numerator + 50n) / 100n;
const effectivePriceVnd = Number(effectiveBigInt);
```

Convert back to `number` only after asserting positive safe integer. Require `0 < effective < base`.

Sanctioned SQL must cast validated integer-like base to PostgreSQL `numeric` **before** multiplication/division and match the same exact rational result.

Mandatory TS + SQL parity:
- `150 @ 1% → 149`;
- `350 @ 1% → 347`;
- `110 @ 5% → 105`;
- `9007199254740989 @ 1% → 8917127262193579`.

Low-price rounding may invalidate only an affected variant, e.g. `50 @ 1% → 50` is not a discount.

### Fixed price
`FIXED_PRICE` is final customer unit price, not amount-off.

For every affected variant: integer VND and `0 < fixed < base`.

A PRODUCT fixed-price target uses the same configured final price for every covered variant that remains valid at runtime.

## Draft / publish / enabled mutation validation
Draft save:
- may persist incomplete/business-invalid configuration;
- surfaces typed health errors;
- never affects storefront.

Publish Draft, re-enable never-Active Disabled, and Scheduled material edit:
- validate all current affected variants;
- reject unusable base;
- reject invalid discount/time/target shape;
- reject overlap;
- reject expansion >2000;
- execute atomically under concurrency controls;
- atomically advance the durable promotion pricing revision in the same transaction on successful effective mutation.

**Disable/end-early is different:** it does not need to prove pricing coverage or acquire the expanded variant lock set. After authenticating/authorizing and locking the campaign row, it must be able to disable the campaign in bounded work even if PRODUCT coverage is currently >2000. A successful Disable/end-early still advances the durable promotion pricing revision in the same campaign transaction. Rollback safety takes precedence over re-running activation validation.

**Copy is different:** copy snapshots campaign fields + explicit target rows only. It does not expand PRODUCT coverage or reject because current coverage is >2000; resulting Draft health may report expansion-limit invalidity. Copy does not advance the promotion pricing revision merely by existing as Draft.

## Overlap and concurrency
No overlapping enabled campaigns may apply to the same effective variant, including future Scheduled intervals:
- PRODUCT↔PRODUCT;
- PRODUCT↔VARIANT;
- VARIANT↔VARIANT.

Disabled campaigns do not reserve intervals.

UI prechecks are insufficient. Publish/re-enable/Scheduled edit must be transaction/race-safe. For coverage-validating mutations, use deterministic lock ordering; exact implementation is in the plan.

Same-campaign edits must not lost-update.

## Runtime catalog mutation
PRODUCT targets dynamically include new/restored/re-associated variants.

### Runtime target invalidation
Same semantics for `%` and `FIXED_PRICE`:
- never apply invalid promotion to the offending variant;
- VARIANT target loses promotion for that variant only;
- PRODUCT target becomes `PARTIALLY_INVALID` when only some covered variants fail; healthy siblings continue;
- admin health identifies affected variant/reason;
- recovery is automatic if the variant becomes valid again during the campaign interval.

For PRODUCT FIXED_PRICE, activation still validates **all current variants**. Partial fallback applies only to later runtime catalog/base drift or newly covered variants; this explicitly supersedes the earlier wholesale-runtime-invalidation draft.

If base itself becomes unusable, variant is `BASE_PRICE_UNAVAILABLE` and non-purchasable.

### Runtime overlap discovered after catalog mutation
Fail closed:
- never stack/choose arbitrary winner;
- conflicted variant gets no website promotion;
- healthy non-conflicted variants continue;
- admin health shows all conflicting campaign IDs/targets;
- automatic recovery when conflict disappears.

## Admin UX
Primary editor: `/admin/promotions`.

Required:
- list Promotion/Flash Sale campaigns;
- create/edit when lifecycle allows;
- publish/re-enable/disable/copy;
- multi-product/multi-variant target search with bounded results;
- Draft/Scheduled/Active/Ended/Disabled status;
- healthy/partially-invalid/conflicted health;
- typed errors including overlap, base unavailable, discount/time invalid, bounds/expansion limit, activation disabled.

Product admin pages only show related current/upcoming campaigns + link to central editor.

All mutations use existing admin authentication **and authorization**, server validation, and bounded input.

## Storefront UX
Regular promotion:
- struck base price;
- emphasized effective price;
- sale badge.

Flash Sale:
- sale treatment;
- `FLASH SALE` badge;
- countdown to `endsAt` while active.

Xả hàng lẻ size (`CLEARANCE`):
- sale treatment and discount badge, exactly as a regular promotion;
- the `Lẻ size - Chỉ còn ít` tag, **only when stock proves it** (owner decision on PR #79). Campaign membership is necessary but not sufficient. Using the canonical per-variant sellability answer: at least one size is sold out (every colour of that size refused for `OUT_OF_STOCK`, as the `Hết hàng` label reads it; one sold-out colour of a size that still sells in another colour does not count), at least one size is still for sale from ready stock with none on `Đặt trước`, and the ready pieces left across the sizes still for sale total fewer than **10**. Otherwise the card shows the discount badge only;
- shown on the sale listings, which know the representative campaign kind; other listings show the discount badge only.

Sale sub-listings (PR #79): `/sale` lists every kind; `/sale/uu-dai`, `/sale/flash-sale` and `/sale/xa-hang-le-size` narrow membership, pricing, tracking and refresh to `PROMOTION`, `FLASH_SALE` (with the full-window invariant below) and `CLEARANCE` respectively. A card on a sub-listing never shows a discount from another kind.

Dedicated `/flash-sale`:
- only products with >=1 currently purchasable variant under valid active `FLASH_SALE`;
- excludes regular-only/Scheduled/Ended/Disabled/invalid/conflicted candidates;
- uses the same bounded pre-pagination pricing/membership projection as `/shop`;
- reuses storefront page input and offset guards.

### Product-card representative
Normal listing:
1. consider currently purchasable promoted variants;
2. choose lowest effective price; stable repository order/ID tie-break;
3. strike base of that same representative;
4. badge/countdown from representative campaign;
5. use `Từ <sale price>` only when representative sale price is also product minimum current effective price;
6. if a cheaper unpromoted variant exists, use explicit sale wording such as `Sale từ <sale price>` without implying product-wide minimum;
7. if no promotion, preserve normal base-price behavior.

`/flash-sale` applies the representative rule only among valid active Flash Sale variants.

PDP resolves exact selected variant. Composite rendering follows the real selected `VariantMirror.id` and owning `productId`; parent-page placement does not transfer PRODUCT-campaign ownership.

## Storefront time/freshness contract
One server `requestNow` must drive all reads/projections in one render.

For paginated routes, transition discovery is query-wide before pagination where membership/order can change:
- `/shop` includes off-page candidates whose promotion boundary may change filter/sort/page membership;
- `/flash-sale` includes upcoming enabled Flash Sale boundaries even if current page is empty.

Server computes relative `refreshAfterMs` from `requestNow` and earliest relevant transition, capped at `60_000`; no known transition also uses `60_000` fallback.

Client:
- schedules from relative delay, not browser wall-clock comparison to an absolute server timestamp;
- calls `router.refresh()` when due;
- on `visibilitychange` to visible or `pageshow`, refreshes immediately if the server-provided delay elapsed while suspended;
- never treats countdown/cache as transaction authority.

Visible-page promotional display staleness must not exceed 60s. Add-to-cart/cart/checkout always re-resolve server-authoritative pricing with no grace period.

## Cart, checkout, order
Cart does not lock promotional price. Cart/checkout display current server quote.

### Stage 1 — rendered checkout → DRAFT
Checkout render must create a **server-verifiable rendered-quote proof** for bounded non-PII quote facts sufficient to prove what this cart/checkout instance showed the buyer. The browser may echo the opaque proof; it must not be able to forge or replace the old quote with the current quote.

V1 proof is deliberately **stateless**. It uses a standard-library server-only HMAC/MAC over canonical bounded payload bytes; it does not create quote-proof rows, nonce tables, or append-only proof state. The implementation may derive a domain-separated quote-proof key from an existing validated server-only secret or use a dedicated validated server-only secret if current configuration ownership requires it, but the key source is explicit, never client-visible, and no new third-party dependency is needed.

The current anonymous cart UUID lives in an HttpOnly cookie and must remain server-only proof context. The proof may be *bound* to that cart identity by including the server-read cart ID in the MAC input, but the raw cart UUID itself must **not** be serialized into the browser-visible token/payload or any client-readable field.

The proof contract is deliberately separate from pricing authority:
- canonicalize browser-visible proof payload from the canonical rendered quote facts (variant IDs, quantities, effective unit prices, merchandise subtotal, shipping, total, and a server issue/version fact);
- bind the MAC to the current anonymous cart/checkout identity as server-only context in addition to those payload bytes; do not expose the raw HttpOnly cart ID in token bytes;
- sign/authenticate those canonical bytes/context with the server-only MAC key; no unsigned hidden field and no server-stored nonce/version record proves what the buyer saw;
- reject proof strings above `MAX_RENDERED_QUOTE_PROOF_BYTES` before decode/verification;
- keep the proof bounded and non-PII; do not put customer address/phone/secrets/session handles into the token/logs;
- use constant-time MAC comparison where the runtime primitive supports it;
- verify authenticity/binding before using the proof for stale detection;
- missing, oversized, malformed, forged, wrong-cart, or otherwise unverifiable proof fails closed as `PRICE_CHANGED` (or a narrower typed quote-proof error rendered with the same refreshed-price/no-submit behavior), returns a fresh server-issued proof, creates no submit-capable DRAFT, enters no `POS_SUBMITTING`, and performs no Pancake write;
- after proof verification, the server still recomputes current authoritative pricing; the proof can only establish the previously rendered quote, never authorize price.

On submit:
- server verifies the rendered-quote proof against the current server-read cart identity and recomputes current authoritative quote before creating submit-capable DRAFT;
- verified rendered quote != current quote → typed `PRICE_CHANGED`, refreshed lines/totals + fresh proof, no Pancake write, explicit resubmit required;
- browser values never calculate authoritative price.

Required cases:
- buyer saw 400k → promotion expires → first submit returns 500k/no POS write + fresh proof → buyer must explicitly confirm again;
- buyer saw 400k → promotion expires → client tampers hidden/rendered quote to 500k but reuses/forges proof → cannot bypass reconfirmation;
- proof from a different cart/checkout instance cannot authorize this cart;
- decoding/inspecting the browser-visible proof never reveals the raw HttpOnly cart UUID;
- proof at `MAX_RENDERED_QUOTE_PROOF_BYTES` follows normal verification; `max+1` is rejected before decode/MAC work.

### Stage 2 — DRAFT → fresh Pancake
Fresh Pancake catalog validation may expose a newer base.

If fresh effective quote differs from mutable DRAFT:
- atomically refresh DRAFT line/audit/totals;
- return `PRICE_CHANGED`;
- remain out of `POS_SUBMITTING`;
- require explicit resubmit;
- repeated upstream drift repeats the handshake without stale-mirror infinite loop.

When current DRAFT matches fresh authoritative quote, pricing becomes immutable no later than guarded transition out of DRAFT toward POS submission.

Finalized snapshots never change after campaign/catalog mutations.

## Final order-line audit
Each finalized line stores:
- `baseUnitPriceVnd`;
- final `unitPriceVnd`;
- `lineTotalVnd`;
- nullable promotion ID;
- promotion name snapshot;
- kind;
- discount type;
- percentage or fixed value as applicable.

Promotion fields are null when no website promotion applied.

## Pancake order submission
Intended final `variation_info.retail_price` is immutable final local `OrderLineSnapshot.unitPriceVnd`.

Fresh Pancake validation may verify shop/variation identity/stock. Any fresher base affecting customer price must first go through central effective-price/`PRICE_CHANGED` logic.

`createPancakeOrderSubmissionService` must close all three current raw-live-price assumptions:
1. **Comparison:** compare buyer-confirmed/final snapshot with freshly recomputed **website effective quote**, not raw Pancake base.
2. **Totals:** validate subtotal/shipping/total from authoritative effective/final line values, not raw live base.
3. **Request:** build request line price from immutable finalized `unitPriceVnd`; mapper must not replace it with raw live retail.

Independent integration regressions must fail if any one of those remains on raw `livePrice`.

### Controlled Pancake semantic acceptance gate
Before real discounted activation:
1. unit/integration tests prove mapper uses immutable final snapshot;
2. in an explicitly authorized non-destructive/test context, submit a line price different from catalog base;
3. verify Pancake accepts/preserves it without silent reprice/reject;
4. preserve existing one-shot/idempotency safety; no blind retries;
5. record sanitized evidence.

If semantic acceptance cannot be proven, activation gate remains off.

## SEO/GEO, analytics, and Merchant convergence
PR #152's audit and PR #153's reviewed analytics/Merchant contracts are binding inputs, not optional background.

### W3 integration
Before removing the current equality gate, complete the Pancake catalog evidence step described above. Promotion implementation must not claim the upstream sale-price semantics are verified merely because product ownership chose website-owned pricing.

### W4 structured-data constraint
Promotion pricing must not force inaccurate variant schema.

Rules:
- when the **current valid SEO contract** can truthfully emit an `Offer`, that Offer price uses the same authoritative effective customer price;
- if current variant identity/URL/preselection/canonical contracts cannot represent different variant prices accurately, structured data stays fail-closed/omits the unsupported Offer shape rather than inventing a misleading single price;
- do **not** use `AggregateOffer` to represent a set of product variants;
- `ProductGroup` / per-variant `Product` + `Offer` is not implemented by this feature unless its prerequisites from PR #152 are separately satisfied: verified variant identity → distinct deep-link URL + preselection → query/canonical contract → markup → HTTP/Rich Results verification;
- promotion work must not silently pull that SEO variant-discoverability project into scope.

Analytics monetary events use effective/final customer price. Purchase reporting uses immutable final order snapshot. GTM/TikTok/Meta integrations consume central quote/snapshot and do not reimplement promotion arithmetic.

Before G1 implementation, re-read then-current `main` to verify where the already-reviewed #153 identity/cart/analytics/Merchant contracts are implemented. Runtime module/file ownership may move, but the #153 contracts remain binding unless a separately reviewed change supersedes them; do not rediscover or redefine them ad hoc.

### Merchant success-cache convergence
When Merchant is enabled with promotions:
- #153's `MERCHANT_FEED_CACHE_TTL_SECONDS = 300` is a **maximum normal success TTL**, not a guarantee that a success body remains valid for all 300 seconds;
- known promotion start/end boundaries cap effective success-cache expiry to the nearest relevant transition, or use an equivalent tested invalidation mechanism;
- every successful promotion mutation that can change current or future Merchant-visible price/schedule — publish, re-enable, Disable/end-early, and Scheduled material edit — advances the durable promotion pricing revision **inside the same database transaction** as the mutation; Draft-only edits and Copy do not advance it solely because they are not storefront-effective;
- every success-cache entry is tagged with the durable revision under which it was built;
- a Merchant cache-hit decision has an explicit linearization point at its bounded cheap read of the current durable revision. If that read occurs after a promotion mutation commits, an entry with the prior revision must not be served. A request whose revision read completed before the concurrent mutation commit is ordered before that mutation for cache-freshness purposes even if its HTTP response completes later;
- this cheap revision read is not a heavy feed generation and remains inside the route's bounded DB budget;
- invalidation/revision does not add request-controlled cache dimensions or weaken the fixed-key, single-flight, 60-second negative-backoff, complete-success-only, no-partial-200 rules from #153;
- an in-flight heavy generation reads/captures the durable revision before generation and re-reads it immediately before publishing a new success body. If the revision changed, it does not publish that result as current. Even if a concurrent DB commit races after the final read, the entry remains tagged with the old revision and the next cache-hit revision check cannot serve it as current;
- the promotion mutation must not rely on a post-commit callback to make the revision visible. After the campaign transaction commits, any later cache decision's revision read observes/compares against the advanced durable revision before deciding an old entry is current;
- if the deployed topology cannot provide this durable revision read plus the same fixed-key/single-flight/backoff guarantees across the active Merchant cache domain, Merchant activation remains blocked rather than serving potentially stale promotion pricing.

Existing indexing policy/ADR remains unchanged. Tracking scripts are never required for SEO-visible content/price.

Before adding SEO HTTP/runtime tests, inventory the coverage documented by PR #152/W15 and add only missing gates rather than duplicating existing CI signals.

## Security and trust boundaries
Assets:
- admin pricing authority;
- campaign state/schedule;
- final order money integrity;
- Pancake credentials/integration;
- customer totals;
- anonymous-cart session handle confidentiality.

Trust boundaries:
- browser/admin input untrusted;
- mirrored/direct Pancake data external/untrusted until validated;
- validated DB campaign/order records server-owned;
- raw anonymous-cart UUID is HttpOnly/server context, not browser-visible proof payload data;
- Pancake create-order external one-shot side effect.

Required controls:
- admin authn + authz on every mutation;
- bounded names/IDs/arrays/pages/money/time/proof bytes;
- target IDs resolved server-side;
- browser price never authoritative;
- rendered-checkout stale detection uses bounded stateless server-MAC proof bound to the correct cart/checkout identity as server-only MAC context; unsigned client quote facts, exposed raw cart session handles, and server-stored unbounded nonce state cannot prove what the buyer saw;
- concurrency-safe overlap;
- Pancake payload strict allowlist from immutable order snapshot + validated identity/stock;
- no secrets/customer PII/session handles in diagnostics.

Abuse tests include forged IDs/discounts/timestamps, oversized payloads, large page/offset input, racing publishes, oversized/malformed/manipulated/forged/wrong-cart rendered-quote proof, browser-visible proof inspection for cart-ID leakage, promotion-commit-versus-Merchant-cache linearization races, and malformed external prices.

## Performance/data access
- no per-card/per-variant N+1 promotion lookup;
- storefront lookup batch/bounded;
- `/flash-sale` bounded by existing page + offset window;
- product-target expansion avoids unbounded serial chatter;
- admin target search bounded;
- indexes support campaign/target identity, lifecycle/time, overlap lookups, and the durable singleton/equivalent promotion-pricing revision;
- sanctioned SQL projection remains parity-tested against central resolver;
- query-wide transition discovery is aggregate/bounded, not app-side all-row loading;
- Merchant promotion invalidation uses the existing fixed cache domain; no per-campaign/per-request unbounded cache-key growth;
- Merchant cache hits may perform one bounded cheap durable-revision read; heavy feed regeneration remains collapsed/single-flight and bounded by #153 M4.

Optimization beyond these guarantees is measurement-driven.

## Observability
Structured non-PII reason-coded events for:
- activation rejection;
- runtime variant invalidation/recovery;
- `PARTIALLY_INVALID` recovery;
- runtime overlap/recovery;
- checkout `PRICE_CHANGED` / rendered-quote proof rejection reason;
- promotion-aware Pancake submission rejection;
- Merchant promotion-cache revision mismatch/rebuild when Merchant is enabled.

Useful context: campaign ID, target type/ID, variant ID, bounded reason code. No customer address/phone/secrets/session handles or raw quote proof.

## Testing requirements
New behavior requires tests that fail without the implementation.

Must cover at least:
- base usability and money-data audit;
- Pancake catalog audit/W3 evidence workflow;
- percentage exact BigInt cases including exact-half + upper safe integer;
- SQL↔TS parity for no-promo/%/fixed/invalid/conflict/time boundaries;
- fixed/product activation validation and runtime partial fallback;
- lifecycle zero-traffic terminality;
- disabled-before/after Active behavior;
- Copy from every state, including >2000 source expansion;
- Copy name 119/120, surrogate boundary, trailing-space normalization, repeated Copy;
- disable succeeds when Active PRODUCT grows from <=2000 to >2000;
- Draft invalid save vs enabled hard gate;
- overlap and concurrent publish;
- runtime conflict/recovery;
- composite real-owner semantics;
- card representative/mixed variants;
- `/shop` effective-price filter/sort before pagination;
- `/flash-sale` active-valid membership using same SQL projection;
- storefront page-size/page/offset max/max+1; for 48-item page, 1042/1043 offset-window regression;
- query-wide off-page transition, empty Flash Sale start, clock skew, background resume;
- Stage-1 stateless server-MAC quote proof: valid proof/unchanged quote succeeds; oversized max/max+1, malformed/invalid/wrong-cart/forged proof fails closed; client changing hidden quote facts to current price cannot bypass a stale rendered proof; decoded/browser-visible token bytes do not contain the raw HttpOnly cart UUID; no DB proof/nonce rows are created by render/submit;
- two-stage checkout `PRICE_CHANGED`;
- immutable final audit snapshot;
- all three Pancake raw-live-price regressions;
- effective promotion mutation and durable promotion-pricing revision advance atomically; failed/rolled-back/Draft-only/Copy mutations do not advance revision;
- Merchant cached normal → immediate Publish → next cache decision reads newer durable revision and rebuilds;
- Merchant cached sale → Disable/end-early → next cache decision reads newer durable revision and rebuilds;
- Scheduled material edit that moves a boundary inside current success TTL advances revision transactionally;
- Merchant cache-hit revision read before concurrent mutation commit may finish as the request logically ordered before the mutation; a cache-hit revision read after commit must never serve the prior revision;
- concurrent GET after revision change still produces at most one heavy generation in the proved cache domain;
- in-flight pre-mutation heavy generation cannot be served as current after durable revision changes, including a commit racing after the generator's final revision read;
- Merchant negative failure sentinel remains isolated and cannot poison a valid success-cache generation;
- structured data fail-closed when variant offer shape is not representable;
- no `AggregateOffer` introduced by promotion work;
- analytics effective/final values using #153 canonical identities/cart/Purchase contracts;
- admin authz/input bounds;
- keyboard/mobile/Axe for campaign/storefront price-change UI.

## Verification commands
Implementation slices use repository gates relevant to touched behavior and full applicable CI before merge:
- `pnpm prisma:validate`
- `pnpm prisma:generate`
- `pnpm prisma:migrate:deploy`
- `pnpm test:db`
- `node --experimental-strip-types scripts/cart-server-action-http-smoke.ts`
- `node --experimental-strip-types scripts/guest-checkout-server-action-http-smoke.ts`
- `node --experimental-strip-types scripts/admin-authz-http-smoke.ts`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm release:check`
- isolated Playwright/Axe runtime under `tests/a11y-runtime`.

Run `pnpm pancake:catalog:audit` as a controlled/read-only readiness evidence step before the resolver ownership change is enabled. The controlled custom-price Pancake write probe is a human-approved readiness gate, not recurring CI.

## Migration and rollback
Implementation migration is additive:
- keep Pancake mirror Float field types unchanged;
- keep `pancakeRetailPriceAfterDiscount` mirrored;
- add promotion campaign/target persistence;
- add one durable bounded-cardinality `BigInt`/equivalent promotion-pricing revision persistence shape used transactionally by effective mutations and Merchant cache validation;
- add nullable promotion-audit fields for historical order compatibility;
- support rolling app rollback without destructive down-migration.

Rollback order:
1. turn off new activation gate;
2. disable active campaigns through the bounded campaign-only Disable path — this must work even if PRODUCT coverage >2000 and advances the durable promotion-pricing revision in the same transaction;
3. later Merchant cache decisions observe that new durable revision so stale sale bytes cannot mask rollback; no best-effort post-commit invalidation is relied upon;
4. stop new promotion-priced final submissions before rolling app code back;
5. reject/supersede promotion DRAFT attempts that rolled-back code cannot validate;
6. never rewrite finalized order history;
7. leave additive tables/columns until separately reviewed cleanup.

## Boundaries
Always:
- website campaign state is only website promotion authority;
- base comes from latest trusted `pancakeRetailPrice`;
- authoritative price is server-computed;
- enabled coverage is validated atomically;
- runtime promotion invalidation is affected-variant granular;
- runtime conflicts fail closed;
- rendered buyer-price acknowledgement is bounded/stateless/server-MAC-verifiable, keeps raw HttpOnly cart identity server-only, and is client-tamper-resistant but never price authority;
- final audit is immutable;
- Disable remains operationally available under catalog growth;
- enabled Merchant cache cannot outlive known promotion boundaries or be served as current after a cache-decision revision read has observed a newer committed promotion-pricing revision;
- SEO structured data stays truthful/fail-closed;
- #153 identity/cart/analytics/Merchant contracts remain binding unless separately superseded.

Ask first:
- new third-party dependency;
- Pancake catalog promotion writeback;
- destructive migration/order-state meaning change;
- one-shot/idempotency policy change;
- coupon/stacking/priority rules;
- making `pancakeRetailPriceAfterDiscount` website authority again;
- expanding this feature into ProductGroup/variant deep-link SEO work.

Never:
- trust browser final price;
- accept unsigned/client-editable quote facts, expose the raw HttpOnly cart UUID in proof payload, or persist unbounded server-stored proof state as proof of what the buyer saw;
- stack promotions;
- silently choose conflict winner;
- apply invalid promotion;
- submit stale quote after `PRICE_CHANGED`;
- recompute promoted final totals/request price from raw base;
- blind-retry ambiguous Pancake create-order;
- serve an old-revision Merchant success body from a cache decision whose durable-revision read occurred after the newer promotion mutation committed;
- rely on `after()`/fire-and-forget/post-commit callbacks as Merchant cache correctness authority;
- block Disable because a dynamic PRODUCT target grew beyond the activation expansion cap;
- fail Copy solely because current dynamic expansion exceeds 2000;
- emit `AggregateOffer` as a shortcut for product variants;
- rewrite finalized order history;
- mix unrelated refactors.

## Out of scope v1
- promotion stock quota;
- per-customer caps;
- coupons/stacking/priority;
- buy-X-get-Y/bundle engine;
- personalized pricing;
- manual stock reservation;
- different discount values inside one campaign;
- sale-price writeback to Pancake catalog;
- advanced campaign analytics dashboard;
- ProductGroup/variant deep-link SEO implementation unless separately specified.

## Success criteria
1. Admin can create/edit/publish/re-enable/disable/copy according to lifecycle and authz.
2. PRODUCT targets dynamically cover later variants without frozen membership.
3. Draft may be business-invalid; enabled mutations are atomic, bounded, overlap-safe and race-safe.
4. Disable remains possible under >2000 runtime expansion; Copy remains possible and creates bounded Draft from explicit targets.
5. Copy naming always obeys 120-code-unit cap with visible suffix.
6. Lifecycle terminality is correct with zero traffic/restarts.
7. Website uses positive safe-integer `pancakeRetailPrice` + website campaign state; mirror fields remain Float.
8. Pancake catalog W3 evidence is reviewed before resolver ownership change is enabled.
9. Percentage arithmetic is exact across full accepted domain; SQL↔TS parity is proven.
10. Storefront `/shop` and `/flash-sale` share one bounded pricing/membership projection and page/offset guards.
11. Storefront transition refresh handles off-page/empty-state/clock-skew/resume within 60s display bound.
12. Cart/checkout use server price with bounded stateless server-MAC rendered-quote proof plus two-stage explicit `PRICE_CHANGED` reconfirmation; client quote tampering cannot bypass acknowledgement, raw HttpOnly cart identity remains server-only, and no unbounded proof state is persisted.
13. Final order lines retain immutable base/final/promotion audit facts.
14. Pancake comparison/totals/request mapping all use effective/final website pricing, with controlled semantic acceptance before activation.
15. SEO Offer price uses effective price only when current SEO shape can truthfully represent it; unsupported variant pricing stays fail-closed and no AggregateOffer shortcut is introduced.
16. Analytics/Merchant consumers preserve the reviewed #153 identity/cart/Purchase/cache contracts while consuming authoritative effective/final promotion pricing; current module ownership is re-verified against then-current `main` rather than redefined ad hoc.
17. Merchant success cache is transition-aware and validates against a durable BigInt/equivalent promotion-pricing revision advanced transactionally with every effective promotion mutation; cache decisions that observe a newer committed revision cannot serve prior-revision bodies and #153 fixed-key/single-flight/backoff rules remain intact.
18. Security, bounds, migration, observability, rollback, tests, browser/a11y and full repository gates pass before launch.

## PR sizing guidance
This product contract may be implemented as dependency-safe PR slices. Follow ADR 0005: cohesion, risk, verification and revertability matter more than arbitrary file count. Tests travel with behavior; unrelated refactors stay out.