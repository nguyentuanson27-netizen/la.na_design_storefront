# Spec: Homepage editorial refresh — Ding Dang rhythm, La.na visual

Status: **APPROVED (#60) — implemented in #62; section content pending owner mapping (§17)**

Implementation note: the components, fail-closed resolution, `/feedback` route and SEO wiring are built. Until the §17 content is supplied in `src/content/homepage.config.ts` (and category images in `CategoryEditorialMedia`), SPECIAL DEALS, both promo rows and the feedback rail omit themselves and `/feedback` returns 404 and is withheld from the sitemap.

Feedback (#74): the `/feedback` gallery is an uncropped masonry — each photograph keeps its natural `width`/`height` ratio, four columns on desktop and two on mobile — and any feedback photograph, on the homepage rail or on `/feedback`, opens enlarged in a viewer when pressed (owner request 2026-09-24). `width`/`height` are required on every configured photograph: an entry without them fails the whole feedback content closed rather than falling back to a cropped tile. The feedback heading, metadata copy and image set are all still pending (§17), so the rail and `/feedback` stay fail-closed as above.

Owner confirmation date: 2026-09-23

## 0. Authority and precedence

This document is the focused implementation contract for the La.na Design homepage refresh approved on 2026-09-23.

For the homepage only, this spec **supersedes the lower-homepage order and section roles** currently described in `docs/specs/la-na-design-master-spec.md` §16 and §18–§23.

The following existing contracts remain authoritative unless this document explicitly changes them:

- §17 Hero slider — keep the current hero behavior and current first-surface/header contract.
- §24 Header/navigation/search — unchanged.
- Existing product-card commerce truth: pricing, sale display, marketing badge priority, preorder/availability truth.
- Existing collection/product/catalog authority. This spec changes homepage merchandising presentation, not commerce eligibility or product truth.
- Existing footer/legal/policy contract — footer remains; only the homepage `Service strip` and `Brand story` sections are removed.

Reference rule: Ding Dang is used only for **section order, editorial rhythm and composition from its SALE/SPECIAL DEALS area downward**. La.na must not copy Ding Dang's typography, colors, copy, artwork, brand identity or exact pixel styling.

## 1. Assumptions surfaced before implementation

1. The current La.na hero remains the only homepage section above the refreshed sequence. Existing `Hàng mới về`, lead Áo dài editorial, Featured grid, old category editorial, collection navigation, Service strip and Brand story are replaced on the homepage.
2. **New homepage-specific content** introduced by this refresh remains repository-config-owned. Existing DB-backed authorities such as `HomepageFeaturedProduct` and `CategoryEditorialMedia` are intentionally reused rather than duplicated. No new CMS/admin UI, external service or database-backed homepage editor is required.
3. The dedicated feedback page uses the canonical route `/feedback` unless the owner changes the slug before implementation.
4. The four collection-promo slots are intentionally unmapped at spec time. Unmapped slots must not publish fake collection names, fake links or placeholder campaign images.
5. The first refreshed section is the owner-approved `SPECIAL DEALS` 4-product section. Its layout and role stay fixed; repository data may change its supporting copy, source collection and selected products over time, but this spec does not create a generic campaign-section framework.
6. Collection product fallback ordering must reuse the collection's existing merchandising order; no new "newest", "bestseller" or implicit sort rule is introduced.
7. Visual copy that is not explicitly approved here remains config-owned content, not code-authored brand prose.

## 2. Objective

Redesign the homepage from the SALE/SPECIAL DEALS-equivalent area downward so the page has the same **editorial cadence** the owner approved from the Ding Dang reference, while remaining visually 100% La.na Design.

The refreshed homepage should feel less like a sequence of unrelated storefront modules and more like a deliberate fashion-editorial journey:

```text
Hero (unchanged)
→ SPECIAL DEALS: 4 products
→ Collection promo row A: 2 image blocks
→ YOUR NEXT FAVOURITE: 4 category blocks
→ Collection promo row B: 2 image blocks
→ Customer feedback horizontal image rail
→ Footer
```

Success means the owner can later change SPECIAL DEALS supporting copy/source collection, collection promo mappings and feedback images through repository config/data **without changing the section layout/components**. The `SPECIAL DEALS` role itself remains the fixed 4-product merchandising section defined here.

## 3. Current state being replaced

Current `src/app/page.tsx` renders, after the hero:

```text
Hàng mới về
→ Áo dài La.na Design
→ Sản phẩm nổi bật
→ Category editorial
→ Collection navigation (when available)
→ Service strip
→ Brand story
```

This refresh removes those homepage section roles and replaces them with the sequence in §2.

Important scope discipline:

- Do not delete collection/category/product capabilities merely because their old homepage section disappears.
- Do not change product detail, PLP, collection detail, cart, checkout or commerce rules.
- Do not remove footer facts or policy links.
- Do not refactor unrelated merchandising infrastructure.

## 4. Tech stack and current project boundaries

Current repository stack from `package.json`:

- Next.js 16.3.3
- React 19.2
- TypeScript 5.9
- Tailwind CSS 4 + project CSS in `src/app/globals.css`
- PostgreSQL + Prisma 7.9.1
- pnpm 11.4.0
- Node.js >= 22.14.0

Relevant architecture boundaries:

- `src/app/` — page markup/wiring only.
- `src/routes/` — homepage loading/view-model orchestration.
- `src/brand/` — La.na brand/taxonomy authority; do not turn it into a free-form campaign-content store.
- `src/content/` — repository-owned public/editorial content where appropriate.
- `src/components/brand/` — La.na presentation components.
- `src/components/headless/` — reusable presentation models where already established.
- `src/commerce/` — product, collection, pricing and merchandising authority.
- Page-layer boundary tests must continue to pass; `src/app/page.tsx` must not reach directly into DB/commerce/integration layers.

## 5. Repository commands

Use the repository's checked-in commands; do not substitute guessed test commands.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm prisma:generate

pnpm lint
pnpm typecheck
pnpm test:domain
pnpm test
pnpm test:db
pnpm build
pnpm release:check
```

During implementation, focused homepage/domain/browser tests should run before the full gate.

## 6. Visual language

The structure/rhythm may reference Ding Dang, but every rendered visual must remain La.na.

Required:

- Keep the existing La.na serif/sans typography roles.
- Keep the existing warm brown / cream La.na palette and existing focus treatment.
- Use square/full-bleed editorial imagery; do not introduce rounded-card styling.
- Editorial image rows should run edge-to-edge/full-width rather than being placed inside generic padded cards.
- Product cards continue to use the current La.na `ProductCard` language unless a later owner decision explicitly redesigns the card itself.
- Avoid introducing new gradients, generic fashion-template decoration, excessive shadows or a second design system.
- Images use `object-fit: cover`-style cropping with stable aspect behavior and no layout shift.
- No Ding Dang logos, fonts, copy, proprietary artwork or brand colors.

## 7. Final homepage section order

### 7.1 Hero — unchanged

Keep the existing Hero slider contract and current content authority. This refresh starts **after** the hero.

No redesign of hero autoplay, CTA, reduced-motion behavior or transparent-header behavior is included.

---

### 7.2 SPECIAL DEALS — 4 products

This is the owner-approved SALE / `SPECIAL DEALS` section. It is **not** a generic campaign framework: the section's role is always one four-product merchandising block in this exact homepage position.

#### Purpose

Keep one fixed four-product layout. Repository data may change which products/collection it promotes and may change supporting copy over time, but implementation must not introduce alternate campaign modes, alternate section types or role-switching abstractions.

#### Content contract

- Primary section label/title: `SPECIAL DEALS` for the current approved presentation.
- Optional short supporting line may remain repository-configurable.
- One source collection provides the `Xem thêm` destination and the automatic fallback products.
- Manual product override comes from the **existing ordered `HomepageFeaturedProduct` authority**; do not create a second manual-product list in homepage config.
- CTA label: `Xem thêm` unless the owner separately changes this copy.
- Destination: the configured source collection, and it must be route-reachable under the current collection-page contract defined below.

#### Product selection priority and source-collection relationship

1. **Manual override** — read the existing `HomepageFeaturedProduct` ordered selection via the current merchandising boundary. If that authority resolves non-empty, its first 4 visible products are the intended SPECIAL DEALS set.
2. Those manual products must all belong to the configured source collection under the **same collection-membership truth used by the public collection listing** (currently `ProductContent.collectionSlugs` / the collection discovery predicate). Do not treat category membership, homepage config, or visual placement as collection membership.
3. If the manual authority is non-empty but its rendered first-4 set contains fewer than 4 visible products **or any of those products is not a member of the source collection**, treat the homepage merchandising state as inconsistent and **omit SPECIAL DEALS**. Do not silently filter, top up, cross-merchandise, or fall back to automatic products.
4. **Collection fallback** — only when the existing manual authority resolves empty, derive the fallback from the **same unfiltered first-page surface the public collection route currently renders**, then take its first 4 visible products.
5. The exact fallback algorithm is:
   - resolve the same route-reachable source `CollectionDefinition`;
   - build the collection's unfiltered page-1 discovery state using the same defaults as `parseCollectionDiscoverySearchParams(sourceSlug, {})` (currently `size = null`, `sort = "name-asc"`, `page = 1`);
   - load the same first-page candidate window used by the collection route, using its shared page-size contract (currently `COLLECTION_PAGE_SIZE = 24`), **not** a homepage-specific `pageSize: 4`;
   - apply the same `orderByFeaturedSlugs(pageProducts, collection.featuredProductSlugs)` step the collection route applies to that page;
   - take the first 4 from that ordered page.
6. This intentionally matches the **current collection page's visible first-four behavior**, not a new global featured-first ranking. A featured slug outside the collection route's first candidate page remains outside that page; this feature must not introduce a second/global collection-order authority.
7. The fallback must resolve exactly 4 valid products; otherwise omit SPECIAL DEALS rather than render a partial grid or invent placeholders.
8. Do not add `manualProductSlugs` or another config/database owner for the same meaning.
9. Do not fall back to newest products, bestsellers or another category/collection.
10. Do not duplicate products or mix automatic fallback products into a non-empty manual selection.

"Belongs to the source collection" means the same membership predicate that makes the product appear on `/collections/<slug>`; implementation should reuse that boundary/helper rather than create a second membership rule solely for the homepage. If sharing the collection first-page contract requires extracting a small helper/constant, preserve one owner for the page-size/default-order rule rather than copying the literal `24` into homepage code.

#### Collection destination reachability

A source collection is valid for this homepage section only when the existing public collection route would actually render it. Under the current code that means:

- `readPublishedCollection(slug)` resolves a published collection; **and**
- `collection.description?.trim()` is non-empty, matching `loadCollectionRoute()`'s current `notFound()` gate.

Do not treat `isPublished = true` alone as a valid CTA destination. Prefer one shared route-reachability helper/boundary if implementation needs this predicate in more than one place. If the configured source is not route-reachable, fail closed and omit this section rather than render a `Xem thêm` link that 404s.

#### Presentation

Desktop:

- 4 product cards in one row.
- Product card aspect/commerce presentation remains La.na.
- Section title/supporting copy follows La.na typography.
- `Xem thêm` appears after the product set and links to the source collection.

Mobile:

- 2 columns × 2 rows for the normal 4-product state, matching the approved reference rhythm.
- Same product truth and same card component semantics.
- `Xem thêm` remains clearly reachable after the grid.

#### Commerce and tracking

- Product price, discount, availability/preorder and badge rules come from existing product-card authority.
- No sale status may be inferred from the section title.
- Use one stable homepage list identity for analytics; changing campaign copy must not create a new tracking contract.
- Select-item indices must match the visible product order.

---

### 7.3 Collection promo row A — 2 image blocks

A reusable two-slot editorial collection row.

No shared section heading.

Each slot contains:

- homepage-specific editorial image;
- canonical collection title, derived from the resolved `CollectionDefinition.title` through the storefront display-title rule (below);
- CTA label;
- destination collection.

The visible title is the collection's canonical title, **not** a second editorial-title authority. If a future design needs a different marketing headline, that is a separate owner decision and must use a distinctly named field rather than overloading the collection title.

Storefront display-title rule (owner decision 2026-09-26, recorded in `la-na-design-owner-approved-facts-and-decisions.md` › Settled decisions): the stored `CollectionDefinition.title` remains canonical persistence and is shown unchanged in admin; every public surface, this row included, shows `toStorefrontCollectionTitle(CollectionDefinition.title)`, which only drops a leading administrative `BST` prefix. It is a mechanical derivation of the one canonical title, not a second title authority.

The exact two collections are intentionally **pending mapping**.

#### Layout

- Exactly 2 large image blocks.
- Edge-to-edge/full-bleed row with no generic card container.
- Wider than 640px: the two blocks sit side-by-side and each image owns 50% of the row in the normal two-slot state.
- Phone (640px and narrower): the two blocks stack, each a full-width 4:5 portrait photograph with its title + CTA centred at the foot (owner decision 2026-09-26, below).
- No rounded corners.
- Title + CTA overlay on the image, positioned consistently in the lower editorial area, centred horizontally at every width over a dark gradient scrim on the lower half of the photograph so the cream copy stays legible on pale photographs (owner request 2026-09-26, Claude Code session [`session_017vxPKk3MTUMv7D21UQJ7Ms`](https://claude.ai/code/session_017vxPKk3MTUMv7D21UQJ7Ms)).
- Image crop is editorial and fills the tile.

On a phone the row follows the Ding Dang reference's two stacked full-width portrait images — the owner's decision of **2026-09-26** ("chuyển 2 phần Banner Bộ Sưu Tập thành 2 ảnh dọc như dingdang"), recorded in `la-na-design-owner-approved-facts-and-decisions.md` › Settled decisions. It supersedes the earlier rule that the 50/50 rhythm holds on mobile. It is still the same two editorial photographs, not a card design: no card container, no rounded corners, copy overlaid on the image. Provenance: Claude Code session [`session_017vxPKk3MTUMv7D21UQJ7Ms`](https://claude.ai/code/session_017vxPKk3MTUMv7D21UQJ7Ms).

#### Link interaction contract

Desktop:

- the image/tile itself is not a link;
- **only the CTA** is clickable and opens the mapped collection.

Mobile/touch layout:

- the **whole tile** is a tap target to the same mapped collection;
- the visible CTA communicates the destination/action;
- implementation must use valid semantics with one canonical anchor target, not nested links.

#### Missing mapping behavior

- A promo row may stay absent until both collection slots are mapped with real approved homepage image/CTA data and route-reachable collection destinations; the visible title is then derived from `CollectionDefinition.title`.
- Never publish a fake collection or placeholder destination to preserve layout.
- Once enabled, both slots must resolve to **route-reachable** collection destinations: the same current public-route predicate as §7.2 (`readPublishedCollection()` succeeds and `description?.trim()` is non-empty). `isPublished = true` alone is insufficient because the collection page currently 404s without a description.
- If either mapped destination stops being route-reachable, omit the promo row rather than publish a broken CTA.

---

### 7.4 YOUR NEXT FAVOURITE — 4 category blocks

Purpose: primary category discovery, not another product grid.

Four required category roles, sourced from the canonical La.na category vocabulary:

1. Áo dài — `aoDai` → `/ao-dai`
2. Váy, đầm — `vayDam` → `/vay-dam`
3. Set đồ — `setDo` → `/set-do`
4. Phụ kiện — `phuKien` → `/phu-kien`

Do not duplicate these labels/hrefs as new category truth when they can be derived from `CATEGORY_NAVIGATION`.

#### Content

- section heading/supporting copy may be repository-configurable;
- each block image comes from the **existing `CategoryEditorialMedia.heroImageUrl` authority** for its category key, read through `readConfiguredCategoryHeroMedia()`; do not create `imageByCategoryKey` in a second homepage config;
- the loader must request all four required keys, including `phuKien`;
- visible label/href comes from the canonical category definition;
- each block links to its category destination.

#### Layout/rhythm

Desktop:

- 4 editorial category blocks in one visual row.

Mobile:

- 2 × 2 category rhythm.

Both: each category name is centred under its photograph (owner request 2026-09-24; pinned in `mobile-storefront-rhythm.spec.ts`).

Owner request 2026-09-24: the section heading and its supporting line sit in a column to the left of the four blocks on desktop (above them on mobile), and the blocks are separated by visible gutters rather than a hairline. Heading and category names use the display face; the supporting line uses the body face.

Presentation should follow the approved Ding Dang section rhythm while preserving La.na typography/color/spacing.

Category images are visual merchandising data. Missing media must not be replaced with invented photography.

#### Missing-media behavior

This section is an **all-or-nothing four-block composition**. After the existing trusted-media validation runs, all four required keys (`aoDai`, `vayDam`, `setDo`, `phuKien`) must have a valid `heroImageUrl`.

If any one image is missing or rejected by the trusted-media contract:

- omit the entire YOUR NEXT FAVOURITE section;
- do not render a 3-block partial grid;
- do not render an image-less tile;
- do not substitute another category image or placeholder.

This preserves the owner-approved 4-category rhythm and fails closed on incomplete merchandising data.

---

### 7.5 Collection promo row B — 2 image blocks

Same reusable component and exact contract as §7.3.

This is a second independent pair of collection promo slots, appearing **after** YOUR NEXT FAVOURITE.

The two mapped collections are intentionally pending.

Do not create a second component/design variant for this row unless a real requirement appears. Both promo rows should share one component/schema and differ only by config data.

---

### 7.6 Customer feedback image rail

Replaces the role previously discussed as the Ding Dang "Muse" area.

#### Homepage behavior

- Shows **images only** visually.
- No customer name, product name, quote or caption is rendered on the homepage.
- Images are manually selected and ordered in repository config.
- Horizontal rail/carousel rhythm similar to the approved reference.
- Touch users can swipe horizontally.
- Desktop users can scroll/drag/use an accessible control path.
- No autoplay requirement.
- No image should become a product/category link by default.
- Pressing a photograph opens it enlarged, uncropped, in an accessible viewer (a modal dialog with close, previous/next, `Escape` and arrow keys, focus returned to the photograph on close). This applies on the homepage rail and on `/feedback` (owner request 2026-09-24). The photograph is a button, never a link.
- Section title itself is **not a link**.
- At the end of the section, render `Xem thêm` linking to the dedicated feedback page.

Accessibility does not mean adding visible captions the owner did not request. Each configured feedback photo must still carry an appropriate manually authored accessible text decision (`alt` text when informative, or explicitly decorative empty alt when that is truly correct).

#### Dedicated feedback page

Create a simple La.na feedback-gallery page at `/feedback`:

- shows the full configured feedback image collection;
- no CMS/admin requirement;
- no quotes/captions are required by this spec;
- use the site's normal page chrome and La.na visual language;
- responsive image gallery/rail may be simple; do not create unrelated social-network features.

#### Public-route / SEO contract

`/feedback` is an **evergreen public, indexable gallery route** when global search indexing is enabled. It follows the same static-evergreen SEO behavior as the existing About/Contact-style pages:

- add `src/app/feedback/page.tsx` to `STOREFRONT_ROUTES` with `shell: true` and metadata mode `"page"`;
- provide a route-specific metadata builder (for example `src/routes/metadata/feedback.ts`) through the existing evergreen/static metadata boundary rather than hand-writing metadata in the page;
- add `/feedback` to the indexable static-path policy used by `shouldNoIndexRequest()`;
- add `/feedback` to `SELF_CANONICAL_STATIC_PATHS`, so the clean URL self-canonicalizes when indexing is enabled and has no canonical for query-string variants, matching existing evergreen behavior;
- add `/feedback` to `STATIC_CANONICAL_PATHS`, so it appears in the sitemap when global indexing is enabled;
- query-string variants of `/feedback` remain noindex and do not self-canonicalize, consistent with the existing static-page metadata contract.

Metadata copy must come from **owner-approved/config-owned feedback content**, not from freehand implementation prose. The feedback config therefore owns explicit metadata text (title + description) or references another approved content authority; exact copy is pending owner/content mapping and must be supplied before the route is considered production-ready.

---

### 7.7 Footer

After Feedback, go directly to the existing footer.

Do **not** render these old homepage sections between Feedback and Footer:

- Service strip;
- Brand story.

Their underlying brand/policy facts remain valid elsewhere; this is a homepage composition change only.

## 8. Config/data ownership

Add repository config **only for homepage data that does not already have an authority**. Do not create parallel sources for manual products or category editorial media.

Existing authorities that must be reused:

- **Manual SPECIAL DEALS override:** `HomepageFeaturedProduct` → `listHomepageFeatured()` / the existing configured homepage-featured runtime seam. This ordered website-owned list becomes the manual override source for §7.2.
- **YOUR NEXT FAVOURITE images:** `CategoryEditorialMedia.heroImageUrl` → `readConfiguredCategoryHeroMedia()` for `aoDai`, `vayDam`, `setDo`, and `phuKien`.
- **Category label/href:** `CATEGORY_NAVIGATION`.
- **Collection public truth:** `CollectionDefinition` + the current collection-route reachability predicate.

A focused repository-owned homepage config may own only values that have no existing canonical owner, for example:

```ts
type HomepageConfig = {
  specialDeals: {
    supportingCopy?: string;
    sourceCollectionSlug: string;
  };

  promoRows: readonly [
    readonly [CollectionPromoSlot | null, CollectionPromoSlot | null],
    readonly [CollectionPromoSlot | null, CollectionPromoSlot | null],
  ];

  categoryDiscovery: {
    title: string;
    description?: string;
  };

  feedback: {
    title: string;
    pageHref: "/feedback";
    ctaLabel: "Xem thêm";
    metadataTitle: string;
    metadataDescription: string;
    images: readonly {
      src: string;
      alt: string;
    }[];
  };
};

type CollectionPromoSlot = {
  collectionSlug: string;
  imageSrc: string;
  ctaLabel: string;
};
```

This is a **contract sketch**, not a requirement to copy the exact TypeScript names.

Recommended ownership for this new, non-brand-fact content: `src/content/homepage.config.ts` (final file name may follow an existing nearby convention discovered during implementation). Keep campaign/editorial data out of `src/brand/*.config.ts`, whose current repository contract is reserved for owner-approved brand/taxonomy authority.

Rules:

- **Do not** add `manualProductSlugs`, product IDs/slugs, or another manual-product list to homepage config.
- **Do not** add `imageByCategoryKey` or another category-image map to homepage config.
- **Do not** add a promo `title` that duplicates `CollectionDefinition.title`; derive the visible collection name from the resolved collection.
- Promo `imageSrc` is intentionally homepage-slot-specific editorial media and may differ from the collection detail hero; this is a distinct surface role, not a duplicate collection-title authority.
- Resolve collection destinations through the same route-reachability truth as §7.2/§7.3, not publication state alone.
- External/remote image input remains untrusted and must pass the existing trusted-media policy where applicable.
- Local repository assets must use stable public paths.
- Do not add a database migration for homepage config in this scope.
- Do not add an admin panel/CMS in this scope.
- Do not duplicate collection titles/links across multiple files when one existing authority can own them.

## 9. Data/loading architecture

Keep the established split:

- `src/app/page.tsx`: render markup/components only.
- `src/routes/home.ts`: load/resolve homepage data, pricing windows and tracking.
- pure view-model helpers: resolve product cards/config state without direct request/DB dependencies.
- `src/commerce/`: canonical collection/product reads remain here.
- `src/components/brand/`: promo row, category discovery and feedback rail presentation.

`SPECIAL DEALS` manual selection must reuse the existing `HomepageFeaturedProduct` authority. When that authority is empty, fallback must reproduce the collection route's current unfiltered page-1 surface exactly as §7.2 defines: shared first-page candidate window/default sort, then `orderByFeaturedSlugs`, then take 4. YOUR NEXT FAVOURITE media must reuse `CategoryEditorialMedia.heroImageUrl` for the four canonical category keys.

Any homepage link to `/collections/<slug>` must resolve through the current public collection route's reachability contract, not merely `isPublished`.

Because the refreshed homepage has only one product grid, its pricing refresh window should be derived from that one priced product set plus any existing hero behavior that already applies; do not keep stale refresh dependencies for removed product grids.

## 10. Responsive behavior

Representative acceptance widths:

- ~390px mobile
- ~768px tablet
- ~1024px desktop
- ~1440px wide desktop

Requirements:

- no horizontal page overflow;
- full-bleed editorial rows reach intended page edges;
- product section remains usable at 2 columns on mobile;
- collection promo rows preserve the two-image composition;
- category discovery is 2×2 mobile / 4-across desktop;
- feedback rail scrolls horizontally without clipping controls or trapping focus;
- overlay text remains readable over real configured images;
- all tap targets remain practical (~44px where feasible).

## 11. Accessibility

Must satisfy the project accessibility bar:

- semantic headings in logical order;
- native links/buttons;
- visible keyboard focus;
- CTA accessible names identify their destinations;
- mobile "whole promo tile" behavior must not create nested anchors;
- feedback rail must be keyboard reachable/operable;
- no hover-only information required to understand a destination;
- image alt behavior follows semantic purpose;
- no color-only state;
- text/controls meet project contrast expectations;
- reduced-motion preferences remain respected by any animated/scroll behavior.

## 12. Performance

- Use `next/image` / existing image delivery patterns.
- Give images stable dimensions/aspect boxes to prevent CLS.
- Do not eagerly load all below-fold editorial/feedback images.
- Preserve priority only for the true first/LCP hero image.
- Feedback rail should not force the entire full feedback gallery to eager-load.
- Do not add a carousel dependency when native scroll/snap + minimal client behavior can satisfy the contract.

No performance claim is valid without before/after measurement during implementation verification.

## 13. Testing strategy

### Domain/unit tests

Add focused tests for:

- SPECIAL DEALS selection priority: existing `HomepageFeaturedProduct` manual override > collection fallback;
- manual authority order preservation and first-4 bound;
- manual first-4 products must match the configured source collection using the canonical collection-membership truth; a cross-collection or short manual set omits the section rather than falling back;
- fallback resolves the same unfiltered collection page-1 candidate window/order as the public collection route (currently 24/name-asc), applies `orderByFeaturedSlugs`, then takes 4; a regression must prove that using `pageSize: 4` would be wrong when a featured product is later within the public first-page window;
- no newest/bestseller fallback;
- canonical category order/keys and category images sourced from existing `CategoryEditorialMedia` rather than duplicate config;
- YOUR NEXT FAVOURITE renders only when all four required trusted images resolve; any missing/rejected image omits the whole section;
- promo rows derive only from configured/mapped slots;
- collection CTA destinations reject/omit published-but-route-unreachable collections (including missing/blank description under the current route contract);
- feedback config order preservation;
- removed old homepage sections are no longer part of the home view model/order where that logic is modeled.

### Integration/runtime tests

Verify:

- homepage section order exactly matches §7;
- Hero remains unchanged;
- SPECIAL DEALS `Xem thêm` opens the configured route-reachable source collection;
- promo row A and B CTA/link semantics differ correctly between desktop/mobile hit areas;
- promo visible titles come from canonical `CollectionDefinition.title`, not duplicate homepage config;
- category blocks link to canonical category routes;
- YOUR NEXT FAVOURITE is absent rather than partial when any of its four trusted images is unavailable;
- Feedback title is not a link;
- Feedback `Xem thêm` opens `/feedback`;
- feedback page renders configured full gallery;
- `/feedback` is declared in the storefront manifest with page metadata mode, is indexable only under the existing global search-exposure gate, self-canonical on the clean URL, noindex/no-canonical with query state, and included in the static sitemap paths;
- feedback metadata title/description are read from approved/config-owned feedback content rather than authored ad hoc by the route/page;
- Service strip and Brand story are absent from homepage;
- route/page boundary tests remain green;
- product cards preserve pricing/availability semantics.

### Browser verification

At representative mobile + desktop widths:

- visual section order/rhythm;
- full-bleed image edges;
- 4-product 2×2 mobile grid / 4-across desktop;
- two-image promo composition;
- category 2×2 / 4-across behavior;
- swipe/scroll feedback rail;
- desktop CTA-only promo click target;
- mobile full-tile promo tap target;
- keyboard focus path;
- clean console;
- accessibility scan;
- no unexpected layout shift from images.

## 14. Boundaries

### Always do

- Reuse canonical product, collection, category, pricing and availability truth, including existing `HomepageFeaturedProduct` and `CategoryEditorialMedia` authorities.
- Validate repo-owned config at a clear boundary.
- Keep homepage page-layer imports within the existing route/brand/component boundary.
- Preserve La.na design tokens and typography.
- Use real configured content only.
- Add regression tests before/with changed behavior.
- Verify mobile and desktop runtime output.

### Ask first

- Any DB schema/migration.
- Any new dependency/carousel library.
- Any new CMS/admin UI.
- Any new remote media host.
- Changing hero behavior.
- Changing collection/category public route semantics.
- Changing feedback canonical route away from `/feedback`.
- Changing product-card commerce behavior.

### Never do

- Copy Ding Dang brand identity/assets/copy.
- Invent customer feedback images, collection names, promo destinations or brand prose.
- Derive sale/discount truth from homepage section naming.
- Fall back to newest/bestseller when the configured source is missing.
- Cross-merchandise manual SPECIAL DEALS products from outside the configured source collection.
- Silently filter/top-up an inconsistent non-empty manual SPECIAL DEALS selection.
- Create a second manual-product authority or a second category-editorial-image authority for the homepage.
- Create a second canonical collection-title authority for promo tiles.
- Render a collection CTA from publication state alone when the current public route would 404.
- Render a partial YOUR NEXT FAVOURITE grid when any required category image is missing/untrusted.
- Duplicate products as filler.
- Add fake placeholder campaign media to keep a row visible.
- Make unrelated PDP/PLP/cart/checkout refactors.
- Remove failing tests to make CI pass.

## 15. Success criteria

The feature is accepted when all of the following are true:

1. Homepage order after Hero is exactly:
   `SPECIAL DEALS (4 products) → promo pair A → 4 categories → promo pair B → feedback rail → footer`.
2. Old lower homepage sections are not rendered.
3. `SPECIAL DEALS` remains one fixed 4-product section; implementation does not generalize it into alternate campaign-section roles.
4. Existing `HomepageFeaturedProduct` is the only manual override authority. A non-empty manual set must resolve exactly 4 visible products and all 4 must belong to the configured source collection; inconsistent manual data omits SPECIAL DEALS rather than cross-merchandising or falling back.
5. When the manual authority resolves empty, collection fallback must reproduce the public collection route's current unfiltered page-1 ordering: load the shared first-page candidate window (currently 24/name-asc), apply `orderByFeaturedSlugs`, then take 4. It must resolve exactly 4 products and must not invent a new global featured-first ranking.
6. `Xem thêm` from SPECIAL DEALS opens a route-reachable configured source collection; a merely-published collection that the current collection route would 404 is not valid.
7. Both promo rows use one reusable component/config contract; visible promo names are derived from canonical `CollectionDefinition.title`.
8. Each promo slot maps to a route-reachable real collection; desktop only CTA is clickable, mobile whole tile is tappable.
9. YOUR NEXT FAVOURITE contains exactly the four canonical roles: Áo dài / Váy, đầm / Set đồ / Phụ kiện, and their images come from existing `CategoryEditorialMedia.heroImageUrl` authority. Missing/untrusted media for any one role omits the whole section.
10. Feedback homepage section visually renders images only, scrolls horizontally, and ends with `Xem thêm`.
11. `/feedback` renders the complete configured image collection and follows the evergreen public SEO contract: manifest-declared page metadata, indexable under the global exposure gate, clean-URL self-canonical, query variants noindex/no-canonical, and included in static sitemap paths.
12. Feedback metadata title/description come from approved/config-owned content; implementation does not invent brand/SEO prose.
13. Font, palette, product-card language and overall identity remain La.na.
14. Editorial image blocks are full-bleed/no rounded generic cards.
15. No new CMS/admin/database schema/dependency is introduced without separate approval.
16. Responsive, keyboard, accessibility and clean-console checks pass.
17. Repository lint/type/test/build gates relevant to the change pass.
18. Final review has 0 Critical and 0 Required findings.
19. Project Definition of Done is satisfied before merge.

## 16. Explicitly out of scope

- Mapping the exact four collection promo destinations now.
- Redesigning the hero.
- Redesigning product cards.
- New admin/CMS UI.
- Database schema for homepage composition.
- Customer feedback text/reviews/ratings.
- Instagram/Facebook ingestion.
- Gifts to Discover section.
- Homepage Service strip.
- Homepage Brand story.
- Changes to product/collection/category commerce authority.
- Deployment.

## 17. Pending content, not missing requirements

These values are intentionally supplied later through config and do not block the component contract:

- exact current supporting copy for SPECIAL DEALS, if any;
- source collection for SPECIAL DEALS;
- any manual SPECIAL DEALS product selection is supplied through the existing `HomepageFeaturedProduct` authority, not this config;
- four collection promo mappings and their homepage-specific images/CTA copy; visible collection titles are derived from `CollectionDefinition.title`;
- category editorial images;
- feedback image set, each photograph with its natural `width`/`height` and a manually authored accessible alt decision (§7.6);
- feedback heading and metadata title + description, supplied as approved/config-owned copy before the public route is production-ready.

No implementation may invent these values in order to make a screenshot look complete.
