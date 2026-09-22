# Spec: Storefront PDP / PLP Refinement

Status: **Approved by owner on 2026-09-22**

This spec records the owner interview completed on 2026-09-21. It is intentionally narrow: presentation, interaction and buyer-facing copy only. It does not redesign commerce, stock, cart or recommendation authority.

This spec supersedes the conflicting presentation clauses that were in the consolidated master spec:
- §25 listing vertical rhythm where it prevented products appearing early enough;
- §26 "Desktop remaining gallery keeps the editorial grid behavior where images remain";
- §26 "Right-side product info panel is sticky on desktop".

`docs/specs/la-na-design-master-spec.md` already carries the replacement clauses in §25 (Density) and §26 (First-image hero and gallery / Information and buy panel / Variant UX / Buyer-facing copy and visual language / Related products), so the repository holds one active contract rather than two.

## Objective

Refine the La.na Design product and listing experience so photography remains the dominant visual language without hiding the information required to buy.

The product page uses Maison Uniforme only as a layout/interaction reference. It must remain recognizably La.na Design and continue to follow the already-approved brand direction: warm brown/chocolate on cream/light surfaces, elegant serif headings, clean sans-serif transactional UI, feminine refined image-first presentation.

Success means:
- desktop PDP photography shows the full garment silhouette instead of cropping the model/head/hem;
- gallery navigation is horizontal by deliberate click/drag/swipe only, while vertical wheel/trackpad gestures keep scrolling the page;
- product information and purchase information are clearly separated below the gallery;
- variant states distinguish "not chosen yet" from "out of stock";
- buyer copy describes shopping facts rather than server/catalog implementation;
- PDP/PLP styling is consistent across desktop and mobile where explicitly listed below;
- commerce, stock, price, preorder and cart truth remain unchanged.

## Current technical context

Repository stack detected from `package.json` on the base commit:
- Next.js 16.3.3
- React / React DOM 19.2.0
- TypeScript 5.9.x
- Tailwind CSS 4.x
- Prisma 7.9.1
- pnpm 11.4.0
- Node >= 22.14.0

Relevant existing ownership:
- `src/app/shop/[slug]/page.tsx` — PDP route composition and static editorial sections.
- `src/components/brand/product-detail.tsx` — shared selection coordinator between gallery and purchase UI.
- `src/components/brand/product-gallery.tsx` — brand gallery presentation.
- `src/components/brand/purchase-panel.tsx` — purchase presentation and size-guide dialog.
- `src/components/headless/variant-selection-model.ts` and `use-variant-selection.ts` — existing selection/purchase truth; presentation must consume it rather than re-derive it.
- `src/components/brand/listing-chrome.tsx` and listing routes — PLP chrome.
- `src/app/globals.css` — shared design tokens and full-bleed media/header behavior.
- `tests/a11y-runtime/*` + `tests/domain/*` — browser and domain regression coverage.

## Commands

Use repository commands, not guessed replacements.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test:domain
pnpm test
pnpm test:db
pnpm build
```

Focused browser verification should use the repository's existing Playwright configs/spec commands from CI rather than inventing a parallel harness.

## Product detail page contract

### 1. Gallery structure

Desktop (`lg` and above):
- The desktop refinement begins at the repository's existing Tailwind `lg` breakpoint, matching the current PDP `lg:*` seam in `product-detail.tsx`. Do not introduce a second custom desktop breakpoint for this feature.
- Below `lg`, this refinement intentionally defines no structural mobile/tablet PDP/gallery contract. A dedicated mobile-only follow-up owns that behavior; the only constraint here is that desktop `lg` rules must not leak below the breakpoint.
- The first trusted product image remains the first full-bleed PDP surface and the transparent header may continue to overlay it.
- The media stage is approximately one viewport tall. Use the actual header composition when choosing between `100svh` and `calc(100svh - <occupied masthead>)`; do not hard-code a subtraction that is wrong for overlay mode.
- Product imagery uses `object-contain`, not `object-cover`, for this stage. The complete garment/model silhouette should fit inside the available media area.
- Empty space caused by `object-contain` uses the La.na cream/stone visual system rather than black bars or arbitrary new colors.
- Slide 1 contains image 1 alone at full width.
- Subsequent slides group images in source order as `2+3`, `4+5`, `6+7`, etc.
- A two-image slide is 50/50.
- If the final slide has one image, that image occupies the full width.
- Do not add thumbnails, lightbox, zoom, autoplay or pagination machinery beyond what is needed to communicate the current slide accessibly.

Below `lg`:
- The gallery redesign in this section is **desktop-only at `lg` and above**.
- This spec does **not** freeze or redefine the mobile/tablet gallery/media composition; that contract belongs to the dedicated mobile-only follow-up.
- Do not introduce the desktop 50/50 paired-slide composition below `lg` as part of this desktop refinement.

### 2. Gallery interaction — desktop (`lg` and above)

- These navigation changes apply at the existing `lg` breakpoint and above. Below `lg`, this spec makes no gallery-interaction contract beyond preventing the desktop interaction model from leaking across the breakpoint.
- Vertical mouse wheel, vertical trackpad and normal page-scroll gestures must scroll the document. The gallery must not hijack or convert them into horizontal navigation.
- Clicking/tapping the right half of the gallery advances one slide.
- Clicking/tapping the left half moves back one slide.
- Horizontal drag/swipe changes slides in the corresponding direction.
- The first slide cannot move backward.
- The final slide cannot advance and does not loop to the beginning.
- Horizontal gesture handling must not create a vertical scroll trap. Use an appropriate `touch-action` / pointer strategy so vertical intent remains native.
- Keyboard users need an equivalent, discoverable path to previous/next navigation when multiple slides exist. Do not make pointer geometry the only way to operate the gallery.
- **Initial-load priority is explicit:** slide 1 / trusted image 1 is always the first visible PDP surface, including when the URL contains a `?variant=` deep link whose mapped media is on a later slide. The deep link may preselect the variant, but it must not replace the canonical first visible surface on initial page load.
- After initial load, a shopper changing the selected variant may sync the gallery to that variant's mapped image/slide through the existing selection-gallery seam. A shopper's manual gallery choice remains theirs until the selected variant changes again.

### 3. Information layout below the gallery

Desktop (`lg` and above):
- Do not use the rejected 58% image / 42% buy-panel layout.
- After the gallery, render one information row with two columns.
- Left column: product identity and product/editorial information (name, collection context where present, description, craft/material/care content that truthfully exists).
- Right column: price, availability/preorder presentation, kind/color/size controls, size guide, purchase CTAs, purchase feedback, shipping and returns information.
- The purchase panel is not sticky on desktop.
- No nested sticky treatment may make the variant/size area overlap adjacent copy.

Below `lg`:
- The structural two-column information redesign is **desktop-only at `lg` and above**.
- This spec does **not** freeze the mobile/tablet stacked PDP or quick-purchase interaction shape; the dedicated mobile-only follow-up owns that structure.
- The explicitly shared variant UX, buyer copy, visual-language, related-products and PLP-density changes below still apply unless the mobile-only spec is more specific.
- Desktop implementation must not introduce a second selection/cart authority for mobile.

## Variant UX — desktop and mobile

This is a presentation clarification, not a change to stock or purchasability rules.

For products with a required kind/classification such as a composite `FULL SET` choice:
- Before a kind is chosen, the UI must explicitly say: **"Nàng chọn phân loại trước để xem size còn hàng"**.
- **Selection authority does not change:** before a kind is chosen, size inputs may remain non-selectable/`disabled` exactly as `deriveStorefrontProjectionSelection` currently returns them.
- That disabled/non-selectable state is **neutral unresolved state**, not an out-of-stock state. Its presentation must not reuse the opacity, copy, badge, strike-through or other visual language used for genuine `Hết hàng`.
- "Chưa chọn phân loại" and "Hết hàng" are distinct states in copy and styling.
- Actual out-of-stock variants remain visible/disabled and continue to communicate `Hết hàng` from the existing commerce authority.
- This task does **not** make sizes clickable before kind selection and must not alter `deriveStorefrontProjectionSelection` or server purchasability to achieve the presentation distinction.
- Existing required-size validation (`Vui lòng chọn size`) and server-side cart authority remain unchanged.

## Buyer-facing copy — desktop and mobile

Remove or rewrite implementation-facing language such as:
- "Chọn loại × kích cỡ";
- "Giá, tồn kho và phí vận chuyển được máy chủ kiểm tra lại…";
- other copy that explains server/catalog mechanics rather than a shopping fact.

The replacement copy may communicate only facts already supported by repository authorities, for example:
- current availability state;
- displayed total/price;
- estimated availability/delivery data already present in the view model;
- size-selection guidance;
- truthful shipping/returns policy summaries.

Do not invent stock quantities, delivery promises, fit claims or policy terms.

## Visual language — desktop and mobile

Follow the approved La.na Design design direction rather than introducing a new system:
- serif for page/section/product headings;
- sans-serif for price, variants, size guidance, body copy, forms and transactional messages;
- reduce wide uppercase letter-spacing in small buyer information where it harms readability;
- use uppercase only where it serves the existing restrained micro-label system;
- purchase CTAs use the approved warm brown/chocolate + cream system instead of the current generic pure black/white pairing;
- keep visible focus states and non-color state cues;
- controls remain at least the repository's existing 44px practical target.

## Related products — desktop and mobile

The current related-products data source can be manual overrides or generic same-category fallback. That does not prove the items are styling complements.

Therefore:
- rename the current generic related section to **"Nàng có thể thích"**;
- do not infer "Hoàn thiện phối đồ" from category/name heuristics;
- use "Hoàn thiện phối đồ" only when a future/explicit merchandising source truthfully identifies complementary pants, bags or accessories;
- this task does not add such a recommendation model or persistence.

The existing related-product selection authority, visibility rules, deduplication and cap remain unchanged.

## PLP / listing density — desktop and mobile

Goal: move the first row of product imagery higher without making the filters hard to use.

Shared:
- reduce excessive vertical padding between breadcrumb, title, explanatory copy, filters/result controls and the product grid;
- reduce wide uppercase/tracking-heavy microcopy where it is not needed;
- preserve one serif H1, breadcrumbs, filter semantics, result announcements, empty/loading/error states and existing URL/query behavior;
- do not change product-card column counts or discovery business logic as part of this refinement.

Desktop:
- compress header/filter chrome without shrinking practical control targets.
- **Observable acceptance:** at a representative 1440×900 viewport, on a PLP that has products and with filters in their default/unexpanded state, the top edge of the first product image must be visible inside the initial viewport on page load.

Mobile:
- apply the same density goal responsively.
- do not render a desktop four-field row squeezed onto a phone; keep the current responsive stacking/disclosure pattern where appropriate.
- **Observable acceptance:** at a representative 390×844 viewport, on a PLP that has products and with filters in their default/unexpanded state, the top edge of the first product image must be visible inside the initial viewport on page load.
- preserve access to filter and clear-filter controls while meeting that fold criterion.

## Testing strategy

### Domain / component contracts

Add or update focused tests for:
- slide grouping: first image alone, then pairs, odd tail full-width;
- no looping at either edge;
- initial page load always starts on slide 1 / trusted image 1 even when a deep-linked variant maps to a later image;
- after initial load, a variant selection change maps to the containing slide;
- manual gallery navigation wins until the selected variant changes;
- kind-not-selected presentation is distinct from true out-of-stock;
- related heading is `Nàng có thể thích` for the current generic related source;
- no commerce/purchasability computation moves into brand presentation.

### Browser / interaction

At representative widths, verify:
- on desktop, first PDP image is fully contained rather than cover-cropped;
- on desktop, vertical wheel/trackpad scroll moves the document and does not change slides;
- on desktop, right-half click advances and left-half click goes back;
- on desktop, horizontal drag advances/reverses;
- on desktop, first/last edge does not loop;
- on desktop, keyboard can navigate gallery;
- below `lg`, desktop gallery composition/navigation does not leak across the breakpoint; this spec does not assert a particular mobile gallery structure;
- no horizontal page overflow;
- purchase controls do not overlap product/detail text;
- no desktop-only purchase layout assumption is used as a mobile quick-purchase contract;
- at 1440×900 and 390×844, the top edge of the first product image is visible in the initial viewport on load when the PLP has products and filters are in their default/unexpanded state;
- clean console and existing Axe buyer gate remain green.

Update existing tests that currently pin the old sticky desktop purchase panel or old editorial-grid-only gallery. Do not weaken assertions merely to make the redesign pass.

## Code style / implementation shape

Prefer the smallest change that preserves current boundaries:
- one selection controller remains owned by `BrandProductDetail`;
- brand components render presentation; headless/commerce modules remain authority for price, stock, preorder and selected variant;
- reuse existing CSS variables/colors before adding tokens;
- keep interaction logic local to the gallery unless a pure helper is needed for testable slide grouping/navigation;
- no new dependency is expected for the carousel/drag interaction;
- avoid a general-purpose carousel abstraction unless another existing consumer already needs it.

## Boundaries

### Always
- preserve trusted-media filtering and alt text behavior;
- preserve variant deep links and the selection-gallery seam;
- preserve price/discount/preorder/stock/cart authority;
- preserve size-guide accessibility and dialog behavior;
- preserve keyboard/focus semantics;
- update affected browser/domain tests with the behavior.

### Ask first
- adding a dependency;
- changing `deriveStorefrontProjectionSelection` or server purchase eligibility;
- changing database/schema/admin merchandising contracts;
- changing mobile quick-purchase business behavior;
- adding new recommendation metadata/persistence.

### Never
- infer "out of stock" from a merely unresolved kind/size state;
- infer complementary products from names/categories just to justify "Hoàn thiện phối đồ";
- intercept vertical wheel scrolling to drive the gallery;
- crop the primary garment with `object-cover` in the new main media stage;
- clone Maison Uniforme branding, copy, assets or exact styling;
- mix unrelated refactors into this change.

## Success criteria

Implemented and verified; see the verification record at the end of this file.

- [x] Owner-approved gallery structure and interaction apply at the existing `lg` breakpoint and above, with no desktop gallery rule leaking below `lg`; mobile structure is owned separately.
- [x] Desktop primary media is near viewport height and full garment framing is visible with `object-contain`.
- [x] Initial PDP load always shows slide 1 / trusted image 1, including for `?variant=` deep links; deep-link preselection does not replace the canonical first visible surface.
- [x] Vertical scrolling always continues to later PDP sections.
- [x] Information below gallery is two-column at `lg` and above; this refinement does not freeze the below-`lg` structural layout.
- [x] Desktop purchase panel is no longer sticky and no text/control overlap occurs.
- [x] Kind-unselected guidance uses the exact approved sentence and is visually distinct from sold out.
- [x] Actual sold-out variants still show `Hết hàng` and remain governed by existing commerce truth.
- [x] Technical/server-oriented buyer copy is removed or rewritten without inventing facts.
- [x] Serif/sans and brown/cream CTA direction applies consistently on desktop and mobile.
- [x] Current generic related section reads `Nàng có thể thích`.
- [x] At 1440×900 and 390×844, a product-bearing PLP with default/unexpanded filters shows the top edge of the first product image within the initial viewport on load.
- [x] Existing URL/filter/cart/variant/preorder/size-guide behavior is preserved.
- [x] Relevant domain, browser, accessibility, lint, typecheck and build gates pass before implementation is considered complete.
- [x] Consolidated master spec is updated before merge so it no longer states the superseded sticky/grid contract.

## Open questions

None blocking implementation. Exact spacing values and drag threshold remain implementation details; PLP density is judged by the approved 1440×900 and 390×844 initial-viewport criterion above.

## Implementation record

What the implementation chose where the spec left it open:

- **Owner of the media.** `BrandProductMediaStage` renders every trusted image and is the PDP's
  first full-bleed surface at every viewport. Below `lg` only its first slide has a box, so the
  phone composition is unchanged and the later slides' lazy images are never fetched; the below-`lg`
  editorial grid still carries images 2..n in the content column. Nothing about the mobile structure
  moved, which is what keeps this change clear of the separate mobile spec.
- **Slides stack rather than ride a track.** A translated track lays the later slides out past the
  right edge of the viewport -- clipped, but still measurably outside it, which the storefront's
  no-horizontal-overflow guard correctly catches. The stage reuses `.home-hero__slide`'s
  stack-in-place pattern instead.
- **Navigation surface.** Two half-width buttons (`Ảnh trước` / `Ảnh tiếp theo`) give the pointer
  its click halves and keyboard users the equivalent path from the same elements; a horizontal
  pointer drag past 48px moves one slide. There is no wheel listener, and `touch-action: pan-y`
  leaves every vertical gesture to the document.
- **Canonical first surface.** The stage mounts on slide 0 with the deep-linked variant already
  recorded as synced, so only a *change* of selection moves it. That one rule produces both required
  behaviours: a `?variant=` link preselects without replacing slide 1, and a shopper's own drag or
  click survives every re-render until the selection changes again.
- **Unresolved kind.** `deriveStorefrontProjectionSelection` is untouched; those size inputs are
  still `disabled`. `kindSelectionGuidance` is a presentation-only field on the view model, and the
  unresolved row renders at full opacity with a dashed edge rather than the dimmed presentation a
  genuinely unavailable option wears.
- **Information columns.** The DOM order is identity, purchase, product information, delivery and
  returns -- the stacked order a narrow viewport needs -- and `lg` places each block in its column,
  with the panel spanning both content rows so a long panel cannot push the description past it.
  The approved detail-block order now runs across the two regions (`Chi tiết sản phẩm` and
  `Giao hàng và đổi trả`) in reading order.
- **PLP density.** Shared padding came down across the shell, header, explanatory copy, result
  controls and filter chrome. `/shop` was the outlier -- nine fields stacked one per row on a phone
  -- and is two columns from the narrowest width up, with the in-stock toggle and the apply button
  sharing the last row. Measured first-product-image offsets after the change: `/shop` 775px of 844
  on mobile and 623px of 900 on desktop, with every other listing further above the fold.

## Verification

Run against this branch, on a local Postgres with the repository's own migrations:

- `pnpm lint` -- 0 errors (16 pre-existing warnings, all in files this change does not touch);
- `pnpm typecheck` -- clean;
- `pnpm test:domain` -- 2059 tests, 0 failures;
- `pnpm test` and `pnpm test:db`;
- `pnpm build`;
- the Playwright accessibility runtime, including `storefront-media`, `variant-deep-link`,
  `storefront-composite`, `pdp-language`, `related-products`, `storefront-commerce` (which carries
  the size-guide artwork + screen-reader chart + dialog focus guard from the merged size-guide
  work), `storefront-listing-consistency`, `discovery`, `collection-landing` and
  `mobile-storefront-rhythm`.
