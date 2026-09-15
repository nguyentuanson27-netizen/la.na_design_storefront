# La.na Design — owner-approved facts and decisions

Status: **EMPTY — awaiting owner approval.** Nothing below is approved yet.

This is Brand #2's fact authority, the counterpart of
`docs/specs/la-clothing-owner-approved-facts-and-decisions.md`. Runbook
[08 §Giai đoạn 0](https://github.com/nguyentuanson27-netizen/webtemplate/blob/main/docs/08-runbook-shop-moi.md)
blocks every later phase on it: `src/brand/*.config.ts` may hold no value that does not trace to a
line in this file, and no storefront page may state a brand fact that is not in `src/brand`.

A coding agent may not author a brand's legal identity, contact details, policy terms or body
measurements. Each row below is therefore left blank for the owner to fill and approve, with the
exact config field it feeds and what goes wrong if it is guessed.

---

## 1. Project identity → `project.config.json`

| Field | Value | Constraint | Consequence if wrong |
|---|---|---|---|
| `projectSlug` | `la-na-design` *(proposed — derived from the brand name, not an owner fact)* | 3–31 chars, `^[a-z][a-z0-9-]*[a-z0-9]$` | Renames the social-card route; must match `BRAND.identity.socialCardSlug` or the OG image 404s |
| `databaseName` | `la_na_design` *(proposed)* | `^[a-z][a-z0-9_]{2,30}$`, no hyphens | `release:check` and `deploy.sh` stop if `DATABASE_URL` does not point here |
| `composeProjectName` | `la-na-design` *(proposed)* | 2–63 chars | Docker Compose project isolation |
| **`productionDomain`** | **— REQUIRED —** | bare lowercase hostname, no scheme/path/port | **Blocks `pnpm bootstrap:brand`.** Feeds canonical URLs, JSON-LD, sitemap, robots |

The three proposals are mechanical transforms of the brand name "La.na Design" and are offered for
confirmation, not asserted. `productionDomain` cannot be derived and must be supplied.

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
| `socialCardSlug` | — | Must equal the social-card route directory minus `.png` |
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
| `PANCAKE_API_KEY` | Catalog sync, order submission |
| `PANCAKE_SHOP_ID` | **Blocks `release:check`, `money:audit`, `merchant:identity:audit`, `sitemap:capacity:audit`** |
| `BETTER_AUTH_SECRET` | ≥32 random characters, generated by a human, never by this repo |
| `DATABASE_URL` | Must point at `databaseName` above or the identity preflight stops |
| `NEXT_PUBLIC_FACEBOOK_PIXEL_ID` | Optional. **Baked into the CSP at build time** — changing it requires a rebuild |
| `FACEBOOK_CAPI_ACCESS_TOKEN` | Optional, paired with the Pixel |

`SEARCH_INDEXING_ENABLED` stays `"false"` until the Phase 6 release gate and an explicit human
indexing approval.

## 9. Product catalog

- Pancake shop created, products entered, images uploaded to `content.pancake.vn`.
  The CSP allows that host only — images served from anywhere else will not render.
- Per-product slugs, editorial copy, SEO titles/descriptions, collections and Merchant attributes
  are entered through `/admin`, **not in source** (runbook Giai đoạn 4).

## 10. Design direction

Required before the Phase 4 redraw: typography, colour, imagery treatment, layout density, and any
reference material or existing brand assets. The baseline is a serif/minimal monochrome menswear
system; "La.na Design" states a name but no visual direction.

This is the one gap that is a judgement call rather than a fact lookup: a proposed direction can be
drafted for approval, but it must be approved before it ships.

---

## Open decisions

1. `productionDomain` — blocks bootstrap.
2. Product category and `defaultGender` — decides navigation and how many size charts are needed.
3. Whether the baseline route set (`/lookbook`, `/flash-sale`, `/collections`, …) stays as-is.
4. Whether Meta Pixel/CAPI is in scope for launch — it must be decided before the production build.
