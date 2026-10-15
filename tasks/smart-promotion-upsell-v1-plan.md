# Smart Promotion Upsell v1 — implementation plan

**Status:** PROPOSED /plan — owner đã duyệt **U-01/A, U-02/A**; chờ human review kế hoạch trước `/build`. Không phải bằng chứng đã triển khai.
**Source:** [SPEC-UPS-001 v1.6](../docs/specs/smart-promotion-upsell-v1.md), `main@17d34e0cb7dc40f9f36bce6b6c46903b0e18e2ee` (15/10/2026), PR #169/#170 đã merge.
**Checklist:** [smart-promotion-upsell-v1-todo.md](./smart-promotion-upsell-v1-todo.md). Giữ nguyên `tasks/plan.md` và `tasks/todo.md` (workstream khác).
**Scope:** một module checkout Upsell, chỉ offer variant READY khi server chứng minh **thêm đúng 1 PAID unit** mở lợi ích, không làm mất ưu đãi/quà cũ.

## 1. Quyết định đã khóa và ranh giới

- **U-01/A — chi phí = tổng phải trả sau − trước** với hai canonical quotes và **cùng chính sách phí ship server**; không xếp theo giá niêm yết. `guest-shipping-policy.ts` mặc định 30.000đ; miễn ship khi subtotal sau giảm **>** 1.000.000đ hoặc paid quantity **≥** 3; env override vẫn là authority. Không cộng cứng 30.000đ. Estimate không phải giá chốt.
- **U-02/A — quà mới do Upsell mở được chọn ngay checkout**, reuse `cart-gift-selection.ts`; giỏ vốn đủ mốc **vẫn chọn ở `/cart`** như hiện tại. Không tự chọn quà, không chuyển sang cart rồi quay lại, giữ nguyên thông tin form.
- Bốn loại: gift/tier × quantity/order-subtotal; quantity thiếu đúng 1, tiền ở [80%,100%) **đúng pricing stage**. Gift `S_gift` và tier `S_tier` không bị ép cùng một subtotal. Mọi +1 chạy PR169 full stacking/entitlement/quote.
- Giữ `LA_PROMOTION_UPSELL_ENABLED` **OFF mặc định** và không hoạt động nếu Gift & Quantity gate OFF. Error gợi ý không được phá checkout thường; POS/shop capability và production migration là release gates riêng.
- Không thêm pricing engine, offer admin, queue, catalog-wide optimizer, schema, secret hay dependency theo mặc định. **Không viết code ứng dụng trong PR /plan.** Các thay đổi schema/token (nếu thực sự cần) sẽ có bằng chứng và phê duyệt riêng ở task UP-00.

## 2. Source assessment (đã đọc, chưa chạy runtime)

| Source đang có trên `main` | Tái sử dụng / khoảng trống cần xử lý |
| --- | --- |
| `gift-quantity-candidate-repository.ts`, `gift-quantity-scope.ts` | Campaign ACTIVE/stack/scope có giới hạn; frozen membership được load **theo productIds trong cart**, **không phải** bộ tìm mẫu bên ngoài cart. |
| `storefront-cart-repository.ts#getQuote(items)`, `gift-quantity-quote.ts` | Có thể cấp danh sách PAID items giả lập cho canonical quote; không tự tính tier/order-value, fixed-total hay Flash Sale. |
| `cart-gift-selection.ts#readCartGiftState`, `gift-quantity-entitlement.ts` | Gift state/proof đang đọc persisted cart; read-only `+1` cần adapter tái dùng entitlement với hypothetical paid items, **không tạm ghi DB**. |
| `guest-shipping-policy.ts#calculateGuestShippingFeeVnd` | Đã có fee mặc định 30k và free-ship; phải áp dụng **cả trước và sau** ở U-01. |
| `anonymous-cart.ts#addItemUnit` | Có `SELECT Cart FOR UPDATE` và kiểm tra stock trước commit, nhưng chỉ kiểm line authority; cần check entire cart quote/target **trong cùng lock trước ghi**. |
| `checkout-quote-proof.ts` | HMAC stateless gắn server-read cart UUID + canonical quote; cart ID chỉ là MAC context. **Chưa đủ bằng chứng chống replay khi cart A→B→A quay về cùng quote.** |
| `prisma/schema.prisma` | `Cart.updatedAt` + `CartItem.updatedAt`, **chưa có monotonic paid-cart revision**. Không coi timestamp/fingerprint là bằng chứng ABA-safe. |
| `cart-gift-selection-actions.ts`, `guest-checkout-form.tsx`, `routes/checkout.ts` | Gift selection action, server quote refresh, client form state đã có; cần gắn Upsell trong **một checkout form**, không lặp cart picker authority. |

## 3. U-03 và U-05: hướng tối thiểu + stop rules

**U-03 — tìm ứng viên:** sau khi xác định near campaigns từ quote cart hiện có, query **bounded** các `ProductMirror` ngoài cart cùng shop/active/present. Fixed scope dùng `GiftQuantityFrozenProduct`; dynamic dùng `ProductCategoryMembership` + taxonomy; global chỉ quét pool có `take`, không toàn catalog. Exclude-wins, product uniqueness, READY/capacity và loại đang mua theo product ID. Batch queries, stable ordering campaign priority/id → product ID → variant ID. **Budget khởi điểm để test:** tối đa **24 product IDs đọc** và **24 lần full hypothetical variant quote** trên một checkout read, **tối đa 5 mẫu hiện**. Đây là engineering cap sơ bộ, **không phải số đo hay owner promise**; UP-00/UP-02 phải thử bằng catalog thật, nếu thiếu coverage/latency thì chỉnh một hằng số có test trước bật flag. Với nhiều campaign, phân bổ pool ổn định, không cho một campaign nuốt hết budget. Rank cheapest **chỉ trong tập đã verify**; không claim cheapest toàn catalog. Variant chưa verify chỉ được phép CTA sau server re-quote khi khách chọn.

**U-05 — thêm an toàn:** ưu tiên dùng **checkout quote-proof** hiện có làm bằng chứng giỏ/giá mà khách thấy; server tự xét target/variant, không lấy tiền/discount hay raw cartId từ client. Action nằm trong **một cart-locked transaction**, recompute current quote, +1 hypothetical, gift/stack/stock/POS checks, rồi ghi đúng 1 lần. Không gọi public add action xong mới xác nhận offer.

**Security stop rule UP-00:** thử 2 click, 2 tab, token/quote cũ, cross-cart, campaign revision change và **A→B→A**. Quote-proof chỉ so canonical bytes ⇒ không tự suy diễn replay-proof qua ABA. Nếu hiện trạng không đáp ứng TG-09/AC-34, đề xuất **một guard bền vững nhỏ nhất** (ví dụ cart-scoped monotonic paid-write revision được tăng bởi *mọi* paid-line mutation) cùng scope/migration/revert + tests để duyệt **trước UP-03**; không tự xây nonce table, token stack hay riêng revision cho dismiss. Chỉ tạo HMAC offer token mới nếu test chứng minh existing quote-proof + guard không thể ràng buộc intent an toàn. Nếu không chứng minh được ⇒ block write slice, UI read-only vẫn có thể phát triển OFF.

## 4. Dependency / vertical slices

`UP-00 evidence+U03/U05 decision → UP-01 near/flag → UP-02 bounded quote+ranking → UP-03 atomic +1 → UP-04 checkout UI → UP-05 inline gift+skip → UP-06 regression/rollout gates`

Các slice tách biệt tối đa ở boundary và tests, ưu tiên PR implement nhỏ theo một chức năng; không split code khỏi test chỉ để đạt số file. Checkpoint sau UP-00, UP-02, UP-03, UP-06.

### UP-00 — Characterization & technical gate (first)

- **Work:** Đọc source tại HEAD thực, đo/truy vấn catalog representative cho U-03, viết proof-of-gap tests U-05 (stale/double-click/2-tab/ABA). Quyết định caps sau measurement; ghi rõ có/không cần cart revision và phạm vi ảnh hưởng mọi mutations.
- **Acceptance:** Không giả định quota/time budget đã đo; U-05 có test chứng minh guard ngăn +2/replay hoặc blocker với minimal migration/approval rõ. Quote-proof vẫn là proof hiển thị, không phải money authority.
- **Verification:** focused domain/DB tests: `checkout-quote-proof`, `anonymous-cart-concurrency`, `pdp-atomic-add-to-cart`; source-level review of Prisma locking. **Block UP-03** nếu còn gap. Files dự kiến: focused tests + quyết định kỹ thuật ngắn trong plan/ADR *chỉ nếu cần*.

### UP-01 — Flag OFF + near policy

- **Work:** Pure policy cho bốn campaign/basis, thiếu 1 quantity, money 80%; feature gate chỉ đúng literal true. Không hỏi catalog khi OFF.
- **Acceptance:** Gift cap/ONCE và top rung không gợi ý; `S_gift`/`S_tier` đúng stage (PR169), threshold biên chính xác; OFF parity/cart/checkout không có side effects.
- **Verification:** new `tests/domain/promotion-upsell-policy.test.ts`, existing `gift-quantity-order-subtotal-tier.test.ts` và `gift-quantity-gate.test.ts`. Touch policy + gate + focused tests.

### UP-02 — Bounded read-only +1, filter và winner

- **Work:** Bounded batched product discovery theo scope U-03; cho từng candidate đã giới hạn, dùng `getQuote(items)` + entitlement/checkout quote adapter **đọc-only**, không insert; bảo toàn lợi ích từng campaign và gift selections. Tính U-01 trên hai canonical totals + shipping policy.
- **Acceptance:** Chỉ đúng +1 đạt rung thực, không mất Flash Sale/tier/gift; chọn 1 winner + ≤5 mẫu khác cart, 1–2 vẫn hợp lệ, không eligible thì ẩn. Quote-on-select cho variant khác giá, không dùng price preview làm commit authority. Stable result/truncation; query/quote budgets có test và mẫu catalog.
- **Verification:** unit threshold/ranking + DB hypothetical parity, fixed/dynamic/global scope, order-to-order reachability, 30k→free ship edge; `tests/database/gift-quantity-order-value*.test.ts` regressions. Likely files: read service, small repository query, domain/DB tests; split if scope grows.

### UP-03 — Atomic verified add +1 (security checkpoint)

- **Work:** Narrow extension/reuse of existing `anonymous-cart.ts` transaction guard, verify cart-bound quote proof and target/campaign revision/selected variant, re-run full quote + stock + gift preservation **before mutation**, commit exactly one paid unit; refresh checkout proof afterward.
- **Acceptance:** Corrupted/expired/cross-cart/stale/race/ABA cannot change cart incorrectly; no two-step read→public add gap, no forged money, no cart UUID in wire, no Pancake/order submit on add. No new token/schema unless UP-00 tests require and approved.
- **Verification:** new `tests/database/promotion-upsell-add.test.ts` (double click, 2 tabs, A→B→A, stock/campaign edit, rollback) and domain boundary tests. Gate: tests actually run before UP-04; document any migration separately.

### UP-04 — Checkout offer + variant UX (one form)

- **Work:** One server-rendered optional offer near checkout shipping details; variant selector with server re-quote on change; add/skip CTA, loading/error; `router.refresh`/existing model update without remounting checkout fields. Do not duplicate achieved `PromotionBanner` or `OrderSummary`.
- **Acceptance:** Price, estimate, CTA correspond to selected size; confirmed +1 updates total/shipping/proof and preserves name/phone/address, old proof cannot submit; flag OFF leaves existing experience.
- **Verification:** view-model/unit test + browser scenario (mobile 390, desktop 1280, keyboard/aria-live); no nested form, add `type=button`. Checkout tests under `tests/a11y-runtime/` when available.

### UP-05 — Inline gift picker + skip lifecycle

- **Work:** Reuse cart gift selection server action/authority for newly unlocked gift **inside checkout**; do not duplicate cart feature or auto-select. UI-only skip record per checkout attempt; reset on paid-cart mutation/new attempt/cart and keep for quote-only refresh.
- **Acceptance:** Cart reached gift still chosen at `/cart`; new gift from Upsell selectable inline without losing form; quote/proof and non-claim acknowledgment refresh; skip/reload/new cart/A→B→A don't mis-show. If attempt/version semantics cannot be proven, **hide Upsell only**, checkout remains usable.
- **Verification:** targeted `cart-gift-model` + DB gift selection tests; browser gift choice, skip/reload/new cart/1 form.

### UP-06 — Integrated review and release handoff (not deploy)

- **Work:** Regression for TG-01…TG-12 (historic AC-01…50 are traceable, **not** 50 separate E2E tests); code/security review + exact-head CI evidence and small staging test. Document flag rollback.
- **Acceptance:** Existing checkout/PR169 parity, disabled flag has no new side effect; correctness → security → simplicity → performance reviewed; no owner/technical gate silently bypassed.
- **Verification commands on implementation branch:** `pnpm prisma:generate`; `pnpm prisma:validate` if schema touched; `pnpm lint`; `pnpm typecheck`; `pnpm test:domain`; `pnpm test`; `pnpm test:db`; `pnpm build`; targeted browser Playwright. DB/POS/staging require actual approved environments; do **not** claim passing from docs CI alone.

## 5. Human checkpoints / definition of done

1. **Plan PR:** owner/reviewer chấp nhận scope & technical path; **no /build automatically**.
2. **UP-00 U-05 gate:** technical/security reviewer approves any newly proven need for migration/persistent revision/token. Scope/test impact recorded before implementation; U-03 cap can change only based on measured data, not speculation.
3. **UP-03 merge gate:** all money/cart mutation proof/race tests pass, no unsafe replay; mandatory because checkout is high stakes.
4. **Before production:** Gift/Quantity & Upsell gates default OFF; confirm applied DB migrations (if any), real Pancake line-level pricing/POS, checkout/browser, staging pilot and flag rollback. Merging a docs PR is **not** runtime signoff.

**DoD at build time:** working vertical behavior + regression/security/a11y tests, unchanged old checkout when OFF, no unrelated refactor or new dependencies without approval, logged exact test evidence and reviewed rollback. **This /plan PR does not run build/DB/browser/POS or enable production.**
