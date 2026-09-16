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

## 3. Customer-facing business / support contact → `src/brand/brand.config.ts` › `contact`

Master spec §6 and §15. This is the **business** contact — distinct from the registered legal
identity in §3b, which must not overwrite it.

| Field | Value | Status |
|---|---|---|
| `telephone` | `0923159666` | **approved.** Hotline and Zalo are the same number |
| `telephoneInternational` | `+84923159666` | **derived**: the trunk zero is replaced by the Vietnam calling code, no subscriber digit changes. A test pins the derivation against `normalizeVietnamesePhone` |
| `email` | `la.nadesignsince2022@gmail.com` | **approved.** Customer support address; planned recipient for F9b once real outbound contact delivery exists |
| `fanpageUrl` | `https://www.facebook.com/la.nadesign.vn` | **approved** |
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
| legal representative | *(not published)* | **withheld by the owner.** Must not be rendered publicly on the storefront, and no field for it may be added |

The About/legal footer surface may display legal name, registered address, tax ID, tax issue date
and legal email. Registered address and business address must not overwrite each other, and neither
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

Master spec §11. Exactly three approved guides, mapped to a product **manually** — category alone
must not select a guide, because Set/Váy products may use either wide- or small-form sizing.

| Guide ID | Title |
|---|---|
| `ao-dai` | Áo dài |
| `set-vay-form-rong` | Set/Váy form rộng |
| `set-vay-form-nho` | Set/Váy form nhỏ |

Semantics, all **approved**:

- `Ngực / Eo / Mông` are **body circumferences**, not garment measurements.
- Body measurements and height are `cm`; weight is `kg`.
- **No fixed tolerance applies.** `±1`, `±2`, `±3` and `0 cm` are all wrong; absence must be
  representable in the type rather than encoded as a number.
- Guidance: the table is indicative and varies with the product's form; the customer should contact
  La.na Design for size advice.
- `Set/Váy form nhỏ` has **no hip row**, and that is the **approved** shape of the table, not a gap
  in it. The source chart does not provide hip values; do not invent them and do not leave a hip
  field waiting to be filled. Master spec §11.3.

The exact tables live in master spec §11.1–§11.3 and are transcribed into the config unchanged.

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

## Still pending — do not invent

Master spec §47. These are content gaps, not architecture blockers:

1. Child collection names and content.
2. Hero campaign slides, assets and destinations.
3. Mega-menu and category-editorial image selections (admin content).
4. Meta Pixel / CAPI — intentionally deferred; must be decided before the production build.
5. Exact category SEO copy beyond the approved homepage metadata.
6. A real data source for `Bán chạy`.
7. Production deployment and search-indexing approval.

The `set-vay-form-nho` hip values are deliberately **not** on this list: §6 records them as absent
from the approved table, not as an owner fact still to come.

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

Master spec §48 — implementation-plan gates, not licence to invent behaviour now: Merchant
`availability_date` strategy for the rolling preorder rule; whether Pancake accepts zero/negative
stock order submission; the atomic capacity mechanism; composite/bundle variant interaction with
selling modes; and outbound mail transport for the `/contact` form.
