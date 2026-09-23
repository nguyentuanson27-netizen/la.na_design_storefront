# Spec: Unified Storefront Variant Selector UI

Status: **Owner approved — 2026-09-23**

## Objective

Make the product-option selector read like one compact, deliberate control system across:
- desktop PDP;
- mobile/below-`lg` PDP;
- mobile quick-purchase bottom sheet;
- any existing surface that reuses the same selector renderer.

Use the supplied rectangular-chip reference for shape, spacing and information hierarchy while keeping the existing La.na Design colors and buyer-facing wording.

## Current authority

Presentation stays inside `src/components/brand/purchase-panel.tsx`.
`useVariantSelection`, `deriveStorefrontProjectionSelection`, stock/availability, cart mutation and size-guide mapping remain authoritative and unchanged.

## Required presentation

1. Each dimension keeps its current label text. When a value is selected, show it beside the label:
   - `Loại: <selected label>`
   - `Kích cỡ: <selected size>`
   - `Màu: <selected color>`
   Do not invent placeholder copy when no value is selected.

2. Option chips:
   - rectangular, compact and visually consistent;
   - keep the existing La.na brown/cream palette;
   - selected = strongest filled brand state;
   - default = light neutral brand-tinted surface;
   - disabled/unavailable = visibly subdued;
   - unresolved-kind sizes remain neutral/dashed and must not look genuinely sold out;
   - practical touch target remains approximately 44px;
   - keyboard focus remains visible.

3. Density:
   - reduce excess vertical space between groups on desktop and mobile;
   - keep a small, consistent label-to-chip gap;
   - do not compress controls below practical touch targets.

4. Size guide:
   - keep the existing `Hướng dẫn chọn size` text and behavior;
   - place it directly below the size choices on the panel and quick-purchase sheet;
   - do not change size-guide mapping or dialog behavior.

5. Preserve existing ordering and behavior:
   - no option reordering merely for visual consistency;
   - no changes to enabled/disabled logic;
   - no auto-selection;
   - no changes to add-to-cart, buy-now, bottom-sheet, focus handoff or cart-open semantics.

## Acceptance

At representative 390×844 and 1440×900 viewports:
- selector groups use the same chip treatment;
- selected values are visibly paired with dimension labels when selected;
- unselected option chips have a non-transparent neutral brand surface;
- selected chips use the existing brown/cream selected treatment;
- each option remains at least 44px high;
- size-guide trigger is inside/directly below the size group on both panel and bottom sheet;
- current unresolved/out-of-stock behavior and accessibility semantics still pass existing tests.

## Commands

Use repository gates:
`pnpm lint`, `pnpm typecheck`, `pnpm test:domain`, focused Playwright runtime tests, `pnpm test`, `pnpm test:db`, `pnpm build`.

## Boundaries

Always:
- reuse the shared selector renderer where practical;
- preserve semantic radio/fieldset controls and focus behavior;
- add regression coverage before production changes.

Never:
- change commerce authority, stock logic or variant resolution;
- add a dependency for this styling-only change;
- fork desktop/mobile selection state.
