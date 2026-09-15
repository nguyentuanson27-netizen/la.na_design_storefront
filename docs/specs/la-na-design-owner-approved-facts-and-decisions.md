# La.na Design — owner-approved facts and decisions

Status: **PARTIAL.** Project identity is accepted and committed; the brand fact set is still empty.
Section 1 is decided, and the one field it forces in section 2 (`socialCardSlug`) with it.
Everything else — identity copy, contact, merchant defaults, navigation, size guide, fulfillment —
is still awaiting owner approval and still blocks runbook Giai đoạn 2 (Brand Config and the static
pages) and Giai đoạn 3 (design and interface rewrite).

Phase numbers in this document are the runbook's own: Giai đoạn 0 preparation, 1 initialization,
2 Brand Config, 3 design, 4 product content, 5 testing, 6 release.

This is Brand #2's fact authority, the counterpart of
`docs/specs/la-clothing-owner-approved-facts-and-decisions.md`. Runbook
[08 §Giai đoạn 0](https://github.com/nguyentuanson27-netizen/webtemplate/blob/main/docs/08-runbook-shop-moi.md)
blocks every later phase on it: `src/brand/*.config.ts` may hold no value that does not trace to a
line in this file, and no storefront page may state a brand fact that is not in `src/brand`.

A coding agent may not author a brand's legal identity, contact details, policy terms or body
measurements. Every row still marked `—` is therefore left blank for the owner to fill and approve,
with the exact config field it feeds and what goes wrong if it is guessed. Rows carrying a value
record a decision the owner has actually made.

---

## 1. Project identity → `project.config.json`

| Field | Value | Constraint | Consequence if wrong |
|---|---|---|---|
| `projectSlug` | `la-na-design` ✅ committed | 3–31 chars, `^[a-z][a-z0-9-]*[a-z0-9]$` | Renames the social-card route; must match `BRAND.identity.socialCardSlug` or the OG image 404s |
| `databaseName` | `la_na_design` ✅ committed | `^[a-z][a-z0-9_]{2,30}$`, no hyphens | `release:check` and `deploy.sh` stop if `DATABASE_URL` does not point here |
| `composeProjectName` | `la-na-design` ✅ committed | 2–63 chars | Docker Compose project isolation |
| `productionDomain` | `www.lanadesign.vn` ✅ **owner-approved**, [ADR 0010](../decisions/0010-la-na-design-permanent-domain.md) | bare lowercase hostname, no scheme/path/port | Feeds canonical URLs, JSON-LD, sitemap, robots. `OFFICIAL_PRODUCTION_STOREFRONT_HOST` must mirror it, and the apex `lanadesign.vn` is deliberately **not** canonical |

All four are decided and committed in `project.config.json`. The first three are mechanical
transforms of the brand name "La.na Design"; `productionDomain` was supplied by the owner, who
selected the `www` form over the bare apex. `pnpm bootstrap:brand` has been run against this
identity: it renamed the social-card route and set the package name.

## 2. Brand identity → `src/brand/brand.config.ts` › `identity`

| Field | Value | Notes |
|---|---|---|
| `name` | `La.na Design` *(given in the task brief)* | The only fact supplied so far |
| `displayNameUpper` | — | Uppercase wordmark form |
| `headline` | — | Default page title and share-card brand line |
| `tagline` | — | Default meta description and footer summary |
| `strapline` | — | Short footer line under the wordmark |
| `legalName` | — | Registered entity name, published on `/about` |
| `taxId` | — | MST, published on `/about` |
| `positioning` | — | **Exactly one approved sentence.** Freehand brand prose is how invented history ships |
| `socialCardSlug` | `la-na-design-social-card` ✅ set | Not an owner fact: it is derived from `projectSlug` and moved when `bootstrap:brand` renamed the route. `brand-leak.test.ts` asserts it names that directory |
| `socialCardAlt` | — | Alt text for the share card |
| `additionalNeedles` | — | Identity strings under 4 characters, so the brand-leak scanner still protects them. `"La.na"` is 5 characters and clears the floor on its own; confirm whether a shorter form (e.g. `"Lana"`) is also in use |

`legalName` and `taxId` are legal identifiers published to the public web. They are the two facts on
this page it would be most damaging to invent.

## 3. Contact → `src/brand/brand.config.ts` › `contact`

| Field | Value | Notes |
|---|---|---|
| `telephone` | — | National form, e.g. `0xxxxxxxxx` |
| `telephoneInternational` | — | Same number as `+84…`; a test pins the derivation against `normalizeVietnamesePhone` |
| `email` | — | Support address |
| `fanpageUrl` | — | Facebook page URL |
| `streetAddress` | — | Published on `/about` and in JSON-LD |
| `addressLocality` | — | City |
| `supportHours` | — | `days`, `opens`, `closes`, `utcOffset` (`+07:00`), `utcOffsetLabel` |

## 4. Merchant defaults → `src/brand/brand.config.ts` › `merchant`

| Field | Value | Notes |
|---|---|---|
| `feedBrand` | — | Brand string in the Google Merchant feed |
| `defaultGender` | — | `female` \| `male` \| `unisex`. Baseline is `male` (menswear); **La.na Design's category is not yet stated** |
| `defaultAgeGroup` | — | e.g. `adult` |

`market` stays `MARKET_VN` (vi / VN / VND) and is not configurable — the headless builders hard-code
`Intl.NumberFormat("vi-VN", { currency: "VND" })`.

## 5. Navigation → `src/brand/navigation.config.ts`

Required: the **real category structure**. The baseline menu is menswear-shaped
(`/shop`, `/new-arrivals`, `/collections`, `/lookbook`). Needed:

- `brandHomeLabel`;
- `primary` — the real top-level categories, in rendered order;
- `utility` / `mobileUtility` / `footer` — confirm the baseline set still applies.

Route paths are route identity, not brand identity: adding a menu entry for a path that has no route
will not be caught by the brand gate.

## 6. Size guide → `src/brand/size-guide.config.ts`

Required: **real manufacturer measurement tables.** Womenswear typically needs three
(tops / bottoms / dresses); the baseline ships one menswear-shaped chart.

Per chart: `id`, `title`, `sizes[]`, and `rows[]` of `{ parameter, values }` where every key in
`values` covers every entry in `sizes` — a missing key renders an empty cell.

Also required: `unit`, `toleranceCm`, `toleranceNote`, `circumferenceSemanticsNote`, `guidanceNote`.
Invented measurements cause returns; this is the single most expensive field to guess.

## 7. Fulfillment → `src/brand/fulfillment.config.ts`

Required policy terms, all published as customer-facing commitments on `/shipping` and `/returns`:

- **Returns** — `windowDays`, `productConditions[]`, `supportedCases[]`,
  `customerInitiatedExchangeFeeVnd`, `customerInitiatedShippingNote`, `shopFaultShippingNote`,
  `nonReturnableCategories[]` + note, `refundWorkingDays {min,max}`, `refundChannelNote`.
- **Delivery** — `coverage`, `carriers[]`, `estimateDays.innerCity`, `estimateDays.otherProvince`,
  `estimateCaveat`, `carrierTrackingNote`, `phoneConfirmationWording`.
- **Scope labels** — `innerCity`, `otherProvince` (baseline is Hà Nội-shaped; depends on where
  La.na Design ships from).
- **Return logistics** — `returnMethods.{inStore,byMail,byMailResponsibility}`, `restockingFeeVnd`
  + note, `nonDefectiveRefundNote`.

These are contractual terms. The return window and the refund window in particular are promises the
merchant must honour.

## 8. Runtime credentials → `.env.local` / production env, never committed

| Secret | Needed for |
|---|---|
| `PANCAKE_API_KEY` | ✅ supplied out of band for local verification. Catalog sync, order submission. Rotate before production use, and configure it as a deployment secret — never in the repo |
| `PANCAKE_SHOP_ID` | ✅ supplied. `pnpm release:check` now reports `ok: true`. The three mirror audits run, but the catalog mirror is empty, so their output is not yet evidence of anything |
| `BETTER_AUTH_SECRET` | ≥32 random characters, generated by a human, never by this repo |
| `DATABASE_URL` | Must point at `databaseName` above or the identity preflight stops. A local development value is in use; the production one is still required |
| `NEXT_PUBLIC_FACEBOOK_PIXEL_ID` | Optional. **Baked into the CSP at build time** — changing it requires a rebuild |
| `FACEBOOK_CAPI_ACCESS_TOKEN` | Optional, paired with the Pixel |

`SEARCH_INDEXING_ENABLED` stays `"false"` until the Giai đoạn 6 release gate and an explicit human
indexing approval.

## 9. Product catalog

- Pancake shop created, products entered, images uploaded to `content.pancake.vn`.
  The CSP allows that host only — images served from anywhere else will not render.
- Per-product slugs, editorial copy, SEO titles/descriptions, collections and Merchant attributes
  are entered through `/admin`, **not in source** (runbook Giai đoạn 4).

## 10. Design direction

Required before the Giai đoạn 3 redraw: typography, colour, imagery treatment, layout density, and any
reference material or existing brand assets. The baseline is a serif/minimal monochrome menswear
system; "La.na Design" states a name but no visual direction.

This is the one gap that is a judgement call rather than a fact lookup: a proposed direction can be
drafted for approval, but it must be approved before it ships.

---

## Settled decisions

- **Permanent production domain** — `www.lanadesign.vn`. The bare apex is not canonical.
  Recorded in [ADR 0010](../decisions/0010-la-na-design-permanent-domain.md).
- **Legacy temporary host** — `LEGACY_TEMPORARY_STOREFRONT_HOST` stays `la.lanadesign.vn`. The
  owner reviewed removing it and decided against it; see ADR 0010 §4.

## Open decisions

1. The brand fact set in sections 2, 3, 4, 6 and 7 — the blocker for Giai đoạn 2 and Giai đoạn 3.
2. Product category and `defaultGender` — decides navigation and how many size charts are needed.
3. Whether the baseline route set (`/lookbook`, `/flash-sale`, `/collections`, …) stays as-is.
4. Whether Meta Pixel/CAPI is in scope for launch — it must be decided before the production build.
