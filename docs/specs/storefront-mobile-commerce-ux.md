# Spec: Mobile Storefront Commerce UX

Status: **Draft — owner-confirmed interaction decisions, pending final PR review**

This mobile-only follow-up sits on top of the desktop/shared refinement in PR #51. It intentionally changes the below-`lg` PDP experience and the phone/mobile seams of listing/header/cart/checkout without redesigning desktop commerce or moving any price, stock, preorder, variant, cart or checkout authority into presentation code.

## Objective

Make the La.na Design mobile storefront faster to understand and easier to operate one-handed:
- product imagery is swipeable and inspectable without pushing purchase information too far down;
- the sticky purchase bar becomes a real variant-selection entry point rather than a scroll shortcut;
- product cards, header and listing controls are denser but remain touch-friendly;
- filters can be combined without reopening the drawer after every choice;
- cart quantity controls are practical touch targets;
- checkout presents order total before the final submit action and removes implementation-facing copy.

The desktop behavior approved in PR #51 remains out of scope here.

## Current technical context

Relevant existing ownership:
- `src/components/brand/product-gallery.tsx` — gallery presentation.
- `src/components/brand/product-detail.tsx` — single shared variant-selection coordinator.
- `src/components/brand/purchase-panel.tsx` — PDP selectors, quick-purchase bar and size-guide dialog.
- `src/components/brand/product-card.tsx` — card typography and metadata presentation.
- `src/components/brand/site-header.tsx` — mobile menu/search/cart/header utilities.
- `src/components/brand/plp-filter-panel.tsx` — filter drawer, URL updates, active chips and sort.
- `src/components/brand/cart-drawer.tsx` and `cart-line-controls.tsx` — cart quantity/remove presentation.
- `src/app/checkout/page.tsx` + `src/components/commerce/guest-checkout-form.tsx` — checkout summary and the single checkout workflow.
- `src/components/headless/*` and commerce/server actions remain the authority for stock, selection eligibility, cart mutation and checkout acceptance.

## Commands

Use repository commands:
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

Use the repository's existing Playwright/browser configs for focused mobile verification.

## Scope and responsive boundary

This is a **mobile-only** UX change. Do not alter approved `lg+` desktop gallery/purchase behavior from PR #51.

Use each existing component's responsive seam rather than inventing a global breakpoint solely for this work:
- **PDP gallery + immediate product-info order + quick-purchase redesign apply below the existing Tailwind `lg` seam.** Therefore both representative 390px phone and 768px tablet widths use the horizontal one-image gallery/lightbox and the below-`lg` PDP purchase structure defined here.
- PLP filter drawer already uses its mobile disclosure breakpoint; keep that seam.
- Product-card typography/grid and mobile header/filter behavior use their existing component-specific phone/mobile seams and must not change desktop column counts/navigation.
- Acceptance is anchored at 390×844, with explicit 768px assertions for the below-`lg` PDP contract and 1440px desktop regression coverage.

## 1. Mobile PDP gallery

- **Below `lg`**, render product images as one horizontal swipe gallery instead of the current long vertical image stack.
- Show a compact current-position indicator such as `1/6`.
- The first gallery item is the first trusted image from the existing media authority. Frontend code must **not** reorder images, infer "full body", or use AI/heuristics to choose a different first image.
- Initial page load starts on that first trusted image even when `?variant=` preselects a variant mapped to a later image. The deep link preselects variant state but does not replace the canonical first visible surface; after initial load, an explicit variant selection change may sync to mapped media through the existing seam.
- The content rule for merchandising is: image 1 should show the full garment/form clearly; detail shots such as lace, collar and sleeves belong later in the admin/source order.
- Horizontal swipe changes image; vertical page intent must remain native and must not become a scroll trap.
- Tapping the current image opens a full-screen lightbox on the same image.
- Lightbox uses `object-contain`, allows horizontal swipe between images, has a clear close control, preserves/returns focus appropriately, and supports Escape/keyboard navigation where relevant.
- No multi-level pinch-to-zoom requirement. Do not add a heavy carousel/zoom dependency unless existing primitives cannot satisfy the contract.

## 2. Product information order and type

Immediately after the below-`lg` mobile/tablet gallery:
1. product name;
2. price / supported availability state;
3. kind/classification when present;
4. size + size guide;
5. color when present;
6. purchase actions / feedback.

For composite products, this order intentionally follows the existing selection authority: **kind → size → color**. Do not change `deriveStorefrontProjectionSelection` merely to make color selectable before size.

Mobile product name target: **26–30px**, with readable line-height and no current ~45px minimum treatment.

Do not invent availability, delivery or fit facts.

## 3. Mobile sticky purchase bar and selection bottom sheet

The sticky bar and the main purchase panel must continue to share the same `useVariantSelection` controller. Do not create a second selection state or a second cart path.

### Incomplete selection

When required options are incomplete:
- the sticky CTA names only dimensions that actually exist for that product; do not mention a nonexistent classification/color/size;
- representative labels cover only product shapes supported by the current commerce authority: size-only → **`Chọn size`**; color + size → **`Chọn màu / size`**; kind + size → **`Chọn phân loại / size`**; kind + color + size → **`Chọn phân loại / màu / size`**. A color-only product shape is out of scope because current selection authority still requires size to resolve a purchasable variant;
- pressing it opens a bottom sheet rather than scrolling the page back to the size selector;
- the sheet renders only applicable controls and follows existing selection authority: classification/kind → size → color. The size-guide trigger stays with the size control;
- existing unresolved-kind guidance remains exact: **`Nàng chọn phân loại trước để xem size còn hàng`**;
- unresolved and genuine out-of-stock states remain visually/textually distinct.

### Complete selection

When all required choices are valid:
- sticky summary shows the selected values in one compact string, e.g. **`Nguyên bộ · Trắng · M`**;
- omit dimensions that do not exist for the product rather than rendering placeholders;
- the sticky action is **`Thêm vào giỏ`**.

Inside the bottom sheet:
- there is **no separate "Xác nhận lựa chọn" step**;
- once selection is complete, the bottom CTA becomes **`Thêm vào giỏ`**;
- **server-confirmed success is the only cart-open seam:** opening the cart must happen only after the existing async add mutation resolves with `result.ok === true` (or an equivalent controller success signal derived from that result). The current synchronous `"submitted"` return value means only that the request started and must not open the cart;
- on server rejection/failure, keep the selection sheet open and show the existing purchase feedback; do not create a second mutation path;
- the controller may expose a success callback/signal if needed, but the existing cart/server mutation remains the single authority;
- after confirmed success, **close/suspend the selection sheet first**, then open the existing cart drawer and show the exact selected product/variant/color/size;
- only one modal/focus trap may be active during this handoff. Once cart opens, the cart drawer becomes the focus owner; do not restore focus into the hidden selection sheet while the cart is open;
- if the shopper closes the sheet before adding, current selection persists and the sticky summary reflects it.

### Size-guide modal from the selection sheet

Only **one modal/focus trap may be active at a time**.

- Activating `Hướng dẫn chọn size` from the selection sheet temporarily closes/suspends the selection sheet while preserving the current variant selection and sheet state.
- Open the existing accessible size-guide dialog as the only active modal.
- When the size-guide dialog closes, restore the selection sheet and return focus to its size-guide trigger.
- Do not leave both the sheet and the size-guide dialog active with competing `aria-modal`/focus traps.

### Out of stock

If the fully selected combination/variant is genuinely unavailable:
- do not add it;
- use the generic buyer-safe message **`Lựa chọn này tạm hết`** unless existing authority can prove a more specific statement for the whole dimension;
- do not say only `Size M tạm hết` for a color-bearing product unless authority proves every purchasable color for size M is unavailable;
- keep the selector available so another valid combination can be chosen;
- do not style unresolved options as sold out.

## 4. Mobile product cards and grid rhythm

On phone listing surfaces:
- keep a two-column product grid;
- use **2px grid gap** consistently where the shared `.product-grid` pattern applies;
- product name: **14px**, maximum two lines;
- price: **14–15px**, visually stronger than the name;
- supporting metadata/status: **12px**;
- keep image aspect ratio and existing commerce/marketing truth unchanged.

Do not change desktop column counts as part of this task.

## 5. Mobile header

Phone header presents, in one row:
**menu + logo + search + cart**.

- Search must be directly accessible from the header, not only from inside the menu.
- Account moves/remains inside the mobile menu and is not a competing top-level icon on phone.
- Interactive hit areas should be approximately **44×44 CSS px** even when the visible icon is visually smaller.
- Preserve current search overlay, cart drawer, menu focus management and portal behavior.
- Desktop utility navigation remains unchanged.

## 6. Mobile PLP filters and sort

Above the product list, keep one compact row:
**`Bộ lọc · Sắp xếp`**.

Active conditions render as removable chips with an × control.

### Drawer behavior

- Opening filters keeps a modal/drawer interaction with focus containment and scroll lock.
- Selecting size, color, sale state, or applying price updates the URL/result set **without closing the drawer**.
- The drawer must remain open across those query/result updates.
- Do not create a second business-rule implementation for filtering; URL/query state remains authoritative.
- The footer of the drawer stays fixed and contains:
  - **`Xóa bộ lọc`**
  - **`Xem N sản phẩm`**
- `N` reflects the current server-backed result count after the selected filters.
- Pressing **`Xem N sản phẩm`** closes the drawer; it does not apply a second hidden filter transaction.
- This mobile redesign inherits PR #51's density gate: at **390×844**, with products present and filters in their default/unexpanded state, the top edge of the first product image must be visible within the initial viewport.
- Clearing a single chip updates results and leaves other selected filters intact.

## 7. Mobile cart controls

In the cart drawer/mobile cart presentation:
- quantity decrement/increment touch targets are approximately **44×44 px**;
- disabled states remain obvious and accessible;
- remove/delete is visually and interactively separate from the quantity control group;
- quantity/cart mutation authority remains unchanged.

Do not alter inventory rules or max-quantity enforcement in presentation code.

## 8. Mobile checkout order

Mobile checkout reading/action order:

1. **Collapsible order summary** — default collapsed.
2. **Receiving information**.
3. **Shipping fee + total**.
4. **Existing preorder fulfillment notice, when `preorderNotice` exists.**
5. **`Đặt hàng COD`** submit action.

When `preorderNotice` exists, preserve the existing `BrandPreorderFulfillmentNotice` fulfillment truth and place it in mobile DOM/reading order **before** `Đặt hàng COD`. Presentation must consume the existing notice; do not recompute preorder/mixed-order fulfillment facts in the mobile layout.

### Order summary

Collapsed header always exposes:
**`Đơn hàng (N) · <total>`**

- `N = sum(line.quantity)` across checkout lines. Example: 2 × product A + 1 × product B displays **`Đơn hàng (3)`**, not 2. This is display metadata derived from the existing view model, not a new commerce authority.
- Expanding reveals product images, option labels, quantities and line totals.
- Editing the cart still routes to the existing cart flow.

### Submit ordering

The buyer must see shipping fee and the final displayed total **before** the submit button in mobile DOM/reading order. When `preorderNotice` exists, that fulfillment notice must also appear before the submit button.

Do not solve this only with CSS visual reordering. Preserve the single checkout form/server action/quote-proof workflow and the existing preorder-notice authority; do not fork or duplicate checkout submission or recompute notice facts.

### Checkout typography/copy

- Reduce the mobile `THANH TOÁN` H1 from the current ~56px minimum to a phone-appropriate size; desktop heading scale is unchanged.
- Remove customer-facing implementation wording mentioning **"máy chủ"** or **"Pancake"**.
- Internal comments, telemetry and integration code may still use technical names where appropriate.
- Replacement copy may state only shopper-relevant facts already supported by the view model/policies.

## 9. Accessibility and interaction requirements

- Native semantic buttons/inputs first.
- Bottom sheet and lightbox trap focus while open and restore focus to the opener on close.
- The selection sheet and size-guide dialog are never simultaneously active modal/focus traps; size-guide handoff follows the single-modal contract above.
- The selection sheet and cart drawer are also never simultaneously active modal/focus traps; confirmed add closes/suspends the sheet before cart opens, and cart owns focus while open.
- Escape closes modal surfaces.
- Swipe handling must preserve vertical page scrolling.
- Icon-only controls have accessible names.
- Important add-to-cart/filter/checkout status changes are announced.
- Touch targets approximately 44×44px where practical.
- Selected/unavailable state is not color-only.
- No horizontal page overflow at 320px and 390px widths.

## Testing strategy

### Focused behavior/domain
Add/update tests for:
- mobile gallery current index and non-reordered source order;
- initial mobile gallery load remains on trusted image 1 even for a later-media `?variant=` deep link;
- post-load selected-variant changes map to the correct mobile gallery image without replacing manual selection unexpectedly;
- sticky summary and incomplete CTA copy include only dimensions that exist for product shapes supported by current commerce authority; no color-only purchase contract is introduced;
- composite sheet order is kind → size → color without changing selection authority;
- incomplete sticky action opens selection sheet instead of page scroll;
- complete sheet CTA uses the existing cart path and opens cart only after server-confirmed `result.ok === true`;
- server rejection keeps the sheet open and surfaces feedback without opening cart;
- confirmed success closes/suspends the sheet before opening cart; the cart drawer becomes focus owner and the hidden sheet does not reclaim focus while cart is open;
- size-guide handoff never leaves two active modal/focus traps and restores the sheet/trigger after close;
- genuine out-of-stock feedback uses `Lựa chọn này tạm hết` (or a more specific statement only when authority proves it) and remains distinct from unresolved classification;
- filter URL helpers remain the same authority while drawer-open state survives query updates;
- checkout order-summary count uses `sum(line.quantity)`, including a multi-quantity fixture, without changing quote/price authority;
- preorder and mixed-order checkout fixtures preserve the existing fulfillment notice and assert that it appears before the COD submit action in DOM/reading order.

### Browser/mobile
At 390×844 verify:
- gallery swipes horizontally and shows `current/total`;
- tap opens same-image full-screen lightbox; close/focus restoration works;
- vertical page scroll is not trapped;
- name/price appear directly after gallery;
- bottom sheet follows kind → size → color where applicable; server-confirmed success closes/suspends the sheet before opening the correct cart line, while server rejection keeps the sheet open with feedback;
- header exposes menu/logo/search/cart with practical touch targets;
- filter drawer stays open across multiple filter selections and `Xem N sản phẩm` closes it;
- with default/unexpanded filters, the first product image still enters the initial 390×844 viewport as required by PR #51;
- two-column grid uses 2px rhythm and text does not overflow;
- cart quantity controls are practical touch targets;
- checkout summary is collapsed by default and submit follows displayed shipping/total; when `preorderNotice` exists, the existing fulfillment notice remains visible before submit;
- no buyer-facing "máy chủ"/"Pancake" copy remains in the affected checkout surface;
- clean console and existing buyer Axe gate remain green.

Regression widths:
- 320px phone;
- **768px/tablet: assert the same below-`lg` PDP contract — horizontal one-image gallery, current/total indicator, lightbox, immediate product-info order and quick-purchase flow — not merely "no regression";**
- 1440px desktop to prove this mobile PR did not alter the approved desktop contract.

## Boundaries

### Always
- preserve trusted media filtering/alt truth;
- preserve the single shared variant-selection controller;
- preserve server/cart/checkout authority;
- preserve deep links and selected-variant media mapping;
- preserve focus/keyboard semantics for modal surfaces and keep only one modal/focus trap active during sheet → size-guide handoff;
- update affected tests with user-observable behavior.

### Ask first
- new dependency;
- changing stock/purchasability logic;
- changing checkout server action or Pancake order contract;
- schema/database changes;
- changing product media ordering authority.

### Never
- auto-reorder gallery images based on visual inference;
- create a second client-only stock/cart authority;
- make unresolved options look sold out;
- duplicate checkout submission logic;
- use CSS-only reordering to put checkout totals visually before a submit button that remains earlier in DOM order;
- broaden scope into desktop redesign.

## Success criteria

- [ ] Below `lg`, including representative 390px and 768px widths, PDP uses the horizontal swipe gallery with `current/total` and full-screen lightbox.
- [ ] Frontend preserves admin/source image order; no image-role heuristics are introduced.
- [ ] Product name/price are immediately after gallery and mobile name size is 26–30px.
- [ ] Incomplete sticky purchase opens a bottom sheet with dimension-aware CTA copy only for currently supported product shapes; no color-only purchase contract is introduced. Composite control order follows kind → size → color.
- [ ] Cart opens only after server-confirmed add success; rejection keeps the sheet open and shows feedback.
- [ ] Confirmed success closes/suspends the selection sheet before cart opens; cart becomes the only active modal/focus owner.
- [ ] Successful add opens the cart with exact selected options.
- [ ] Sticky summary includes kind/color/size when they exist.
- [ ] Opening size guide from the sheet never leaves two active modals; closing the guide restores the sheet and focus to the trigger.
- [ ] Mobile product cards use the approved 14px / 14–15px / 12px hierarchy and two-column 2px grid rhythm.
- [ ] Mobile header exposes menu + logo + search + cart with ~44px targets; account is in the menu.
- [ ] Mobile filter drawer stays open across sequential selections and closes only via explicit close/`Xem N sản phẩm`.
- [ ] At 390×844 with default/unexpanded filters, the first product image remains visible in the initial viewport per PR #51.
- [ ] Cart quantity controls are ~44px and remove is separate.
- [ ] Mobile checkout shows collapsed order summary first, then receiving info, then shipping/total, then existing preorder fulfillment notice when present, then COD submit; `Đơn hàng (N)` uses `sum(line.quantity)`.
- [ ] Customer-facing technical "máy chủ"/"Pancake" wording is removed from affected checkout copy.
- [ ] No desktop behavior from PR #51 is redesigned.
- [ ] Relevant domain/browser/accessibility/lint/typecheck/build gates pass before implementation is complete.

## Open questions

None blocking specification. Exact animation duration, lightbox backdrop opacity and spacing values within the approved ranges are implementation details.
