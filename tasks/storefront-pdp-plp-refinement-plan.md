# Storefront PDP / PLP Refinement — Implementation Plan

Source spec: `docs/specs/storefront-pdp-plp-refinement.md`.

## Dependency map

1. Lock current docs + RED tests for the new gallery/variant/listing contracts.
2. Implement desktop gallery grouping/navigation and PDP information layout while preserving the single selection controller.
3. Refine purchase presentation/copy/visual states without moving commerce truth.
4. Apply related-products wording and shared PLP density.
5. Run focused verification, then full relevant CI gates and self-review.

## Task 1 — Contract + RED tests

**Description:** Update the approved spec status/master-spec clauses and add focused tests that express the new behavior before production code changes.

**Acceptance criteria:**
- approved refinement spec no longer says draft;
- master spec no longer requires sticky desktop buy panel / old remaining-gallery grid;
- tests pin desktop slide grouping, no-loop navigation, canonical slide-1 initial load even for later-media deep links, exact unresolved-kind guidance, generic related heading, and non-sticky purchase expectation;
- desktop gallery tests do not pin any particular below-`lg` mobile structure.

**Verification:** relevant domain/browser tests fail for the expected old behavior before implementation.

**Files likely touched:** refinement spec, master spec, gallery/variant/PDP tests.

## Task 2 — Desktop gallery + information layout

**Description:** Replace the separate cover-cropped hero + below-fold editorial grid with one desktop viewport gallery driven by the existing gallery model/selection seam, then render the desktop two-column information row below it.

**Acceptance criteria:**
- first desktop slide = image 1 full width, later slides = 2-up pairs, odd tail full width;
- click right/left and horizontal pointer drag navigate without looping;
- keyboard previous/next is available;
- vertical page scroll is not intercepted;
- desktop images use contain framing and near-viewport stage;
- initial page load stays on slide 1 / trusted image 1 even when a deep-linked variant maps to a later slide; after initial load, an explicit variant selection change may map to the containing slide;
- purchase panel is not sticky;
- desktop gallery/layout rules are gated at `lg`; this task does not assert a mobile structural contract.

**Verification:** domain seam tests + focused Playwright gallery/PDP tests.

## Task 3 — Variant UX, copy and CTA language

**Description:** Keep current selection/purchase authority but make unresolved classification visually/textually different from genuine sold-out stock and align transactional presentation with the La.na design system.

**Acceptance criteria:**
- before kind selection, exact guidance: “Nàng chọn phân loại trước để xem size còn hàng”;
- unresolved sizes may remain disabled/non-selectable exactly as the existing selection authority returns them, but must not use sold-out opacity/copy/badge/strike-through styling;
- true stock-out still communicates “Hết hàng”;
- technical “Chọn loại × kích cỡ” and server-oriented buyer copy are removed;
- headings use serif where appropriate; transactional/body copy stays sans;
- primary/secondary purchase actions use existing brown/cream colors on desktop + mobile.

**Verification:** variant domain/browser tests, PDP language tests, Axe/keyboard checks.

## Task 4 — Related copy + PLP density

**Description:** Rename the generic related section and reduce listing chrome vertical footprint using shared presentation components rather than route-specific business-logic changes.

**Acceptance criteria:**
- current generic related products heading is “Nàng có thể thích” on all viewports;
- no “Hoàn thiện phối đồ” is emitted without an explicit complementary-merchandising authority;
- ListingShell/Header/result/filter spacing is tighter on desktop + mobile;
- at 1440×900 and 390×844, the top edge of the first product image is inside the initial viewport on load for a product-bearing PLP with default/unexpanded filters;
- product-card columns and query/filter URL semantics are unchanged.

**Verification:** related-products and listing-consistency browser tests, including explicit first-product fold assertions at 1440×900 and 390×844.

## Task 5 — Verification + review

**Description:** Stop on any red gate, fix root cause, then review correctness → security → architecture → simplicity → performance.

**Verification target:**
- focused domain tests for gallery/variant contracts;
- focused Playwright specs: storefront commerce/media, PDP language, related products, listing consistency, variant deep-link;
- `pnpm lint`, `pnpm typecheck`, `pnpm test:domain`, relevant integration tests, `pnpm build` through CI where local execution is unavailable;
- clean browser console and buyer Axe gate in the focused specs;
- exact-head CI green before PR is considered ready.

## Risks / mitigations

- **Initial gallery priority vs variant media:** keep slide 1 / trusted image 1 as the canonical first visible surface on initial load, including `?variant=` deep links. Use the existing variant-media seam only for post-load selection changes; do not rederive stock/variant facts.
- **Pointer gestures blocking page scroll:** handle horizontal pointer threshold only; do not install wheel interception; use touch-action that preserves vertical pan.
- **Breakpoint isolation:** gate desktop gallery structure with responsive CSS/component branching so desktop composition/navigation does not leak below `lg`; mobile structure is specified separately.
- **Scope creep:** no dependency, schema, recommendation engine, desktop zoom/lightbox, or unrelated refactor.
