# Spec: La.na Design — Brand Truth, Storefront FE, Fulfillment, Inventory Selling Modes

**Status:** Owner-approved for implementation planning (2026-09-16)  
**Repository:** `nguyentuanson27-netizen/la.na_design_storefront`  
**Runbook alignment:** Giai đoạn 2 = Brand Config/static brand truth; Giai đoạn 3 = design/UI rewrite. Inventory selling modes are a cross-cutting commerce feature and must not be hidden inside presentation-only work.

---

## 0. Authority and precedence

This spec consolidates three classes of inputs:

1. **Owner-approved interview decisions in the current conversation** — newest authority. These override older documents when they conflict.
2. **Owner-supplied source documents/assets** — the terms/policy document, size-guide images, logo/social/favicon assets, legal-info screenshot.
3. **Existing repository implementation** — useful for integration constraints, but **not** a source of brand truth. Stale LA Clothing facts must not be preserved just because they already exist in code.

When a source document and a newer owner decision disagree, the newer owner decision governs and the public policy/documentation must be updated to current truth.

### Known source conflicts that must be corrected

- The supplied terms document currently says bank transfer is supported; current owner decision is **COD only on the website**, with bank transfer temporarily unavailable.
- The supplied terms document has placeholders for support/contact details that are now known.
- Existing repository Brand Config/navigation/size guides still contain LA Clothing / menswear truth and must not survive Giai đoạn 2.
- Existing fulfillment config has partial values that differ from the current owner-approved carrier list and delivery window.

---

## 1. Assumptions and implementation posture

### Confirmed product assumptions

- Storefront language/market remains Vietnam: `vi`, `VN`, `VND`.
- Existing Pancake catalog/order integration remains the external commerce integration.
- Website-owned brand/editorial/operational decisions must remain separate from Pancake-owned mirrored facts.
- `SEARCH_INDEXING_ENABLED=false` stays the default until the release/indexing gate.
- No production deployment is part of this spec.

### Engineering assumptions that require verification during planning

- Existing admin/product content can be extended rather than replaced.
- Current stock calculation remains authoritative; selling modes modify **sellability thresholds**, not the definition of physical stock.
- Oversell/preorder support may require a Prisma migration and a server-owned concurrency/reservation mechanism. A naive read-then-write against mirrored stock is not sufficient for the requested atomic limit enforcement.
- Pancake order submission must be verified to accept orders when mirrored stock is zero/negative; if the upstream API rejects them, implementation must surface the incompatibility rather than claim the feature works.

---

## 2. Objective

Build La.na Design as a distinct women’s fashion storefront, replacing inherited LA Clothing public truth while preserving the Core Kit architecture and commerce integrations.

Success means:

- the brand, legal, contact, taxonomy, size, fulfillment and SEO facts all trace to this spec/source authority;
- the storefront FE has a warm, feminine editorial-commerce aesthetic inspired by the **layout rhythm and visual grammar** of Lalin, without cloning it;
- product browsing and buying remain clear and performant;
- product availability supports `standard`, `oversell`, and customer-facing `preorder` modes with explicit, tested server-side rules;
- no secret, placeholder fact, fake collection, fake badge, fake stock state, or inherited Brand #1 fact is presented as La.na Design truth.

---

## 3. Verified current technical context

Current repository stack/config to preserve unless a task proves a change is necessary:

- Next.js 16.2.11
- React 19.2.0
- TypeScript 5.9.x
- Prisma / Prisma Client 7.9.1
- PostgreSQL
- Better Auth 1.6.25
- Tailwind CSS 4.x
- pnpm 11.4.0
- Node >= 22.14.0

Existing useful commands:

```bash
pnpm dev
pnpm lint
pnpm typecheck
pnpm test:domain
pnpm test
pnpm test:db
pnpm build
pnpm release:check
```

No command result is implied by this spec; each must actually be run during implementation/verification.

### Relevant project structure

Use the existing repository ownership boundaries rather than creating a parallel architecture:

```text
docs/specs/             owner facts + this master spec
src/brand/              brand/config truth and schemas
src/app/                Next.js route composition and public/admin route entry points
src/components/         presentation components
src/commerce/           headless commerce, cart/order/admin commerce logic
src/domain/             domain rules that are not presentation-specific
src/integrations/       external integrations such as Pancake
src/seo/                SEO/search exposure builders and policies
prisma/schema.prisma    durable website-owned and mirrored data contracts
tests/domain/            domain/config/contract tests
tests/integrations/      external-boundary integration tests
tests/database/          persistence/concurrency/database tests
```

New work should stay in the narrowest existing owner. Brand presentation must not absorb commerce rules, and Pancake-mirrored fields must not become the storage location for website-owned selling policy.

### Code-style / ownership conventions

Follow the codebase's current TypeScript/ESM style rather than introducing a new style system:

```ts
import type { FulfillmentConfig } from "./schema.ts";

export const FULFILLMENT: FulfillmentConfig = {
  delivery: {
    coverage: "Giao hàng toàn quốc",
    carriers: ["GHN", "GHTK", "Viettel Post", "J&T"],
  },
  // ...other owner-approved sections
};
```

Conventions:

- use `import type` for type-only dependencies and explicit ESM extensions consistent with the repository;
- keep brand facts/config declarative and owner-traceable rather than embedding them in JSX/page prose;
- use intent-revealing domain names; avoid generic abstraction layers that are not required by this spec;
- preserve current brand/headless dependency direction; type-only seams are acceptable where the repository already uses them;
- keep changes scoped: no unrelated formatting/refactors mixed with Brand #2 implementation.

---

# PART A — OWNER-APPROVED BRAND TRUTH

## 4. Project identity

These project facts are already settled:

```text
projectSlug:       la-na-design
databaseName:      la_na_design
composeProjectName: la-na-design
productionDomain:  www.lanadesign.vn
```

Canonical domain is `www.lanadesign.vn`; bare apex is not canonical authority.

---

## 5. Brand identity

### Public brand name and copy

```text
name: La.na Design
displayNameUpper: La.na Design
headline: La.na Design - charismatic in every yard of cloth.
tagline: Thời trang nữ thiết kế thanh lịch với áo dài, váy và set đồ
strapline: Charismatic in every yard of cloth.
positioning: La.na Design là thương hiệu thời trang nữ thiết kế, tập trung vào áo dài, váy và set đồ với phong cách thanh lịch, nữ tính
socialCardAlt: La.na Design - Thời trang nữ thiết kế thanh lịch, nữ tính
```

Despite the existing field name `displayNameUpper`, the approved value is **not uppercase**.

### Search alias

- Primary/display brand name: `La.na Design`
- Search/SEO alias: `Lana Design`
- Alias may be used in structured data/search matching and natural SEO copy.
- Alias must **not** replace the public display name.

### Homepage SEO

```text
<title>: La.na Design | Áo dài & Thời trang nữ thiết kế
meta description: La.na Design - thời trang nữ thiết kế với áo dài cách tân, áo dài Tết, áo dài cưới, áo dài 4 tà, áo dài 6 tà, váy, set đồ và phụ kiện.
```

### Homepage brand-story copy

```text
La.na Design mang đến những thiết kế thời trang nữ thanh lịch, nữ tính, với điểm nhấn là áo dài, váy và set đồ được chọn lọc kĩ lưỡng và tỉ mỉ.
```

---

## 6. Legal and contact truth

### Customer-facing business/support contact

```text
Business / return address: 212 Nguyễn Trãi, Đại Mỗ, Hà Nội
Hotline + Zalo: 0923159666
International phone (derived): +84923159666
Customer support email: la.nadesignsince2022@gmail.com
Facebook: https://www.facebook.com/la.nadesign.vn
Support hours: 08:00–22:00, Monday–Sunday, UTC+7
```

### Legal entity

```text
Legal name: CÔNG TY TNHH QUỐC TẾ THƯƠNG MẠI LAS
Tax ID: 0111242251
Tax ID issue date: 7/10/2025
Registered address: Số 06 Đường Manor 2str, Sunrise C, KĐT The Manor Central Park, Phường Định Công
Corporate/legal email: congtytnhh.las@gmail.com
```

Rules:

- Registered address and business/return address are **distinct concepts** and must not overwrite each other.
- Legal representative must **not** be rendered publicly on the storefront.
- Corporate/legal email is for legal/company information; customer service uses the support email.
- About/legal footer may display legal name, registered address, tax ID, issue date and legal email.

---

## 7. Merchant apparel defaults

```text
feedBrand: La.na Design
defaultGender: female
defaultAgeGroup: adult
market: Vietnam / vi / VND
```

Product category authority: La.na Design is a women’s fashion brand, including áo dài, dresses, sets and accessories.

---

## 8. Brand assets

Owner supplied three distinct asset roles:

1. **Master logo** — use for header + footer only.
2. **Social card** — separate campaign/social image; do not derive from master logo.
3. **Favicon source** — separate square logo asset; do not derive from master logo.

Do not regenerate or stylistically alter approved assets during implementation unless the owner explicitly requests it. Resizing/cropping for delivery formats is allowed when it preserves the approved visual content.

Hero/mega-menu/category-editorial campaign images remain content-managed/pending unless explicitly supplied.

---

## 9. Visual direction

- Primary palette: warm brown / chocolate brown.
- Supporting palette: light / cream backgrounds.
- ~~Heading / brand display typography: elegant serif.~~
- ~~Body, navigation, forms, prices, transactional UI: clean sans-serif.~~
- **Owner amendment 2026-09-24:** the typefaces are now Josefin Sans (display: headings, product names, category labels, navigation, prices, buttons) and Mulish (body: descriptions, small print, forms, transactional copy), both with Vietnamese subsets; the class is `font-display`.
- Mood: feminine, refined, modern, image-first, editorial-fashion.
- Reference: use Lalin as inspiration for **rhythm, whitespace, image-led storytelling, collection identity and restrained ecommerce chrome**; do not clone its UI, colors, copy or layout pixel-for-pixel.

---

# PART B — INFORMATION ARCHITECTURE AND SEO

## 10. Primary navigation

Top-level order is fixed:

1. Áo dài
2. Set đồ
3. Váy, đầm
4. Phụ kiện
5. Hàng mới về
6. Bộ sưu tập
7. Sale

Logo links to `/`. There is **no** top-level `Trang chủ` menu item.

### Áo dài

`Áo dài` is a clickable landing/category page, conceptually `/ao-dai`, and has five level-2 categories:

- Áo dài cách tân
- Áo dài Tết
- Áo dài cưới
- Áo dài 4 tà
- Áo dài 6 tà

Exact nested slugs should follow the existing route convention, but hierarchy must remain category → subcategory → product and each subcategory must have a crawlable URL.

### Set đồ

Clickable category with level-2 categories:

- Set váy
- Set quần áo

### Other route decisions

- `/collections`: keep as an aggregate collections landing page.
- Child collections: currently **none approved**. Do not invent placeholders/fake collections.
- `/new-arrivals`: keep; shows newest products automatically.
- `/sale`: keep; shows products with a real current promotion/discount only.
- `/shop`: keep as `Tất cả sản phẩm`, but do not include it in primary navigation.
- `/contact`: keep with contact form.
- `/lookbook`: remove from public route/navigation scope.
- `/flash-sale`: remove; `/sale` is the single promotion landing page.

### SEO requirements

- The `/ao-dai` landing page must have unique title/H1/meta copy based only on approved brand/category terms.
- Copy may naturally target both `La.na Design` and search alias `Lana Design`, but public brand display remains `La.na Design`.
- Do not create near-duplicate doorway pages solely for keyword spelling variants.
- Category/subcategory pages must be internally linked from navigation and relevant editorial sections.
- Breadcrumb hierarchy must reflect the real category structure.

Exact `/ao-dai` title/H1/meta copy beyond the approved homepage metadata is not yet owner-approved and should be drafted for review rather than silently invented.

---

# PART C — SIZE GUIDE TRUTH

## 11. Size-guide semantics

There are exactly three approved guides. A product is mapped manually to the correct guide; category alone must **not** determine the guide because Set/Váy products may use either wide-form or small-form sizing.

Logical IDs:

```text
ao-dai
set-vay-form-rong
set-vay-form-nho
```

Rules:

- `Ngực / Eo / Mông` are **body circumferences**, not garment measurements.
- Body measurements and height use `cm`.
- Weight uses `kg`.
- **No fixed tolerance applies.** Do not encode `±1`, `±2`, `±3`, or `0 cm` as a fake tolerance.
- Guidance: bảng size chỉ mang tính tham khảo, tùy form dáng sản phẩm; customer should contact La.na Design for size advice.

### 11.1 Áo dài

| Size | Ngực (cm) | Eo (cm) | Mông (cm) | Chiều cao (cm) | Cân nặng (kg) |
|---|---:|---:|---:|---:|---:|
| S | 86 | 62–78 | 96 | 153–160 | 43–52 |
| M | 92 | 66–82 | 102 | 158–165 | 52–62 |
| L | 98 | 70–86 | 108 | 160–170 | 62–72 |

### 11.2 Set/Váy form rộng

| Size | Ngực (cm) | Eo (cm) | Mông (cm) | Chiều cao (cm) | Cân nặng (kg) |
|---|---:|---:|---:|---:|---:|
| S | 86 | 62–74 | 98 | 155–168 | 43–51 |
| M | 90 | 66–78 | 102 | 155–168 | 51–57 |
| L | 94 | 70–82 | 106 | 155–168 | 57–65 |
| XL | 98 | 74–88 | 110 | 155–168 | 65–75 |

### 11.3 Set/Váy form nhỏ

The source chart does **not** provide hip values; do not invent them.

| Size | Ngực (cm) | Eo (cm) | Chiều cao (cm) | Cân nặng (kg) |
|---|---:|---:|---:|---:|
| S | 84 | 62–66 | 155–168 | 43–50 |
| M | 88 | 66–72 | 155–168 | 50–57 |
| L | 92 | 72–76 | 155–168 | 57–64 |
| XL | 96 | 76–80 | 155–168 | 64–72 |

### Integration constraint

Existing `ProductContent.sizeGuide` can be reused semantically as `sizeGuideId` if doing so is clear and validated; do not add a duplicate persistence field without reason.

Current shared type requires `toleranceCm: number`; that cannot truthfully represent “no fixed tolerance.” The implementation must minimally change the type/loader so “none” is representable instead of abusing `0`.

---

# PART D — FULFILLMENT, PAYMENT, RETURNS, SUPPORT

## 12. Delivery

```text
Coverage: nationwide Vietnam
Carriers: GHN, GHTK, Viettel Post, J&T
Carrier selection: may vary by order/region
Hà Nội ETA: 1–3 days
Other provinces/cities ETA: 3–10 days
```

ETAs are estimates, not hard guarantees. They may extend due to peak periods, weather, carrier issues or force majeure.

Tracking:

- La.na Design does **not** proactively send a carrier tracking code/link by default.

Order confirmation:

- Calls are not mandatory for every order.
- System may confirm automatically.
- Call/message/email is used when verification or exception handling is needed.

---

## 13. Returns / exchange / refund

### Return window

- 15 days from customer receipt.

### Product conditions

Returned product must remain new/unused, retain tags, not be torn/dirty/damaged, have no unusual smell or signs of use, and must be the correct La.na Design item.

### Supported cases

Approved cases:

- manufacturer defect / manufacturing-origin stain/problem;
- shop shipped wrong size;
- shop shipped wrong model;
- shop shipped wrong color;
- customer voluntarily exchanges to another model, subject to conditions.

Do **not** preserve extra legacy policy clauses that are not supported by the owner-approved source, such as a separate customer right to exchange size/color when the shop fulfilled correctly, unless separately approved later.

### Fees

- Customer-initiated exchange to another model: `50,000 VND / product` + customer pays two-way shipping.
- Shop/manufacturer fault or shop mis-fulfillment: La.na Design pays 100% of reasonable exchange/return shipping.
- Restocking fee: `0`.
- Non-returnable category blacklist: none.

### Non-defective refund

- No refund simply because the customer changes their mind when the product is correct and non-defective.

### Refund

- Refund processing target: 7–10 working days after returned goods are received, inspected and approved.
- Prefer original payment method when practical; otherwise bank transfer or another mutually agreed method.

### Return channels

- Direct return at `212 Nguyễn Trãi, Đại Mỗ, Hà Nội`.
- Mail/carrier return to the same address following shop instructions.

---

## 14. Payment

Current website payment availability:

- **COD enabled.**
- **Bank transfer temporarily unavailable on the website.**

Public payment policy must say exactly:

> Chuyển khoản ngân hàng hiện tạm thời chưa khả dụng trên website.

Do not display bank account details or a selectable bank-transfer method until explicitly re-enabled.

---

## 15. Complaints and support

- Hotline/Zalo: `0923159666`
- Support email: `la.nadesignsince2022@gmail.com`
- Facebook: `https://www.facebook.com/la.nadesign.vn`
- Contact form: `/contact`, sends to the support email.
- Complaint/feedback response target: 24–48 working hours after sufficient information is received.

---

# PART E — FRONTEND / DESIGN SPEC

## 16. Homepage structure

Fixed order:

```text
Hero slider
→ Hàng mới về
→ Áo dài La.na Design
→ Featured products
→ Category editorial
→ Service strip
→ Brand story
→ Footer
```

`Bộ sưu tập` homepage section is hidden until at least one real child collection is approved/published.

---

## 17. Hero slider

- 2–3 campaign slides when real configured media exists; zero valid slides omit the hero entirely.
- Hero is full-bleed from the top of the viewport on desktop and mobile.
- Each slide contains **image + one CTA only**; no campaign title, description, dots or arrow controls.
- CTA text: `MUA NGAY`.
- CTA overlays the image on both desktop and mobile and each slide keeps its own real destination.
- Auto-advance interval: **2 seconds**.
- Pause autoplay while the hero is hovered, keyboard focus is inside it, or a pointer/touch interaction is in progress; resume after that interaction ends.
- Swipe/drag navigation remains available and a swipe does not permanently disable autoplay.
- If only one valid slide exists, render a stable static hero with the same CTA and no carousel semantics.
- Respect `prefers-reduced-motion`: reduced motion disables auto-advance while preserving appropriate manual/swipe interaction.
- Only the initial/LCP image is eagerly preloaded; hidden slides stay out of the tab order.
- A real first-surface hero opts the page into the shared transparent-header overlay contract; no hero means normal cream header.

---

## 18. Hàng mới về product grid

- 4 products per row on desktop.
- 2 columns on mobile.
- Large editorial image cards with generous spacing.
- Image aspect ratio: **2:3 (width:height)** on desktop and mobile.
- Desktop hover: switch to second product image when available; otherwise remain on the first image.
- Card default content: image + product name + price only.
- Product name: display face (Josefin Sans; was serif, see the typography amendment above).
- Price: display face (Josefin Sans); other commerce text: body face (Mulish).

### Sale display

- sale price prominent;
- original price smaller + strikethrough;
- percentage discount badge;
- badge position: image top-right.

### Marketing badge priority

At most one marketing badge:

```text
Sale > Hàng mới > Bán chạy
```

Badges only appear from real authoritative data; never invent marketing status.

**Preorder is an availability state, not a marketing badge.** If a product is preorder, `Đặt trước` must remain visible even when the marketing badge slot is occupied; render it in a separate availability/status location.

---

## 19. Áo dài La.na Design homepage section

Layout:

- one large editorial image;
- short Vietnamese-only copy;
- natural balance of brand + SEO language;
- direct links to all five áo dài subcategories.

Approved semantic terms include:

- `áo dài La.na Design`
- `áo dài thiết kế`
- áo dài cách tân / Tết / cưới / 4 tà / 6 tà

Do not keyword-stuff.

---

## 20. Featured products

- Products are selected manually by admin.
- Ordering is admin-controlled.
- Do not substitute automatic bestseller/newest logic when manual selection is empty unless separately specified.

Storage/admin mechanism is a planning decision; avoid unrelated schema abstractions.

---

## 21. Category editorial

Exactly two blocks in a 50/50 desktop layout:

1. `Set đồ`
2. `Váy, đầm`

Each uses a large editorial image. The clickable label/CTA is the category name itself; do not add generic `Khám phá` copy unless design needs an accessible label.

`Phụ kiện` is not part of this homepage editorial section.

---

## 22. Service strip

Exactly these three facts:

- `Đổi trả trong 15 ngày`
- `Giao hàng toàn quốc`
- `Tư vấn size 08:00–22:00`

---

## 23. Brand story

Two-column layout:

- editorial image on the left;
- short approved brand copy on the right;
- link to `/about`.

Approved copy:

> La.na Design mang đến những thiết kế thời trang nữ thanh lịch, nữ tính, với điểm nhấn là áo dài, váy và set đồ được chọn lọc kĩ lưỡng và tỉ mỉ.

---

## 24. Header / navigation / search

### Header overlay contract

- On any page whose **first surface is a real hero image**, the header overlays that image transparently on desktop and mobile.
- Header logo/menu/icons keep the existing La.na warm-brown tone; they do not switch to white.
- Pages without a real first-surface hero use the normal cream/light header from the start.
- After a short scroll (current ~20px threshold), an overlay header becomes the normal cream/light header; scrolling back to the top restores transparency.
- The transition must not add layout shift or a separate cream plate above the hero.

### Desktop header

- Primary nav follows approved order.
- `Áo dài` and `Set đồ` use mega menus with editorial image + subcategory list.
- Mega-menu image is manually selected by admin/content manager.

### Header icons

- Search
- Account
- Cart
- No Wishlist in current scope.

### Mobile header

```text
menu / logo / search / cart
```

The centre brand slot is the master logo itself, not a text wordmark. The approved PNG has a transparent
background, so it sits on the cream header and on the scrolled/blurred header unchanged.

Search is directly reachable from the mobile header; Account remains inside the mobile menu rather than
occupying a top-level phone icon. Menu, Search and Cart controls use approximately 44×44px touch targets
while keeping the visible icons visually restrained.

Mobile navigation is full-screen. Subcategories are **collapsed**: each parent category shows its
own link plus a disclosure control, and one category's subcategory list is open at a time. Rows are
sized to the 44px touch target and nothing more, so the seven categories and the utility links fit
one phone screen.

### Search

- Full-screen search overlay.
- Suggestions: products + categories.
- No requirement for trending/popular search terms in this scope.

### Account

Unauthenticated Account click routes to `/login`.

### Cart

Cart icon opens a right-side cart drawer.

---

## 25. PLP / category listing

### Density

- Reduce excessive vertical padding between breadcrumb, title, explanatory copy, filters/result controls and the product grid without shrinking practical control targets.
- **Desktop acceptance:** at 1440×900, on a PLP with products and filters in their default/unexpanded state, the top edge of the first product image is visible inside the initial viewport on page load.
- **Mobile acceptance:** at 390×844, under the same product-bearing/default-filter conditions, the top edge of the first product image is visible inside the initial viewport on page load.
- Preserve responsive filter usability, URL/query semantics, product-card column counts, loading/error/empty states and accessibility announcements while meeting those fold criteria.

### Filters

- Size
- Price range
- Color
- Sale status

Mobile filter interaction:
- keep one compact `Bộ lọc · Sắp xếp` row above results;
- active conditions appear as removable chips with × controls;
- selecting size/color/sale or applying price updates URL-backed results **without closing the filter drawer**;
- the drawer footer stays fixed with `Xóa bộ lọc` and `Xem N sản phẩm`;
- `N` is the current server-backed result count;
- `Xem N sản phẩm` closes the drawer rather than applying a second hidden filter transaction.

### Sort

Default ordering is manually merchandised/admin-controlled.

This interview did **not** approve a new customer-visible sort menu beyond that default. Preserve only truthful sort options already supported by the product data; adding a new `Bán chạy` sort requires a defined real data source and separate review.

### Mobile product-card rhythm

- Keep two product columns on phone.
- Use a consistent 2px grid gap on phone listing surfaces where the shared product-grid pattern applies.
- On phone, shared product-listing grids run edge-to-edge to the viewport like the homepage grid; the page-shell gutter must not inset the product photography. Keep compact metadata inset inside each card.
- Product name: 14px, maximum two lines.
- Price: 14–15px and visually stronger than the product name.
- Supporting availability/metadata: 12px.
- Do not change desktop product-card column counts as part of this mobile refinement.

### Loading

- Infinite scroll.
- Must preserve usable back-navigation, loading/error state and accessibility status announcements.
- SEO/crawlability must not depend solely on client-side scrolling; expose stable crawlable page/cursor discovery or equivalent server-rendered linking.

---

## 26. PDP

### First-image hero and gallery

- The first trusted image remains the PDP's canonical first surface; if no trusted image exists, keep the truthful missing-media behavior and normal cream header.
- The transparent header may overlay the first image; there is no separate PDP hero field/schema and no hero CTA.
- **Desktop = the repository's existing Tailwind `lg` breakpoint and above.** Do not introduce a second custom breakpoint for this PDP refinement; below `lg`, this desktop refinement intentionally does not freeze the mobile/tablet structural flow.
- **At `lg` and above:** the gallery is a near-viewport-height media stage using `object-contain` so the full garment/model silhouette remains visible. Slide 1 contains image 1 full width; later slides group images `2+3`, `4+5`, etc. at 50/50, with an odd final image full width.
- **Desktop interaction:** right-half click advances, left-half click goes back, horizontal drag/swipe navigates in the same direction, first/last slides do not loop, and keyboard users have equivalent previous/next controls. Vertical wheel/trackpad/page-scroll gestures must continue to scroll the document rather than drive the gallery.
- **Initial-load priority:** slide 1 / trusted image 1 remains the first visible PDP surface even when `?variant=` preselects a variant whose mapped media is later in the gallery. The deep link must not replace the canonical first visible surface on initial load. After initial load, an explicit variant selection change may sync to mapped media; manual gallery navigation remains until the selected variant changes again.
- **Below `lg`:** use the mobile gallery contract: one horizontal swipe image at a time in an owner-approved **2:3 portrait frame (width:height)** with a compact `current/total` indicator. Preserve trusted source order; frontend code must not infer or reorder a "full body" hero. Tapping the current image opens a full-screen same-image lightbox using `object-contain`, horizontal swipe and an explicit close control. No multi-level pinch-to-zoom requirement. The desktop paired composition must not leak below `lg`.

### Information and buy panel

- **Desktop:** after the gallery, use one two-column information row. Left: product identity/editorial information. Right: price, availability/preorder, variant/size controls, size guide, purchase actions, purchase feedback, shipping and returns.
- The desktop purchase panel is **not sticky** and no nested sticky selector may overlap adjacent copy.
- **Below `lg`:** hide the `LA.NA DESIGN / SẢN PHẨM` identity eyebrow so the product name (26–30px) is the first identity text after the gallery, then show price/availability, applicable kind → size → color controls and purchase actions. Keep those selectors materially denser than desktop by reducing excess vertical gaps/chip padding while retaining practical ~44×44 touch targets. The below-`lg` gallery + product-info + quick-purchase redesign applies at representative 390px and 768px widths. This order follows the current selection authority; do not change the selection model merely to make color selectable before size. Keep one shared variant-selection/cart authority; do not create a second mobile selection state.
- The PDP renders no visible breadcrumb trail; structured breadcrumb/SEO authority remains separate from this presentation choice.
- **Below `lg`**, hide the promotion/Freeship strip while the PDP is at the initial top position and reveal it once the existing header scroll state becomes scrolled. Keep desktop PDP promotion behavior unchanged.
- Primary actions remain `Thêm vào giỏ` + `Mua ngay`.
- Size guide opens from `Hướng dẫn chọn size` into the existing accessible modal. The artwork itself is the only visible guide content apart from the close control: do not duplicate the guide heading/title/measurement notes around it or add framed modal chrome. Preserve the accessible dialog label, focus behavior, screen-reader-only measurement/guidance notes and semantic size table.
- Variant selectors on desktop PDP, below-`lg` PDP and the mobile quick-purchase sheet share one compact visual system:
  - keep the existing dimension names/copy and current selection order/eligibility;
  - show the currently selected value beside its dimension label when one exists, e.g. `Màu: Trắng`, without inventing a placeholder before selection;
  - use rectangular option chips with the existing La.na brown/cream palette: selected is the strongest state, default is a light neutral brand tint, and disabled/unavailable remains visibly distinct;
  - keep practical ~44px touch targets and visible keyboard focus while reducing excess group/chip spacing;
  - keep unresolved-kind size styling neutral and distinct from genuine sold-out presentation;
  - place `Hướng dẫn chọn size` directly below the size choices on every selector surface.
- This selector refinement is presentation-only: do not change `deriveStorefrontProjectionSelection`, option availability, variant resolution, add-to-cart/buy-now flows, or size-guide mapping.
- Each product maps manually to the correct size guide ID.

### Mobile sticky purchase bar

- If required options are incomplete, the sticky action names only dimensions that exist for product shapes supported by the current commerce authority: e.g. `Chọn size`, `Chọn màu / size`, `Chọn phân loại / size`, or `Chọn phân loại / màu / size` as applicable. Do not introduce a color-only purchase contract; current variant selection still requires size.
- The bottom sheet renders applicable controls using the same shared selection controller and follows kind → size → color; the size-guide trigger stays with size.
- There is no separate confirmation step. Once selection is complete, the sheet CTA is **`Thêm vào giỏ`**.
- A complete sticky summary shows selected values such as **`Nguyên bộ · Trắng · M`**, omitting dimensions that do not exist.
- Closing the sheet before purchase keeps current selection.
- Opening size guide from the sheet suspends/closes the sheet so only one modal/focus trap is active; closing the guide restores the sheet and focus to the size-guide trigger.
- Open the cart only after the existing async add mutation reports server-confirmed success (`result.ok === true` or an equivalent controller signal derived from it). The synchronous `"submitted"` signal is request-start only. On rejection, keep the sheet open and show purchase feedback.
- On confirmed success, close/suspend the selection sheet first, then open the existing cart drawer. Only one modal/focus trap may be active; cart becomes focus owner and the hidden sheet must not restore focus while cart is open.
- After confirmed success, the existing cart drawer shows the exact selected variant/options.
- Genuine unavailable combination uses **`Lựa chọn này tạm hết`** unless current authority proves a more specific dimension-wide statement. Do not say only `Size M tạm hết` for a color-bearing product unless every purchasable color for M is proven unavailable. Alternate valid combinations remain selectable; unresolved-kind state must not look sold out.

### Product details order

```text
Mô tả sản phẩm
→ Chất liệu
→ Thông số/fit
→ Hướng dẫn bảo quản
→ Giao hàng
→ Đổi trả
```

Desktop may distribute these truthful blocks between the product-information and purchase-information columns; mobile preserves a coherent stacked reading order.

### Variant UX

Standard out-of-stock variant:

- remains visible;
- disabled;
- shows `Hết hàng`.

For products that require a kind/classification:
- before a kind is selected, show the exact guidance **`Nàng chọn phân loại trước để xem size còn hàng`**;
- size inputs may remain non-selectable/`disabled` before kind selection exactly as the current selection authority returns them;
- that disabled state is neutral/unresolved and must not reuse genuine sold-out opacity, copy, badge, strike-through or other `Hết hàng` presentation;
- `Chưa chọn phân loại` and `Hết hàng` are distinct states;
- this task does not make sizes clickable before kind selection and does not change `deriveStorefrontProjectionSelection` or commerce purchasability rules merely to achieve the presentation distinction.

If user has not selected a required size:

- do not auto-select;
- do not add to cart;
- highlight selector and show `Vui lòng chọn size`.

### Buyer-facing copy and visual language

- Remove implementation-facing wording such as `Chọn loại × kích cỡ` and server/catalog explanations that do not help the shopper decide.
- Only communicate shopping facts already supported by repository authorities: price, availability, approved delivery/returns information and size guidance.
- Headings, prices and CTAs use the Josefin Sans display face; variants, body copy, forms and transactional UI use the Mulish body face (owner amendment 2026-09-24).
- Reduce wide uppercase tracking in small buyer information.
- Purchase actions use the approved warm brown/chocolate + cream palette instead of generic black/white pairing, on desktop and mobile.

### Related products

- manual admin selection first;
- if absent, fallback to same-category products;
- the current generic related surface is titled **`Nàng có thể thích`**;
- do not render a second visible eyebrow such as **`Sản phẩm liên quan`** above/beside that heading;
- use `Hoàn thiện phối đồ` only when an explicit merchandising authority identifies complementary pants, bags or accessories. Do not infer complementarity from category/name heuristics.

## 26A. Mobile cart and checkout UX

### Cart controls

- Mobile cart quantity decrement/increment touch targets are approximately 44×44px.
- Remove/delete is visually and interactively separate from the quantity control group.
- Quantity limits and mutation authority remain unchanged.

### Checkout mobile order

Mobile reading/action order is:

```text
Tóm tắt đơn (thu gọn mặc định, luôn thấy Đơn hàng (N) · Tổng)
→ Thông tin nhận hàng
→ Phí vận chuyển + Tổng tiền
→ BrandPreorderFulfillmentNotice (khi preorderNotice tồn tại)
→ Đặt hàng COD
```

- `N = sum(line.quantity)` across checkout lines; for 2 × A + 1 × B, show `Đơn hàng (3)`.
- When `preorderNotice` exists, preserve the existing fulfillment notice and its facts; render it before submit in mobile DOM/reading order. Do not recompute preorder/mixed-order fulfillment facts in presentation.
- Expanding the order summary shows product image, option label, quantity and line total.
- The displayed shipping fee and final total must precede the submit button in DOM/reading order; do not fake this with CSS-only visual reordering.
- Preserve one checkout form/server action/quote-proof workflow; do not fork submit logic.
- Reduce the mobile `THANH TOÁN` heading from the current oversized treatment while keeping desktop scale unchanged.
- Remove buyer-facing implementation wording such as `máy chủ` and `Pancake`; internal integration code/comments may retain technical names.

---

# PART F — INVENTORY SELLING MODES

## 27. Product selling modes

Every product has exactly one mutually exclusive mode:

```text
standard | oversell | preorder
```

`oversell` and `preorder` cannot be enabled simultaneously.

Logical website-owned fields:

```text
sellingMode: standard | oversell | preorder
negativeStockLimit: integer, default -20
```

The limit is configured once at product level but enforced **independently per variant**.

Example with limit `-20`:

- quantity `-19` can still be sellable in oversell/preorder mode;
- quantity `-20` is the hard stop and cannot accept another unit.

The selling policy is website-owned and must not be overwritten by Pancake catalog sync.

---

## 28. Standard mode

- Physical/effective stock > 0: normal available state.
- Stock <= 0: variant disabled and shows `Hết hàng`.

Existing effective stock computation remains authoritative unless a separate task changes it.

---

## 29. Oversell mode (`oversell`)

When effective stock is above the configured negative limit:

- product/variant remains purchasable even when stock <= 0;
- storefront shows normal available behavior;
- **no special customer-facing label**;
- feed/storefront availability should reflect that customer can actually buy.

At the hard negative limit:

- variant becomes disabled;
- shows `Hết hàng`;
- checkout/order commit rejects any purchase that would exceed the limit.

If admin turns off oversell while stock is already negative:

- preserve the negative stock value;
- do not reset to zero;
- block new sales under standard rules until stock becomes sellable again.

---

## 30. Preorder mode (`preorder`) — customer-facing name “Đặt trước”

When stock > 0:

- sell normally;
- do **not** show preorder state.

When stock <= 0 but remains above the negative limit:

- variant remains purchasable;
- product card must clearly show `Đặt trước`;
- PDP must clearly show `Đặt trước` and the CTA must communicate preorder semantics;
- cart/checkout/order confirmation must retain a clear preorder marker so the state is not lost after PDP;
- preorder availability is not allowed to be hidden by the Sale/New/Bestseller marketing badge priority.

At the hard negative limit:

- variant becomes disabled;
- shows `Hết hàng`.

### Preparation time

- 15 **calendar days** preparation time.
- Countdown/ETA basis begins when the order is **successfully confirmed by the system**.
- Shipping ETA is added **after** preparation:
  - Hà Nội: `15 calendar days preparation + 1–3 days shipping`
  - Other provinces/cities: `15 calendar days preparation + 3–10 days shipping`

### Mixed order

If an order contains ready-stock items and preorder items:

- hold the whole order;
- ship all items together in one shipment after the preorder item(s) are ready;
- customer-facing order ETA follows the slowest preorder readiness plus normal shipping window.

### Policy

Return/refund/payment policy is otherwise unchanged for preorder orders.

---

## 31. Atomic enforcement / concurrency requirement

Hard requirement:

- negative limit must be checked **server-side at the order commit boundary**;
- concurrent requests must not both pass a stale stock read and overshoot the limit;
- an order that would cross the hard limit must be rejected even if the earlier UI state showed availability.

Do not implement this as a simple application-level `read stock → compare → submit` sequence without transactional/serialized protection.

Because current stock is mirrored from Pancake and order submission crosses an external system boundary, the implementation plan must explicitly define how local reservations/committed quantities and Pancake submission interact, including failure/rollback/idempotency behavior.

---

## 32. Merchant feed / structured availability

### Owner intent

- Oversell sellable state should be represented as available/in-stock because the customer can purchase without a special state.
- Customer-facing preorder must be represented truthfully in Merchant/structured availability.

### External Google Merchant constraint

Do **not** blindly map the internal mode name `preorder` to Google Merchant `preorder`.

Google Merchant distinguishes:

- `preorder`: new product not yet released;
- `backorder`: existing product currently unavailable but orders are accepted for later shipment.

The La.na feature described here is normally an existing product that ran out of stock and can still be ordered, so its Merchant representation is likely **`backorder`**, while the storefront can continue to display the Vietnamese label `Đặt trước`.

Google requires an `availability_date` for both preorder/backorder states, and the date must be consistent with the landing page/checkout/structured data.

Official references verified 2026-09-16:

- Google Merchant Center — Availability: https://support.google.com/merchants/answer/6324448?hl=en
- Google Merchant Center — Availability date: https://support.google.com/merchants/answer/6324470?hl=en
- Google Search Central — Product structured data availability values: https://developers.google.com/search/docs/appearance/structured-data/product-snippet

### Blocking integration question

The business rule is relative (`15 calendar days from successful order confirmation`) while Merchant expects a product-level date. Before enabling Merchant submission for these states, the implementation must define a truthful `availability_date` strategy and show the matching date/estimate on the landing page.

Possible strategies must be reviewed; do not invent a fixed date or continuously-moving date without validating Merchant compliance and customer truth.

---

# PART G — FOOTER AND STATIC POLICY SURFACE

## 33. Footer structure

Mobile footer uses collapsible groups: `Mua sắm`, `Hỗ trợ khách hàng` and
`Thông tin & chính sách` each collapse behind a disclosure at the single-column breakpoint (640px),
starting closed. This replaces the original always-expanded rule at the owner's request -- twenty-odd
links between the page and the legal block is a scroll, not a footer.

Wherever the footer is still more than one column, every link stays visible: the disclosure is a
mobile-only presentation, and the column-1 brand/contact block never collapses.

A visitor without JavaScript keeps all links expanded, and is shown no disclosure control at all.
The disclosure cannot open without scripting, so collapsing the groups for that visitor would put
the support and policy pages out of reach entirely; the collapse is therefore reversed for them,
and the footer falls back to the same arrangement it has above the breakpoint.

No newsletter in current scope.

Footer brand/contact rows use a compact **1.5rem visual row gap**. Text links in footer navigation
and inline support/policy/action copy are persistently underlined so shoppers can distinguish links
without hover. Navigation icons, buttons, pills/badges and whole-card product links keep their
existing non-underline affordances.

### Column 1 — La.na Design

- master logo
- `Charismatic in every yard of cloth.`
- Hotline/Zalo
- Customer support email
- Facebook

### Column 2 — Mua sắm

- Áo dài
- Set đồ
- Váy, đầm
- Hàng mới về
- Sale
- Bộ sưu tập

### Column 3 — Hỗ trợ khách hàng

Must include:

- Chính sách vận chuyển
- Chính sách đổi trả và hoàn tiền
- Chính sách thanh toán
- Thông tin liên hệ
- Các hình thức hỗ trợ trực tuyến
- Chính sách tiếp nhận và giải quyết phản ánh khiếu nại

### Column 4 — Thông tin & chính sách

Must include:

- Điều khoản chung
- Chính sách giá
- Chính sách bảo mật
- Các điều kiện và hạn chế trong việc cung cấp hàng hóa
- Quyền và nghĩa vụ của các bên trên nền tảng

Exact route slugs should follow existing route conventions and avoid duplicate pages; each required item must be publicly reachable.

### Bottom legal block

Render:

- `CÔNG TY TNHH QUỐC TẾ THƯƠNG MẠI LAS`
- registered address
- `MST: 0111242251 - ngày cấp: 7/10/2025`
- `Email: congtytnhh.las@gmail.com`

Do not render the legal representative.

---

# PART H — ADMIN REQUIREMENTS

## 34. Admin-controlled merchandising/content

Admin must be able to control or select, using the simplest existing mechanism where possible:

- product `sizeGuideId` from the three approved guides;
- Featured products and their order;
- default PLP merchandising order;
- mega-menu editorial image for applicable categories;
- product selling mode: `standard | oversell | preorder`;
- product-level negative stock limit, default `-20`;
- related products (manual override);
- real product badge/status source where the application supports `Hàng mới` / `Bán chạy`.

Hero campaign content requires 2–3 real slides, but specific campaign assets/destinations are currently pending. Do not populate fake slides.

No admin UX should expose secrets.

---

# PART I — CURRENT REPOSITORY DELTAS / ARCHITECTURE CONSTRAINTS

## 35. Known stale implementation to replace

Current `src/brand/brand.config.ts` still publishes LA Clothing identity/contact/merchant copy except for the social-card slug. This must be replaced with approved La.na truth.

Current `src/brand/navigation.config.ts` is flat and still contains Brand #1 labels/routes such as `/lookbook`; it cannot represent the required nested Áo dài / Set đồ structure or mega-menu metadata.

Current `src/brand/size-guide.config.ts` contains menswear garment measurements and a fixed tolerance; it must be replaced entirely with the three approved La.na body-measurement guides.

Current `src/brand/fulfillment.config.ts` is only partially aligned; update at least carrier list, other-province ETA, refund wording and remove any unsupported policy case. Its legacy scope label `Nội thành Hà Nội` also does not exactly match the owner-approved delivery split (`Hà Nội` vs `tỉnh/thành khác`), so planning must correct the semantics rather than silently narrowing the 1–3 day window to inner-city only.

## 36. Required minimal schema/config evolution

### Navigation

Current `NavigationLink` is flat. The config needs the smallest additive representation that can express:

- clickable parent link;
- child links;
- optional manually selected editorial image for mega menu.

Do not create a generic CMS navigation framework beyond these needs.

### Size-guide tolerance

Current `toleranceCm: number` cannot express “no fixed tolerance.” Make it optional/nullable or otherwise represent absence truthfully; do not use `0` as a semantic hack.

### Legal contact

Current Brand Config has only one storefront contact address/email. Introduce a single source for distinct registered legal address/legal email without duplicating legal facts across pages.

### Selling policy

Current Prisma schema has Pancake mirror stock but no product-level website-owned selling mode/negative-limit policy. Persist the new policy outside Pancake-owned mirror data so sync cannot erase it.

A likely simple model is a one-to-one product selling policy, but exact migration design belongs in the implementation plan and requires explicit review before migration.

### Size guide mapping

Prefer reusing the existing website-owned `ProductContent.sizeGuide` field as a constrained guide ID if that cleanly satisfies the contract. Avoid adding another field solely to rename it.

---

# PART J — ACCESSIBILITY, PERFORMANCE, SECURITY

## 37. Accessibility acceptance

- All nav/mega-menu/search/cart/modal controls keyboard accessible.
- Full-screen mobile nav and size-guide modal trap/restore focus correctly.
- Slider pauses on focus/interaction and honors reduced motion.
- Dots have accessible names/state.
- Product image alt text is meaningful; decorative editorial assets can use empty alt where appropriate.
- Icon-only Search/Account/Cart have accessible labels.
- Infinite-scroll loading/error state announced appropriately.
- Color is not the only signal for stock/sale/preorder state.
- Touch targets approximately 44×44 px where practical.

## 38. Performance acceptance

- Hero/LCP image is responsive, sized explicitly and prioritized appropriately.
- Below-fold editorial/product images lazy-load.
- Use modern optimized image delivery supported by the existing Next stack.
- Avoid shipping a heavy slider dependency unless existing primitives cannot meet the requirement.
- Product hover second image must not double-load the entire catalog eagerly.
- Infinite scroll must not accumulate unbounded expensive client state.

No performance claim is accepted without measurement during verification.

## 39. Security / data integrity

- No secrets committed.
- Payment remains COD-only unless explicitly re-enabled.
- Contact form validates/rate-limits untrusted input and does not expose internal mail credentials.
- Selling mode/negative limit updates are admin-authorized server actions/API operations.
- `negativeStockLimit` must be bounded/validated as a negative integer according to a documented safe range; default is `-20`.
- Order commit limit enforcement is server-side; client state is never trusted.
- External Pancake/Merchant responses are untrusted and validated.

---

# PART K — TESTING STRATEGY

## 40. Test levels

### Domain tests

Add/update tests for:

- brand identity/contact/legal separation;
- no LA Clothing public truth leakage;
- nested navigation labels/order/routes;
- approved SEO title/meta/alias behavior;
- all three size-guide tables and semantics;
- no fixed size tolerance;
- fulfillment exact windows/carriers/fees/policy;
- COD-only website state;
- selling-mode state machine;
- per-variant negative-limit boundary;
- oversell has no customer-facing special state;
- preorder label appears exactly when `stock <= 0 && stock > limit`;
- stock at hard limit is unavailable;
- turning mode off preserves negative quantity but blocks sale;
- mixed preorder order ETA behavior;
- Merchant availability mapping layer is consistent with the approved external semantics.

### Database/integration tests

- product selling-policy persistence survives catalog sync;
- admin authorization;
- concurrent order attempts cannot exceed negative limit;
- failed Pancake submission does not leave incorrect local reservation/commit state;
- idempotent retries do not double-consume sellable capacity;
- `ProductContent.sizeGuide` (or chosen mapping) rejects unknown guide IDs;
- featured/manual merchandising references valid products.

### Browser/runtime tests

Representative desktop + mobile checks:

- header transparent → cream transition;
- nested mega menu;
- mobile full-screen nav;
- full-screen search;
- hero autoplay/pause/swipe/dots/reduced motion;
- 2:3 product-card media frames on desktop and mobile, plus hover second image;
- sale/badge priority;
- preorder status cannot be hidden by marketing badge;
- PLP filters/sort/infinite scroll/back navigation;
- PDP sticky panel, size modal, no-auto-size selection;
- mobile sticky add-to-cart;
- cart drawer;
- footer required links and legal block;
- contact form validation/submission behavior.

### Required verification commands

At minimum, actually run:

```bash
pnpm lint
pnpm typecheck
pnpm test:domain
pnpm test
pnpm test:db
pnpm build
```

When environment permits:

```bash
pnpm release:check
```

Meaningful Pancake/live catalog verification is separate from local mirror-empty checks and must not be faked with placeholder data.

---

# PART L — BOUNDARIES

## 41. Always do

- Treat this spec/owner-approved fact authority as the source of truth.
- Preserve headless/brand-layer boundaries.
- Update tests with behavior changes.
- Keep `SEARCH_INDEXING_ENABLED=false` through this work.
- Keep secrets out of repo/docs/logs.
- Use real content/data for badges, collections, campaign links and product status.
- Keep docs/policies synchronized with current runtime behavior.

## 42. Ask first

- Prisma schema migration / new database model.
- New third-party dependency.
- Changing Pancake order contract or stock ownership.
- Changing authentication/authorization behavior.
- Changing shipping-price authority.
- Enabling Merchant/indexing in production.
- Enabling bank transfer.
- Meta Pixel / Facebook CAPI.
- Any architecture refactor that affects Core Kit/shared boundaries beyond what the requirement needs.

## 43. Never do

- Copy LA Clothing facts into La.na Design.
- Invent legal/contact/policy/size/collection facts.
- Commit secrets or real API tokens.
- Use fake placeholder products/collections to make pages look complete.
- Set fixed size tolerance when owner explicitly said none.
- Reset negative inventory to zero when disabling a selling mode.
- Let client-side UI determine stock eligibility without server revalidation.
- Widen tests/allowlists merely to force green.
- Modify Core Kit upstream as part of Brand #2 implementation unless separately requested.

---

# PART M — SUCCESS CRITERIA

## 44. Giai đoạn 2 — Brand Config/static truth done when

- No public Brand Config field still publishes LA Clothing identity/contact/merchant facts.
- Navigation reflects the approved La.na taxonomy and order.
- Three size guides exactly match approved source charts and map by ID.
- Fulfillment/payment/contact/legal policies match current owner decisions.
- Static policy pages/footer expose all required policy categories.
- Legal registered address and business/return address are kept separate.
- Domain tests pass and docs describe current truth.

## 45. Giai đoạn 3 — FE redesign done when

- Homepage/order of sections matches this spec.
- Hero, product grid, editorial blocks, header/nav/search, PLP, PDP, cart and footer behave as specified on desktop/mobile.
- Approved assets are used in their intended roles.
- No fake collection/campaign/product marketing state is introduced.
- Accessibility and performance checks have runtime evidence.

## 46. Inventory selling modes done when

- Admin can select exactly one mode per product and configure the negative limit.
- Standard/oversell/preorder boundary behavior is covered by tests.
- Concurrency cannot exceed the per-variant hard limit.
- Oversell is visually normal; preorder is clearly labeled throughout the purchase flow.
- 15-day calendar preparation rule is calculated from successful order confirmation.
- Mixed ready/preorder orders are held and shipped together.
- Turning the mode off preserves negative quantity and blocks new sales appropriately.
- Merchant/structured availability uses externally valid semantics and does not claim `preorder` when Google requires `backorder`.
- Pancake integration behavior is actually verified for negative/zero-stock order submission before feature is called production-ready.

---

# PART N — OPEN / PENDING

## 47. Pending content, not blockers for the spec architecture

- Child collection names/content: none approved yet.
- Hero campaign slides/assets/destinations: specific campaigns pending.
- Mega-menu/category-editorial image selections: pending admin content.
- Meta Pixel/CAPI: intentionally pending.
- Exact category SEO copy beyond approved homepage metadata: draft later for approval.
- Source of `Bán chạy` truth: must be defined from real data before the badge can be used.

## 48. Blocking technical questions for implementation planning

1. **Merchant availability date:** define a compliant `availability_date` strategy for the rolling “15 days after order confirmation” preorder/backorder business rule.
2. **Pancake negative stock:** verify whether Pancake order submission accepts zero/negative-stock variants or whether an alternate operational contract is required.
3. **Atomic capacity accounting:** choose the smallest server-owned reservation/ledger/serialization mechanism that works across local DB + external Pancake submission.
4. **Composite variants:** if Brand #2 uses composite/bundle variants, explicitly define how selling modes interact with component stock before enabling the feature for those products.
5. **Contact-form mail transport:** the current dependency set does not establish an outbound mail provider. Planning must inspect existing infrastructure first; if delivery to `la.nadesignsince2022@gmail.com` needs a new provider, dependency or credential, that remains an explicit integration/Ask-first decision rather than a hidden implementation choice.

These are implementation-plan gates, not reasons to invent behavior now.

---

# Planning gate

The owner approved this **SPECIFY** artifact on 2026-09-16. Approval authorizes saving it as project truth and producing a plan; it does **not** waive the spec's `Ask first` gates or authorize unreviewed architecture/migration decisions.

Next step:

1. save this master spec in the repository and keep the narrower owner-facts intake synchronized with it;
2. produce a dependency-ordered implementation plan;
3. split work into small vertical tasks;
4. implement incrementally with TDD and verification;
5. final review against project Definition of Done.