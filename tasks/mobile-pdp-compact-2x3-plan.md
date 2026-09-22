# Mobile PDP Compact 2:3 Amendment — Implementation Plan

Source contract: `docs/specs/storefront-mobile-commerce-ux.md` → owner amendment dated 2026-09-22.

## Dependency map

1. Pin the amended presentation contract with focused source/browser regressions.
2. Apply the smallest below-`lg` presentation changes and size-guide chrome simplification.
3. Run focused + repository verification, then review against the Definition of Done.

## Task 1 — Contract / regression tests

**Acceptance criteria**
- 390px and 768px PDP image frame is 2:3; 1440px desktop stage remains unchanged.
- `LA.NA DESIGN / SẢN PHẨM` is hidden below `lg` and visible on desktop.
- Mobile selector density is reduced without shrinking interactive controls below the practical 44px target.
- Size-guide dialog has no duplicate visible heading/title/note block or border/frame, while the hidden semantic table and focus contract remain.

**Verification**
- Focused domain/source contract test covers responsive classes and the semantic-table retention.
- Focused Playwright covers the actual ratio, eyebrow visibility, size-guide chrome, focus restoration, and no overflow.

## Task 2 — Minimal UI implementation

**Likely files**
- `src/app/globals.css`
- `src/app/shop/[slug]/page.tsx`
- `src/components/brand/purchase-panel.tsx`

**Acceptance criteria**
- Changes are presentation-only and below-`lg` where specified.
- Desktop purchase/gallery composition and all commerce authority stay untouched.
- No new dependency or duplicated selection/cart state.

## Task 3 — Verification + review

Run the repository's actual gates where available:
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test:domain`
- focused Playwright: mobile rhythm + storefront commerce/media
- `pnpm build`

Review order: correctness → security → architecture → simplicity → performance.

## Risks / mitigations

- **Accessibility regression in size guide:** keep the existing `sr-only` semantic table and dialog label.
- **Desktop drift:** gate mobile layout with existing `lg` seam and pin 1440px regression behavior.
- **Touch targets made too small:** reduce visual whitespace/padding only; retain `min-h-11` / practical 44px controls.
- **Scope creep:** do not change commerce/view-model authority or unrelated PDP sections.
