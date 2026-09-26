# La.na Design — owner-approved facts and decisions

Status: **APPROVED for Giai đoạn 2.** The owner approved the consolidated brand truth on 2026-09-16
in [`la-na-design-master-spec.md`](./la-na-design-master-spec.md). This intake is the narrower,
field-by-field view of that approval: every row names the exact `src/brand` field it feeds, so a
config value can be traced to an approved line without reading the whole spec.

Phase numbers in this document are the runbook's own: Giai đoạn 0 preparation, 1 initialization,
2 Brand Config, 3 design, 4 product content, 5 testing, 6 release.

This is Brand #2's fact authority, the counterpart of
`docs/specs/la-clothing-owner-approved-facts-and-decisions.md`. Runbook
[08 §Giai đoạn 0](https://github.com/nguyentuanson27-netizen/webtemplate/blob/main/docs/08-runbook-shop-moi.md)
blocks every later phase on it: `src/brand/*.config.ts` may hold no value that does not trace to a
line in this file, and no storefront page may state a brand fact that is not in `src/brand`.

A coding agent may not author a brand's legal identity, contact details, policy terms or body
measurements. Rows marked **pending** are therefore left blank for the owner to fill and approve.

## How to read the markers

| Marker | Meaning |
|---|---|
| **approved** | Stated by the owner. Copy it verbatim; do not paraphrase. |
| **derived** | Mechanically transformed from an approved value by a rule stated in the row. No new fact is introduced. |
| **pending** | Not approved yet. Leave the field unset and the surface omitted; do not invent a placeholder. |

## Authority and precedence

1. Owner-approved interview decisions consolidated in the master spec — newest authority.
2. Owner-supplied source documents and assets (terms/policy document, size-guide images, logo /
   social / favicon assets, legal-information screenshot).
3. Existing repository implementation — an integration constraint, **never** a source of brand truth.
   Stale LA Clothing values do not become approved by already being in the code.

### Policy authority

The owner-supplied terms text is **not** published raw. Its normalized, override-applied authority is
split by ownership rather than duplicated:

- master spec **PART D** (§12 delivery, §13 returns/exchange/refund, §14 payment, §15 complaints and
  support) remains the authority for `src/brand/fulfillment.config.ts` and the dedicated
  shipping/returns/contact projections;
- [`la-na-design-policy-authority.md`](./la-na-design-policy-authority.md) is the owner-approved
  authority for general terms, pricing, privacy, supply conditions, platform rights/obligations and
  the placeholder-free support/complaint channel wording transcribed by `src/brand/policy.config.ts`.

Keeping those owners explicit prevents a page from maintaining a second wording of an existing
fulfillment rule while still ensuring the five §33 topics that previously lacked text have a durable
repository source rather than depending on chat history.

Explicit owner overrides applied to the supplied terms text:

- **Payment.** The supplied text says bank transfer is supported. The current owner decision is
  **COD only on the website**, with bank transfer temporarily unavailable. The public wording is
  fixed: `Chuyển khoản ngân hàng hiện tạm thời chưa khả dụng trên website.` No bank account detail
  and no selectable bank-transfer method may be displayed until the owner re-enables it.
- **Contact placeholders.** Support/contact placeholders are superseded by the approved §3 facts:
  `www.lanadesign.vn`, `0923159666`, `la.nadesignsince2022@gmail.com`, the approved Facebook URL and
  `08:00`–`22:00` daily support hours. No contact-form submission channel may be published before
  G3/F9b implements real outbound delivery.
- **Return cases.** Legacy clauses the approved source does not support — notably a separate
  customer right to exchange size or colour when the shop fulfilled the order correctly — are not
  carried over.

---

## 1. Project identity → `project.config.json`

| Field | Value | Status | Constraint / consequence if wrong |
|---|---|---|---|
| `projectSlug` | `la-na-design` | **approved**, committed | 3–31 chars, `^[a-z][a-z0-9-]*[a-z0-9]$`. Must match `BRAND.identity.socialCardSlug` or the OG image 404s |
| `databaseName` | `la_na_design` | **derived** from `projectSlug` | `^[a-z][a-z0-9_]{2,30}$`, no hyphens. `release:check` and `deploy.sh` stop if `DATABASE_URL` does not point here |
| `composeProjectName` | `la-na-design` | **derived** from `projectSlug` | 2–63 chars. Docker Compose project isolation |
| `productionDomain` | `www.lanadesign.vn` | **approved**, [ADR 0010](../decisions/0010-la-na-design-permanent-domain.md) | Bare lowercase hostname. Feeds canonical URLs, JSON-LD, sitemap, robots. `OFFICIAL_PRODUCTION_STOREFRONT_HOST` mirrors it, and the apex `lanadesign.vn` is deliberately **not** canonical |

All four are committed. `pnpm bootstrap:brand` has been run against this identity: it renamed the
social-card route and set the package name.

## 2. Brand identity → `src/brand/brand.config.ts` › `identity`

Master spec §5.

| Field | Value | Status |
|---|---|---|
| `name` | `La.na Design` | **approved** |
| `displayNameUpper` | `La.na Design` | **approved.** Despite the inherited field name, the approved wordmark is **not** uppercase |
| `headline` | `La.na Design - charismatic in every yard of cloth.` | **approved.** Site default title and share-card brand line |
| `tagline` | `Thời trang nữ thiết kế thanh lịch với áo dài, váy và set đồ` | **approved.** Site default meta description and footer summary |
| `strapline` | `Charismatic in every yard of cloth.` | **approved.** Short footer line under the wordmark |
| `legalName` | `CÔNG TY TNHH QUỐC TẾ THƯƠNG MẠI LAS` | **approved** — see §3b |
| `taxId` | `0111242251` | **approved** — see §3b |
| `positioning` | `La.na Design là thương hiệu thời trang nữ thiết kế, tập trung vào áo dài, váy và set đồ với phong cách thanh lịch, nữ tính` | **approved.** Exactly one sentence; freehand brand prose is how invented history ships |
| `socialCardSlug` | `la-na-design-social-card` | **derived** from `projectSlug`, not an owner fact. `brand-leak.test.ts` asserts it names the route directory |
| `socialCardAlt` | `La.na Design - Thời trang nữ thiết kế thanh lịch, nữ tính` | **approved** |
| `homeTitle` | `La.na Design \| Áo dài & Thời trang nữ thiết kế` | **approved.** Homepage `<title>`, exact; it already carries the brand name, so it is published absolute rather than through the site title template |
| `homeMetaDescription` | `La.na Design - thời trang nữ thiết kế với áo dài cách tân, áo dài Tết, áo dài cưới, áo dài 4 tà, áo dài 6 tà, váy, set đồ và phụ kiện.` | **approved.** Homepage meta description, exact |
| `searchAlias` | `Lana Design` | **approved as a search/SEO alias only.** It may appear in structured data, search matching and natural SEO copy. It must **never** replace the public display name, and no doorway page may be created for the spelling variant |
| `additionalNeedles` | *(empty)* | **derived.** The brand-leak scanner protects identity strings of four characters or more on its own; `La.na` is five and `Lana` is four, so neither needs declaring |

### Brand assets (master spec §8)

Three **distinct** approved asset roles, none derived from another: master logo (header + footer
only), social card (separate campaign/social image), favicon source (separate square logo). Resizing
or cropping for delivery formats is allowed where it preserves the approved visual content;
regenerating or restyling an approved asset is not. Hero, mega-menu and category-editorial campaign
images are **pending** content, not assets to invent.

**Master logo binding — owner-approved 2026-09-19:** the production PNG whose source identifier starts
`7fe037369d2725ac696f41c14c333f5aa9cc1b6ef94cc2e820687ccc` is the approved master-logo asset.
The repository stores the original 193,993-byte PNG byte-for-byte at
`public/brand/la-na-design-master-logo.png` (intrinsic size 4185×2148). This approval resolves the
earlier F1 placeholder/fallback ambiguity; do not substitute the favicon or social card for this role.

## 3. Customer-facing business / support contact → `src/brand/brand.config.ts` › `contact`

Master spec §6 and §15. This is the **business** contact — distinct from the registered legal
identity in §3b, which must not overwrite it.

| Field | Value | Status |
|---|---|---|
| `telephone` | `0923159666` | **approved.** Hotline and Zalo are the same number |
| `telephoneInternational` | `+84923159666` | **derived**: the trunk zero is replaced by the Vietnam calling code, no subscriber digit changes. A test pins the derivation against `normalizeVietnamesePhone` |
| `email` | `la.nadesignsince2022@gmail.com` | **approved.** Customer support address; planned recipient for F9b once real outbound contact delivery exists |
| `fanpageUrl` | `https://www.facebook.com/la.nadesign.vn` | **approved** |
| Messenger chat link *(no config field)* | `https://m.me/la.nadesign.vn` | **derived** from `fanpageUrl` by `messengerUrlFromFanpage` in `src/brand/index.ts`: a facebook.com URL whose path is exactly one page username becomes `https://m.me/<username>`; any other shape derives nothing and the floating chat button does not render. Not a second contact fact. The floating Messenger button itself was requested by the repository owner on 2026-09-26 in Claude Code session [`session_017vxPKk3MTUMv7D21UQJ7Ms`](https://claude.ai/code/session_017vxPKk3MTUMv7D21UQJ7Ms) |
| `streetAddress` | `212 Nguyễn Trãi, Đại Mỗ` | **approved.** Business **and** return address |
| `addressLocality` | `Hà Nội` | **approved.** The locality half of the same approved address line |
| `supportHours` | `08:00`–`22:00`, Monday–Sunday, `+07:00` / `UTC+7` | **approved** |

Complaint and feedback response target: **24–48 working hours** after sufficient information is
received (master spec §15). No Zalo profile URL exists in any source; the approved fact is one
number reachable by phone and Zalo.

## 3b. Registered legal entity → `src/brand/brand.config.ts` › `identity` + `legal`

Master spec §6 *Legal entity*.

| Field | Value | Status |
|---|---|---|
| `identity.legalName` | `CÔNG TY TNHH QUỐC TẾ THƯƠNG MẠI LAS` | **approved** |
| `identity.taxId` | `0111242251` | **approved** |
| `legal.taxIdIssueDate` | `7/10/2025` | **approved**, transcribed exactly as the source states it (Vietnamese day/month/year order). No ISO form is derived, because no consumer needs one |
| `legal.registeredAddress` | `Số 06 Đường Manor 2str, Sunrise C, KĐT The Manor Central Park, Phường Định Công` | **approved.** The **registered** address — a different concept from the §3 business/return address |
| `legal.email` | `congtytnhh.las@gmail.com` | **approved.** Corporate/legal correspondence only; customer service uses the §3 support email |
| `legal.legalRepresentative` | `ĐINH THÙY LINH` | **approved for publication.** Previously withheld; the owner released it for the footer's legal block on 2026-09-21. Rendered as `Đại diện pháp luật: …` beside the registered identity, on mobile and desktop alike |

The About/legal footer surface may display legal name, registered address, tax ID, tax issue date,
legal email and the legal representative. The representative is a footer fact: the owner asked for
it in the footer's legal block, and `/about` keeps the fact set it already publishes rather than
gaining a new one by side effect. Registered address and business address must not overwrite each other, and neither
may the two email addresses.

## 4. Merchant defaults → `src/brand/brand.config.ts` › `merchant`

Master spec §7.

| Field | Value | Status |
|---|---|---|
| `feedBrand` | `La.na Design` | **approved** |
| `defaultGender` | `female` | **approved.** La.na Design is a women's fashion brand |
| `defaultAgeGroup` | `adult` | **approved** |

`market` stays `MARKET_VN` (vi / VN / VND) and is not configurable — the headless builders hard-code
`Intl.NumberFormat("vi-VN", { currency: "VND" })`.

## 5. Navigation → `src/brand/navigation.config.ts`

Master spec §10. Top-level order is fixed and exact:

1. `Áo dài` — clickable landing/category page, with five level-2 categories: Áo dài cách tân,
   Áo dài Tết, Áo dài cưới, Áo dài 4 tà, Áo dài 6 tà.
2. `Set đồ` — clickable category, with level-2 categories: Set váy, Set quần áo.
3. `Váy, đầm`
4. `Phụ kiện`
5. `Hàng mới về`
6. `Bộ sưu tập`
7. `Sale`

- The logo links to `/`. There is **no** top-level `Trang chủ` item.
- `/shop` stays as `Tất cả sản phẩm` but is **not** in primary navigation.
- `/collections`, `/new-arrivals`, `/sale` and `/contact` are kept.
- `/lookbook` and `/flash-sale` are removed from public route and navigation scope; `/sale` is the
  single promotion landing page.
- Exact nested slugs follow the existing route convention; hierarchy stays
  category → subcategory → product and every subcategory needs a crawlable URL.
- Child collection names are **pending**; do not invent placeholder collections.
- Exact `/ao-dai` and category title/H1/meta copy beyond the approved homepage metadata is
  **pending**: draft for approval rather than shipping invented copy.

Route paths are route identity, not brand identity: a menu entry for a path that has no route is not
caught by the brand gate, so navigation activation waits until every destination exists.

## 6. Size guide → `src/brand/size-guide.config.ts`

Master spec §11. Exactly four approved guides, mapped to a product **manually** — category alone
must not select a guide, because Set/Váy products may use wide-, medium- or small-form sizing.

| Guide ID | Title |
|---|---|
| `ao-dai` | Áo dài |
| `set-vay-form-rong` | Set/Váy form rộng |
| `set-vay-form-vua` | Set/Váy form vừa |
| `set-vay-form-nho` | Set/Váy form nhỏ |

Semantics, all **approved**:

- `Ngực / Eo / Mông` are **body circumferences**, not garment measurements.
- Body measurements and height are `cm`; weight is `kg`.
- **No fixed tolerance applies.** `±1`, `±2`, `±3` and `0 cm` are all wrong; absence must be
  representable in the type rather than encoded as a number.
- Guidance: the table is indicative and varies with the product's form; the customer should contact
  La.na Design for size advice.
- `Set/Váy form vừa` has **no hip row**, and that is the **approved** shape of the table, not a gap
  in it. It carries the original small-form chart, whose source does not provide hip values; do not
  invent them and do not leave a hip field waiting to be filled. Master spec §11.3.
- Owner decision 2026-09-25: the original small-form numbers became `Set/Váy form vừa`, and
  `Set/Váy form nhỏ` was re-issued from the owner's "Size chart" image, this time with a hip row.
  Master spec §11.4.

The exact tables live in master spec §11.1–§11.4 and are transcribed into the config unchanged.

## 7. Fulfillment → `src/brand/fulfillment.config.ts`

Master spec PART D. All values below are **approved** and are customer-facing commitments.

**Delivery (§12)** — nationwide Vietnam; carriers `GHN`, `GHTK`, `Viettel Post`, `J&T`, selected per
order/region; `Hà Nội` 1–3 days; other provinces/cities 3–10 days. ETAs are estimates, never
guarantees, and may extend for peak periods, weather, carrier issues or force majeure. La.na Design
does **not** proactively send a carrier tracking code or link by default. Confirmation calls are not
mandatory for every order — the system may confirm automatically, with a call, message or email used
for verification or exception handling.

The inherited scope label `Nội thành Hà Nội` does not match this split and must be corrected to
`Hà Nội` vs `tỉnh/thành khác` rather than silently narrowing the 1–3 day window to inner-city only.

**Returns / exchange / refund (§13)** — window 15 days from customer receipt. The product must remain
new and unused, keep its tags, be undamaged, unsoiled and untorn, carry no unusual smell or signs of
use, and be the correct La.na Design item. Supported cases: manufacturing defect or
manufacturing-origin stain, wrong size shipped, wrong model shipped, wrong colour shipped, and a
customer-initiated exchange to another model subject to conditions. Fees: customer-initiated exchange
`50,000 VND` per product plus two-way shipping paid by the customer; shop or manufacturer fault means
La.na Design pays 100% of reasonable exchange/return shipping; restocking fee `0`; the
non-returnable category list is **empty**. No refund is given simply because the customer changes
their mind about a correct, non-defective product. Refund target: 7–10 working days after the goods
are received back, inspected and approved, preferring the original payment method where practical and
otherwise a bank transfer or another mutually agreed method. Return channels: in person at
`212 Nguyễn Trãi, Đại Mỗ, Hà Nội`, or by mail/carrier to the same address following shop instructions.

**Payment (§14)** — COD enabled; bank transfer temporarily unavailable on the website, published with
the exact wording in *Policy authority* above.

## 8. Runtime credentials → `.env.local` / production env, never committed

| Secret | Needed for |
|---|---|
| `PANCAKE_API_KEY` | Supplied out of band for local verification. Catalog sync, order submission. Rotate before production use and configure it as a deployment secret — never in the repo |
| `PANCAKE_SHOP_ID` | Supplied. `pnpm release:check` reports `ok: true`. The mirror audits run, but the catalog mirror is empty, so their output is not yet evidence of anything |
| `BETTER_AUTH_SECRET` | ≥32 random characters, generated by a human, never by this repo |
| `DATABASE_URL` | Must point at `databaseName` above or the identity preflight stops. A local development value is in use; the production one is still required |
| `NEXT_PUBLIC_FACEBOOK_PIXEL_ID` | **Pending.** Baked into the CSP at build time — changing it requires a rebuild |
| `FACEBOOK_CAPI_ACCESS_TOKEN` | **Pending**, paired with the Pixel |

`SEARCH_INDEXING_ENABLED` stays `"false"` until the Giai đoạn 6 release gate and an explicit human
indexing approval.

## 9. Product catalog

- Pancake shop created, products entered, images uploaded to `content.pancake.vn`. The CSP allows
  that host only — images served from anywhere else will not render.
- Per-product slugs, editorial copy, SEO titles/descriptions, collections and Merchant attributes are
  entered through `/admin`, **not in source** (runbook Giai đoạn 4).
- `Bán chạy` has **no approved data source**. The badge and any bestseller ordering stay unavailable
  until one is defined from real data.

## 10. Design direction

Master spec §9, **approved**: warm brown / chocolate primary palette on light and cream backgrounds;
elegant serif for headings and the brand wordmark; clean sans-serif for body, navigation, forms,
prices and transactional UI; feminine, refined, modern, image-first, editorial-fashion mood. Lalin is
a reference for rhythm, whitespace, image-led storytelling, collection identity and restrained
ecommerce chrome — not a UI, colour, copy or layout to clone.

---

## Settled decisions

- **Permanent production domain** — `www.lanadesign.vn`. The bare apex is not canonical.
  Recorded in [ADR 0010](../decisions/0010-la-na-design-permanent-domain.md).
- **Legacy temporary host** — `LEGACY_TEMPORARY_STOREFRONT_HOST` stays `la.lanadesign.vn`. The owner
  reviewed removing it and decided against it; see ADR 0010 §4.
- **Brand fact set** — sections 2, 3, 3b, 4, 5, 6 and 7 are approved (master spec, 2026-09-16). This
  unblocks Giai đoạn 2 and Giai đoạn 3.
- **Product category and `defaultGender`** — women's fashion, `female`; three size charts.
- **Baseline route set** — decided in §5: `/lookbook` and `/flash-sale` go, `/sale` stays as the one
  promotion landing page.
- **Parent-only category membership** — **yes**, a product may be assigned directly to a parent
  category (`Áo dài`, `Set đồ`) without belonging to any of its subcategories. Approved by the
  repository owner on **2026-09-16**, answering the question G4 had carried as pending; recorded in
  [ADR 0013 §4.4](../decisions/0013-website-owned-merchandising-persistence.md) and carried in code
  as `APPROVED_CATEGORY_MEMBERSHIP_POLICY`.

  Consequence, stated so no later surface invents a different one: such a product lists on the
  parent page and on **no** subcategory page. Nothing may guess a subcategory for it.

  Provenance: given in the Claude Code session
  [`session_01P6QRsuGorqgLbRBtsHhXkR`](https://claude.ai/code/session_01P6QRsuGorqgLbRBtsHhXkR) in
  direct answer to the question posed by the G4 work, not inferred from an existing document. The
  other owner-approved category rules — several categories per product, one top-level tree only,
  child membership projecting into the parent listing, website-owned membership as source of truth —
  were supplied with the same G4 instruction and are recorded in ADR 0013 §4.3.
- **Checkpoint B — G4 merchandising migration path** — **approved 2026-09-16**, covering all five
  additive models ADR 0013 specifies: `HomepageFeaturedProduct` (§3),
  `ProductCategoryMembership` (§4.5), `CategoryProductOrder` (§5), `CategoryEditorialMedia` (§6) and
  `RelatedProductOverride` (§7). This unblocks M2, M3a and M3b writing those migrations.

  Scope of the approval, stated narrowly so nothing wider is read into it: it covers **only** those
  five additive models. Every one is additive — new tables plus back-relations on `ProductMirror` —
  no existing column changes meaning, and **no backfill is permitted**; category membership starts
  empty and is admin-assigned. It does **not** approve the other Checkpoint B rows (G5
  selling-policy/capacity, and the G1/G2/G3 acceptances), which remain open.

  Provenance: given by the repository owner in Claude Code session
  [`session_01P6QRsuGorqgLbRBtsHhXkR`](https://claude.ai/code/session_01P6QRsuGorqgLbRBtsHhXkR)
  after the five models were listed for review.
- **G3 contact-form outbound transport** — **approved 2026-09-16**. Provider **Resend**, over its
  HTTPS Email API via server-side `fetch` (no npm SDK while built-in fetch suffices). `From`
  **`website@lanadesign.vn`** on sending domain **`lanadesign.vn`**, which the owner authorized
  verifying with Resend. Destination stays the existing support inbox
  `la.nadesignsince2022@gmail.com`; `Reply-To` is the validated customer email. Secret
  **`RESEND_API_KEY`**, server-only. Payload is exactly `name`, `email`, `message`. Rate limit
  **3 / 15 minutes** and **10 / 24 hours** on a pseudonymous client bucket, never keyed by raw
  IP or email.

  **Not done and not claimed:** no Resend account, API key or DNS record exists or was observed.
  The SPF/DKIM/return-path values come from Resend at configuration time and are deliberately absent
  from this repository. Recorded in
  [ADR 0012](../decisions/0012-contact-form-outbound-transport.md).

- **G5 atomic capacity architecture** — **principles approved 2026-09-16**. The local PostgreSQL
  reservation ledger is the authoritative capacity gate; Pancake remains mirrored stock truth but is
  **not** trusted for negative-limit or concurrency enforcement, because G2 observed two concurrent
  orders both accepted at stock 0. Enforcement is per variant at the server-side order commit
  boundary, with `STANDARD` floored at 0 and `OVERSELL`/`PREORDER` floored at `negativeStockLimit`
  (default `−20`). Ambiguous Pancake writes hold capacity in `UNKNOWN` and are never auto-released.
  `OVERSELL`/`PREORDER` are disabled for composite products in v1. Recorded in
  [ADR 0014](../decisions/0014-atomic-capacity-and-reservations.md).

  Scope: this approves the **architecture**, not its persistence. ADR 0014 §13 proposes
  `ProductSellingPolicy` and `VariantCapacityReservation`, which are **not** covered by the
  2026-09-16 five-model Checkpoint B approval and need separate authorization before any migration.

  **Design direction reviewed 2026-09-17.** The owner approved the design direction of
  `ProductSellingPolicy` — a website-owned policy table, never overwritten by Pancake catalog sync,
  following the existing `ProductMerchantFacts` pattern of keeping website-owned facts out of the
  mirror — and required four corrections, all now applied: (1) a canonical resolver owns the
  missing-row answer (`STANDARD`, `−20`) and is tested, because a column default never fires for a
  row that does not exist; (2) `onDelete: Restrict` on the order relation, not `Cascade`, so a
  hard-deleted order cannot silently free a live hold; (3) biconditional CHECK constraints plus
  mutual exclusion of `committedAt`/`releasedAt`; (4) ADR §6 rewritten to lock an always-present
  `VariantMirror` row before reading the ledger — the previous rule locked ledger rows keyed by
  `variantId`, which locks nothing on an empty ledger and let the first two concurrent checkouts
  both read zero.

  **Migration authorized 2026-09-17.** Following that design review, the owner authorized writing
  and running the §13 migration for both models. Applied as
  `prisma/migrations/20260917080000_add_atomic_capacity_persistence`.

  Scope, stated narrowly so nothing wider is read into it: it covers **exactly** `SellingMode`,
  `ReservationState`, `ProductSellingPolicy` and `VariantCapacityReservation`, plus back-relations
  on `ProductMirror`, `OrderMirror` and `VariantMirror`. Additive; no existing column changes
  meaning; **no backfill**. It does **not** extend the 2026-09-16 five-model merchandising approval,
  and it does **not** cover the §12 order/preorder snapshot, which belongs to I7 and has no
  authorization.

  Why no backfill is safe is worth stating, because it is easy to get backwards: **not** the column
  defaults. A default fires when a row is inserted, and a product with no `ProductSellingPolicy` row
  never has one applied. `resolveSellingPolicy()` is the single producer of the missing-row answer —
  `STANDARD` at `−20`, today's behaviour exactly — and every consumer goes through it.

  Reservation **writes** are not shipped by this authorization: they require the ADR §6.2 locking
  transaction and the §6.4 guarded compare-and-set, both of which are I6a.

  The ADR §4.2 stock-observation marker, which the same review left as an unmet precondition, is now
  **enforced**: `syncPancakeCatalog()` samples a clock itself immediately before the first Pancake
  read, so a post-fetch marker is unrepresentable rather than merely discouraged.

  Provenance: given by the repository owner in Claude Code session
  [`session_01P6QRsuGorqgLbRBtsHhXkR`](https://claude.ai/code/session_01P6QRsuGorqgLbRBtsHhXkR),
  answering a direct question about whether "gỡ gate cho I1" authorized the §13 migration.

  Provenance: given by the repository owner in Claude Code session
  [`session_01P6QRsuGorqgLbRBtsHhXkR`](https://claude.ai/code/session_01P6QRsuGorqgLbRBtsHhXkR),
  reviewing the ADR 0014 §13 summary.

  Provenance for both: given by the repository owner in Claude Code session
  [`session_01P6QRsuGorqgLbRBtsHhXkR`](https://claude.ai/code/session_01P6QRsuGorqgLbRBtsHhXkR).
- **Checkpoint B — G1 Merchant + structured-data mapping** — **accepted 2026-09-17**. The owner
  accepted the availability mapping [ADR 0011](../decisions/0011-merchant-structured-data-availability-semantics.md)
  records: availability is projected from shopper sellability rather than from the internal mode
  name; internal `preorder` is **not** Google `preorder` (Google reserves that for unreleased
  products) and maps to `backorder` when a released product is still accepted below ready stock;
  a genuinely purchasable-and-fulfillable `oversell` state may publish `in_stock`; the exact
  negative limit publishes `out_of_stock`; and one shared projection must feed both the Merchant
  output and the product JSON-LD.

  Scope, stated narrowly: this accepts the **mapping and its evidence**, not publication of every
  row. The internal-preorder/below-ready-stock → `backorder` row stays **blocked**, because
  `availability_date` is required for it and no website-owned product-level public date authority
  exists. Accepting G1 does **not** unblock I9 for that row, and nothing may derive a date from
  `today + 15`, order confirmation, or campaign expiry to work around it (ADR 0011 §`availability_date`
  authority). I9 must still fail closed there.

  Provenance: given by the repository owner in Claude Code session
  [`session_01P6QRsuGorqgLbRBtsHhXkR`](https://claude.ai/code/session_01P6QRsuGorqgLbRBtsHhXkR),
  in direct answer to the open Checkpoint B row.

  **Superseded in part on 2026-09-18**: the owner supplied the missing date authority, so the
  `backorder` row is no longer blocked. See the next entry. The refusals above are unchanged —
  `today + 15`, order confirmation and campaign expiry remain forbidden as date sources.
- **I9 — automatic variant-level preorder availability-date authority** — **approved 2026-09-18**.
  This is the authority ADR 0011 was waiting for, and it supersedes that ADR's
  "blocked until a product-level authority exists" state. It is **variant-level**, finer than the
  product-level authority ADR 0011 anticipated: two sizes of one product sell out on different days,
  so one date per product would be wrong for at least one size.

  The owner's rules, verbatim in substance:

  1. The rule applies per **size/variant**.
  2. Only for variants whose internal mode is `preorder`.
  3. A preorder availability cycle starts when stock goes from `> 0` to `<= 0`; **or** when the
     feature starts watching and the variant is already `preorder` with stock `<= 0`, using the
     first day the website observed that state; **or** when an admin turns `preorder` off and on
     again while stock is still `<= 0`, which is a new cycle.
  4. Cycle dates are in Vietnam time, UTC+7.
  5. `availability_date` = cycle start date + **15 calendar days**.
  6. The date is **persisted fixed**. Never `today + 15` recomputed per feed run.
  7. When stock returns `> 0` the old cycle ends; the next `<= 0` creates a new cycle and date.
  8. If the date has passed and stock is still `<= 0`: do **not** add 15 more days; stop publishing
     `backorder` for that cycle; the product page hides the date line; the variant may still keep
     shopper-facing `Đặt trước` under the capacity policy.
  9. The Merchant feed and the JSON-LD consume the **same** canonical projection and date.
  10. On the product page, only after the shopper selects the preorder variant, show a small line
      `Dự kiến có hàng: <date>`; never another variant's date; hidden when expired.
  11. This Merchant date rule must **not** be used for the I7 order ETA.
  12. I7's order ETA remains order confirmation + 15 calendar days, decided separately.
  13. The owner **approved** the small migration/persistence that stores the cycle start and date
      per variant.

  Provenance: given by the repository owner in Claude Code session
  [`session_01P6QRsuGorqgLbRBtsHhXkR`](https://claude.ai/code/session_01P6QRsuGorqgLbRBtsHhXkR),
  as the I9 task brief, stated as "OWNER-APPROVED RULES — không được thay đổi/diễn giải lại".
- **Checkpoint B — G2 Pancake zero/negative-stock + composite evidence** — **accepted 2026-09-17**.
  The owner accepted the bounded live evidence recorded in
  [`docs/integrations/pancake-zero-negative-stock-capability-probe.md`](../integrations/pancake-zero-negative-stock-capability-probe.md):
  on the authorized test shop, Pancake accepted orders at stock 0, accepted orders driving stock
  below 0, accepted two concurrent orders at stock 0, and drove a 1:1 composite child to −1.

  Scope, stated narrowly so nothing wider is read into it: the acceptance covers the observations
  **as recorded, with the probe's own stated limits**. It establishes nothing about non-1:1
  composite multipliers, multi-component atomicity under partial failure or contention, nested
  BOMs, a composite parent whose component starts negative, unlimited overselling safety, or a
  safe storefront concurrency model. It is therefore the factual basis for ADR 0014's conclusion
  that Pancake is **not** the enforcement authority, and for the composite `OVERSELL`/`PREORDER`
  restriction in v1 — not a licence to lift either. The probe does **not** need re-running, and
  this acceptance does not authorize a second live run.

  Provenance: given by the repository owner in Claude Code session
  [`session_01P6QRsuGorqgLbRBtsHhXkR`](https://claude.ai/code/session_01P6QRsuGorqgLbRBtsHhXkR),
  in direct answer to the open Checkpoint B row. The earlier credential-exposure follow-up is
  recorded separately in the probe document and is unchanged by this acceptance.

- **Storefront collection display title** — approved by the repository owner on **2026-09-26**
  ("bỏ chữ BST trước trên mỗi bộ sưu tập"). `CollectionDefinition.title` stays the stored,
  admin-facing canonical title and admin shows it unchanged. Every public storefront surface reads
  a **derived** display title instead: `toStorefrontCollectionTitle` in
  `src/commerce/collection-definition.ts` drops one leading standalone `BST` prefix (any case,
  optionally followed by `:`, `-`, `–`, `—` or `.`) and keeps the stored title when nothing would
  remain. It is applied once at the public read boundaries (`listPublished`,
  `listHomepageMerchandising`, `findPublishedBySlug`, and the product-facing published-collection
  map), so the H1, collection index, homepage promo rows, product collection facts, breadcrumbs,
  tracking names and the metadata title fallback all agree. `seoTitle` is not rewritten.

  Provenance: given by the repository owner in Claude Code session
  [`session_01Lu1j8w4dFsYPA3mSNYsZZc`](https://claude.ai/code/session_01Lu1j8w4dFsYPA3mSNYsZZc).

## Still pending — do not invent

Master spec §47. These are content gaps, not architecture blockers:

1. Child collection names and content.
2. Hero campaign slides, assets and destinations.
3. Mega-menu and category-editorial image selections (admin content).
4. Meta Pixel / CAPI — intentionally deferred; must be decided before the production build.
5. Exact category SEO copy beyond the approved homepage metadata.
6. A real data source for `Bán chạy`.
7. Production deployment and search-indexing approval.

The `set-vay-form-vua` hip values are deliberately **not** on this list: §6 records them as absent
from the approved table, not as an owner fact still to come.

The `RESERVED` capacity-hold expiry window was briefly on this list during I6b and is **no longer
pending** — it was approved on 2026-09-18 and has its own section below.

## I7 immutable preorder/order snapshot — migration authorized 2026-09-18

| | |
|---|---|
| **Decision** | I7 may add a dedicated PostgreSQL migration for immutable preorder/order history |
| **Approved by** | The repository owner, 2026-09-18 |
| **Scope** | Only immutable preorder/order snapshot and order-history persistence required by ADR 0014 §12 |
| **Explicit exclusions** | No authorization for I8/I9, Merchant/JSON-LD, F8b/F8c UI, or unrelated schema changes |
| **Backfill** | None; older orders without I7 authority are not fabricated or rewritten |

The time authority is the successful local `CONFIRMED` boundary: preorder preparation is
**15 calendar days** from that confirmation, using the project's existing **UTC+7** authority. The
READY/PREORDER classification authority is earlier and narrower: the atomic capacity transaction
persists the classification it accepted on each reservation while holding the variant lock.
Confirmation copies that fact; it does **not** re-read mutable stock or selling policy after Pancake
has created the order. The stored fact is an **order ETA/preparation fact** and must never be derived
from Merchant `availability_date`.

The snapshot is immutable history: later stock or selling-policy changes do not rewrite it. Mixed
ready + preorder orders retain the slowest snapshotted preorder readiness and ship together after that
readiness. The reservation metadata is nullable only for rolling compatibility and no-backfill.
Orders/reservations that predate I7 authority remain explicitly without an I7 snapshot rather than
fabricating one from current catalog state.

Provenance: repository owner authorization given directly for the I7 build on 2026-09-18.

## The `RESERVED` capacity-hold expiry window — approved 2026-09-18

| | |
|---|---|
| **Decision** | A pre-submit `RESERVED` capacity hold is released after **15 minutes** |
| **Approved by** | The repository owner, 2026-09-18, answering the question I6b raised on PR #22 |
| **Prior authority** | ADR 0014 §8 — qualitative only: assigns the window to I6a and requires it be "long enough to cover a slow legitimate checkout" |
| **Implementation** | `RESERVED_HOLD_WINDOW_MS` in `src/commerce/guest-checkout-recovery.ts` |

Only `RESERVED` is eligible. §8 forbids any timer from touching `SUBMITTING` (a write may be in
flight) or `UNKNOWN` (one may have landed), and `COMMITTED` retires by the §4.1 mirror rule instead.

Two consequences worth recording so they are not rediscovered as bugs:

- The anonymous cart lives for **30 days**, far longer than this window. That is not a conflict: an
  expired hold does not empty the basket. The buyer's next submission re-reserves, and either
  succeeds or receives a truthful capacity refusal. Expiry ends the *claim* on the units, not the
  cart.
- Fifteen minutes coincides with the stranded-order staleness threshold, but they are separate
  constants answering different questions — how long a hold may count, versus how long an order may
  sit mid-flight. Changing one must not silently move the other.

## 11. Public policy surface — all §33 topics owner-approved

Master spec §33 requires eleven policy items to be publicly reachable. All eleven now have an
owner-approved repository authority. PART D continues to own delivery, returns/refund, current
payment state and the complaint response target; the newly approved legal/static text is normalized
in [`la-na-design-policy-authority.md`](./la-na-design-policy-authority.md) and transcribed into
`src/brand/policy.config.ts`.

| Topic | Destination | Authority |
|---|---|---|
| Chính sách vận chuyển | `/shipping`, `/policies#van-chuyen` | PART D §12 |
| Chính sách thanh toán | `/shipping#thanh-toan`, `/policies#thanh-toan` | PART D §14 — COD only; bank transfer unavailable on website |
| Chính sách đổi trả và hoàn tiền | `/returns`, `/policies#doi-tra-hoan-tien` | PART D §13 |
| Thông tin liên hệ | `/contact`, `/policies#lien-he` | §3 Brand Config contact facts |
| Các hình thức hỗ trợ trực tuyến | `/contact`, `/policies#ho-tro-truc-tuyen` | policy authority + §3 contact facts |
| Chính sách tiếp nhận và giải quyết phản ánh, khiếu nại | `/contact`, `/policies#khieu-nai` | policy authority + PART D §15 |
| Điều khoản chung | `/policies#dieu-khoan-chung` | policy authority |
| Chính sách giá | `/policies#chinh-sach-gia` | policy authority |
| Chính sách bảo mật | `/policies#bao-mat` | policy authority |
| Các điều kiện và hạn chế trong việc cung cấp hàng hóa | `/policies#dieu-kien-cung-cap` | policy authority |
| Quyền và nghĩa vụ của các bên trên nền tảng | `/policies#quyen-nghia-vu` | policy authority |

Normalization is explicit rather than inferred: supplied bank-transfer-as-payment wording is
superseded by current COD-only truth; support/contact placeholders are replaced with approved facts;
and no contact-form channel is published before F9b implements real outbound delivery.

## Open technical questions

Master spec §48 — implementation-plan gates, not licence to invent behaviour now: ~~Merchant
`availability_date` strategy for the rolling preorder rule~~ (**answered 2026-09-18** by the
variant-level availability-cycle authority in Settled decisions); whether Pancake accepts
zero/negative stock order submission; the atomic capacity mechanism; composite/bundle variant
interaction with selling modes; and outbound mail transport for the `/contact` form.
