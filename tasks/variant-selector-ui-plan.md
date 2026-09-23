# Variant Selector UI — Implementation Plan

Source: `docs/specs/storefront-variant-selector-ui.md`.

## Task 1 — RED browser contract

Add focused assertions to the existing storefront commerce runtime for:
- selected value beside label;
- neutral rectangular default chip;
- selected brand-filled chip;
- compact group spacing on mobile and desktop;
- 44px option height;
- size-guide trigger located inside/directly below the size fieldset in panel and sheet.

Do not change production code in this task.

## Task 2 — Shared selector presentation

Refine only `src/components/brand/purchase-panel.tsx`:
- shared legend/value presentation;
- shared rectangular chip classes;
- compact spacing;
- shared size-guide placement.

Keep all controller methods, selection order and purchase behavior unchanged.

## Task 3 — Verification and review

Run focused storefront-commerce runtime first, then lint/typecheck/domain/runtime/DB/build gates and exact-head CI. Review correctness → accessibility → architecture → simplicity → performance.
