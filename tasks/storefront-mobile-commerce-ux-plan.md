# Mobile Storefront Commerce UX — Implementation Plan

Source spec: `docs/specs/storefront-mobile-commerce-ux.md`.

## Dependency map

1. Lock mobile contracts with focused tests and keep desktop expectations unchanged.
2. Build mobile PDP gallery/lightbox.
3. Build shared-state sticky purchase bottom sheet.
4. Refine mobile header, product cards and PLP filters.
5. Enlarge cart touch controls.
6. Reorder mobile checkout without duplicating checkout authority.
7. Run focused runtime verification, full relevant CI and review.

## Task 1 — Contract + RED tests

**Acceptance criteria:**
- tests pin source-order mobile gallery, `current/total`, lightbox and no vertical scroll trap;
- tests pin dimension-aware sticky CTA copy only for currently supported product shapes (no color-only purchase contract), kind → size → color authority order, server-confirmed add success vs rejection, sheet → cart single-modal handoff, and sheet → size-guide single-modal handoff using the existing selection controller;
- tests pin filter drawer persistence, the inherited 390×844 first-product fold gate, checkout DOM order, and `N = sum(line.quantity)`;
- desktop PR #51 expectations remain unchanged.

**Verification:** focused tests fail for the expected current behavior before implementation.

## Task 2 — Mobile PDP gallery + product information

**Acceptance criteria:**
- horizontal one-image-at-a-time gallery on phone;
- `current/total` indicator and full-screen same-image lightbox;
- no image reordering/heuristics;
- initial load stays on trusted image 1 even for a later-media `?variant=` deep link; post-load explicit variant changes may sync to mapped media;
- product name 26–30px and name/price directly after gallery;
- composite product information follows kind → size → color without changing selection-model authority;
- desktop `lg+` gallery unchanged.

**Verification:** domain/gallery tests + Playwright at 320/390/768/1440.

## Task 3 — Sticky purchase bottom sheet

**Acceptance criteria:**
- incomplete sticky CTA opens sheet instead of scrolling and names only dimensions that exist for product shapes supported by current commerce authority; do not introduce a color-only purchase shape;
- sheet uses the existing shared selection controller and follows kind → size → color where applicable;
- complete selection exposes direct `Thêm vào giỏ`, no confirmation step;
- cart opens only after the existing async mutation reports `result.ok === true` or an equivalent controller success signal; synchronous `"submitted"` is not success;
- server rejection keeps the sheet open and surfaces purchase feedback;
- on confirmed success, close/suspend the sheet before opening cart; cart becomes the sole modal/focus owner and the hidden sheet must not restore focus while cart is open;
- opening size guide suspends/closes the sheet so only one modal/focus trap is active; closing the guide restores sheet state and focus to the trigger;
- close-before-add preserves selection/summary;
- real stock-out and unresolved states remain distinct; use `Lựa chọn này tạm hết` unless authority proves a more specific dimension-wide statement.

**Verification:** variant/cart focused tests + browser flow + keyboard/focus checks.

## Task 4 — Mobile listing/header/filter UX

**Acceptance criteria:**
- phone card hierarchy = 14px name, 14–15px price, 12px supporting info;
- shared phone grid gap = 2px, two columns preserved;
- phone header = menu + logo + search + cart, account in menu, ~44px hit targets;
- filter drawer remains open through sequential URL-backed selections;
- fixed drawer footer = clear + `Xem N sản phẩm`;
- active chips remain removable;
- the PR #51 density contract still passes: first product image is visible in the initial 390×844 viewport with default/unexpanded filters.

**Verification:** listing/header/filter Playwright + Axe + no overflow at 320/390.

## Task 5 — Cart touch controls

**Acceptance criteria:**
- quantity +/- targets ~44px;
- delete remains separate;
- existing mutation/limits unchanged.

**Verification:** cart browser tests and keyboard/touch-target assertions.

## Task 6 — Mobile checkout sequence

**Acceptance criteria:**
- collapsed summary first with `Đơn hàng (N) · total`, where `N = sum(line.quantity)` and a multi-quantity fixture pins the rule;
- receiving info follows;
- shipping + total precede submit in DOM order;
- one existing checkout form/server action remains authoritative;
- mobile H1 reduced; technical buyer copy removed;
- desktop checkout layout preserved.

**Verification:** checkout integration/browser tests, submission regression, Axe/focus, quote-refresh behavior.

## Task 7 — Verification + review

Run focused checks, then repository gates:
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test:domain`
- `pnpm test`
- `pnpm test:db`
- `pnpm build`

Review order: correctness → security → architecture → simplicity → performance.

## Risks / mitigations

- **Two selection states:** forbidden; sheet renders the existing controller.
- **Request started vs purchase success:** the existing synchronous `"submitted"` signal is not success; cart-open behavior must wait for server-confirmed `result.ok === true` (or equivalent controller success signal).
- **Nested modals:** size guide and selection sheet must never run simultaneous focus traps; suspend/restore the sheet around the guide dialog. Confirmed add must likewise suspend/close the sheet before cart opens, and cart owns focus while open.
- **Gesture conflict:** use horizontal-intent handling that preserves native vertical pan.
- **Filter remount closing drawer:** preserve drawer-open UI state across URL/result updates without inventing separate filter business rules.
- **Checkout duplication:** restructure/compose the existing form rather than clone submit logic.
- **Desktop regression:** keep changes behind existing responsive seams and verify 1440px.
- **Scope creep:** no dependency, schema, media AI/reordering, or unrelated refactor.
