# Gift & Quantity Promotions v1 — implementation plan

**Status:** DRAFT PLAN — merged spec is *not* approval of unsettled R decisions, plan or `/build`. Human plan review required.
**Source of truth:** [`docs/specs/gift-quantity-promotions-v1.md`](../docs/specs/gift-quantity-promotions-v1.md) (merged PR #136, `main@431e0deccf5500d9f5adbddfa4528ddcd0926cbf`, 2026-10-13).
**Brand truth precedence:** [`docs/specs/la-na-design-master-spec.md`](../docs/specs/la-na-design-master-spec.md), [`docs/specs/la-na-design-owner-approved-facts-and-decisions.md`](../docs/specs/la-na-design-owner-approved-facts-and-decisions.md), [`tasks/README.md`](./README.md). Legacy promotions v1 is existing-code behavior, not permission to revive Brand #1 truth.
**Companion checklist:** [`tasks/gift-quantity-promotions-v1-todo.md`](./gift-quantity-promotions-v1-todo.md). Existing [`tasks/plan.md`](./plan.md) and [`tasks/todo.md`](./todo.md) remain untouched.

## 1. Outcome, scope and guardrails

Enable owner-configured `GIFT_ITEM` campaigns (quantity or post-discount order value, global/eligible subtotal, once/repeat, user-selected allowlisted gifts with optional caps/duplicates) and `QUANTITY_TIER` pricing (highest achieved tier, percent/fixed VND per unit, ALL/FROM selection, cheapest/most-expensive), plus explicit stack policy/priority, under a safe default-OFF feature gate.

**Non-goals:** coupon/points, per-customer lifetime quota, generic rule engine, automatic substitute gifts, catalog price writes to Pancake, unauthorized live POS tests, unrelated checkout/nav refactor, production launch in this `/plan`.

**Authoritative existing boundaries (read on merged main):**
- `src/commerce/promotion-pricing.ts` resolves at most one legacy promotion per variant; `FIXED_PRICE` is final price; overlapping legacy candidates currently fail to base, so stacking must be behind a new gate.
- `promotion-activation-service.ts` serializes effective writes and advances durable `PromotionPricingRevision` in one transaction; Scheduled→Active is derived from `now`, not a persisted start event.
- `category-taxonomy.ts` owns Brand #2 category hierarchy; `ProductCategoryMembership` is website-owned, not Pancake category truth.
- `CartItem @@unique([cartId,variantId])` represents **paid cart items**; gifts require separate state. `checkout-quote.ts` and `checkout-quote-proof.ts` currently reject 0đ/duplicate variation lines.
- `guest-checkout-snapshot.ts`, `capacity-reservation.ts`, `guest-checkout-submit.ts` and `pancake-order-submit.ts` own draft/hold/HMAC/reprice/idempotency/vendor integration; do not introduce an independent checkout.
- `order-create.ts` TypeScript allows nonnegative line prices; P10 live evidence proves custom positive price only, **not** 0đ or repeated variation IDs. Signed quote remains server authority, never browser-provided price.
- Brand #2 keeps `/sale` as discount route; `guest-shipping-policy.ts` uses legacy `subtotal > threshold` or paid quantity threshold, and gifts must never affect it. Merchant/Meta must not publish cart-only tier discount as unconditional product price.

## 2. Human and evidence gates — stop rules

| Gate | Must be true before continuing | Responsible |
|---|---|---|
| **H0 — Spec decisions (GQ00)** | Explicit owner approval R-01 stack pairing, R-02 legacy FIXED_PRICE, R-03 duplicate gift identity, R-04 READY/composite gift fulfillment, **R-05 FROM `N0` vs alternative**, R-07 category parent/child **và chính sách rounding/granularity riêng** (`BigInt` half-up trên **đơn giá từng chiếc** hay phương án khác); cập nhật spec/EX/AC khi quyết định khác đề xuất | Owner + reviewer |
| **H1 — Vendor POS (GQ01)** | For each used flow, operator-approved live evidence for GIFT 0đ, PAID+GIFT duplicate variant, PAID+PAID duplicate variant with distinct prices; **or** owner-approved exact-money/stock/audit alternative; no dependent `/build` without it | Operator + owner |
| **H2 — Plan** | Human reviews task dependencies/ownership/rollout and explicitly approves plan before `/build` | Owner |
| **H3 — Foundation/flag gate** | GQ03 sở hữu **gate gift/tier độc lập default OFF**; GQ04 chứng minh publish/re-enable và candidate lookup của rule mới bị chặn khi OFF, không bump pricing revision; legacy pricing/activation vẫn đúng. GQ07–08 phải kiểm tra lại OFF parity sau khi nối giá vào cart | Reviewer |
| **H4 — Checkout & integration** | Quote/HMAC and reprice consent, stock concurrency/idempotency, live read-back/reconciliation, no divergent POS totals | Reviewer + operator |
| **H5 — Production** | Exact-head CI, DoD, a11y, security, metrics/alert/rollback, owner go/no-go; feature flag default OFF until explicit `/ship` | Owner + release operator |

**Important:** Merging PR #136 creates a versioned *DRAFT* spec. It does **not** approve R-05 `N0`, per-unit `BigInt` half-up rounding/granularity hay các R points còn mở; GQ06/GQ07/GQ10 và phần `/build` phụ thuộc vẫn BLOCKED cho đến khi H0 có bằng chứng owner. Live side-effect tests require independent explicit operator approval at execution time.

## 3. Dependency graph and incremental slices

```text
                 GQ00 (owner contract)           GQ01 (POS evidence/fallback)
                    |                                      |
              GQ02 scope -------------------------------  |
                    |                                      |
              GQ03 schema+flag OFF -> GQ04 fixed publish/gated activation -> GQ05 Admin scope
                    |                            |
              GQ06 tier -> GQ07 stack -> GQ08 paid cart quote -> GQ09 tier UI
                                                   |
                                              GQ10 entitlement
                                                   |
                                     GQ11 gift DB -> GQ12 selection
                                                   |         |
                                                GQ13 UI   GQ14 cart UI
                                                             |
                           GQ01 -------> GQ15 snapshot -> GQ16 HMAC
                                                |                |
                                                +----> GQ17 reservation
                                                          |
                                                    GQ18 reprice -> GQ19 checkout UI
                                                          |
                                               GQ20 Pancake adapter -> GQ21 reconcile
                                                          |                  |
                                                GQ22 shipping/Meta      GQ24 telemetry
                                                    |                       |
                                                GQ23 Merchant  ------------+
                                                          |
                                                    GQ25 QA/DoD
```

Graph shows primary critical path; the **per-task dependency lists below are authoritative**, including safe parallel edges. One PR per independently revertible concern; code + directly affected tests stay together.

**Review size policy:** ADR 0005 governs PR scope (`≤300` changed lines preferred; `301–500` normally coherent; `>800` split by default). File count is a sizing estimate **not** a hard merge gate; keep tasks focused around ~1–5 files but never split a contract from its tests only to hit an arbitrary cap.

## 4. Task cards

### Phase Gate — Decision / POS evidence gates
### GQ00 — Chốt R-01..R-05/R-07, rounding và ownership
**Purpose:** Đối chiếu spec với Brand #2/legacy; lấy quyết định owner cho R-01..R-05/R-07 **và riêng rounding/granularity ở spec §5** (`BigInt` half-up mỗi chiếc trước khi nhóm dòng hay lựa chọn khác). Không đồng nhất merge spec với phê duyệt `N0` hoặc chính sách làm tròn.

**Dependencies:** None. **Estimate:** S (2 likely files). **Gate:** OWNER.

**Likely files (proposed new paths marked `new`; confirm ownership before coding):**
- `docs/specs/gift-quantity-promotions-v1.md`
- `docs/decisions/<gift-quantity-adr>.md` — new

**Acceptance criteria:**
- [ ] Có bằng chứng owner chấp thuận **từng** R-01..R-05/R-07 **và quyết định độc lập rounding/granularity** (quy tắc, thời điểm làm tròn, đơn vị tính); nếu thiếu, phần build phụ thuộc giữ BLOCKED.
- [ ] Nếu owner chọn khác phương án `N0`/stack/half-up per-unit đề xuất, cập nhật spec, EX-17 và các ví dụ ranh giới VND, AC và ADR trước GQ06/GQ07; không suy diễn `half-up` đã chốt.
- [ ] R-06 được giữ là gate riêng cần evidence POS; không coi custom-price dương là evidence đủ.

**Verification:**
- [ ] Owner decision review kèm link nguồn cho R-01..R-05/R-07 **và rounding**; xác minh spec/ADR/EX/AC khớp quyết định; không chạy runtime tests ở task này.
### GQ01 — Khảo sát ba trường hợp Pancake POS và phương án thay thế
**Purpose:** Chuẩn bị acceptance probe an toàn dựa trên P10, có operator approval, shop/test variants xác định, read-back/cancel/rollback; tách ba case (0đ, PAID+GIFT cùng variation, PAID+PAID cùng variation hai giá). Không chạy trên CI hay live khi chưa được phép.

**Dependencies:** None. **Estimate:** M (3 likely files). **Gate:** POS.

**Likely files (proposed new paths marked `new`; confirm ownership before coding):**
- `scripts/pancake-gift-quantity-capability-probe.ts` — new
- `tests/domain/pancake-gift-quantity-capability-probe.test.ts` — new
- `docs/integrations/pancake-gift-quantity-acceptance.md` — new

**Acceptance criteria:**
- [ ] Trước thao tác POS có explicit operator consent, preflight stock, idempotency key, test order, cleanup/reconcile và log không PII/secret.
- [ ] Mỗi case ghi chính xác request/response/read-back tổng tiền/số lượng, gồm case 290.003đ; nếu thất bại, không ngụy tạo vendor support.
- [ ] Case không được hỗ trợ phải có phương án thay thế bảo toàn tiền/kho/audit được owner duyệt trước khi xây luồng phụ thuộc.

**Verification:**
- [ ] Focused domain probe tests; kiểm tra runbook bằng reviewer; chạy live chỉ trong môi trường được operator phê duyệt.

### Phase Foundation — Scope & persistence
### GQ02 — Quy ước scope Dynamic/Fixed/Global theo taxonomy hiện có
**Purpose:** Định nghĩa typed scope resolver dùng `categoryListingKeys` và membership website-owned, cùng logic cộng các mẫu/màu/size thực mua, loại trừ ưu tiên; global scope chỉ cho gift subtotal toàn đơn. R-07 phải có owner approval trước khi chốt hierarchy.

**Dependencies:** `GQ00`. **Estimate:** M (3 likely files). **Gate:** R-07.

**Likely files (proposed new paths marked `new`; confirm ownership before coding):**
- `src/commerce/category-taxonomy.ts`
- `src/commerce/gift-quantity-scope.ts` — new
- `tests/domain/gift-quantity-scope.test.ts` — new

**Acceptance criteria:**
- [ ] Dynamic đọc membership hiện tại; Fixed chỉ nhận frozen ProductMirror IDs; include/exclude đúng ưu tiên và bounded.
- [ ] `GLOBAL_ALL_PAID_LINES` không đòi category/targets nhưng không được kết hợp includes/excludes; eligible subtype đòi scope.
- [ ] Một set thương mại = một chiếc, các mẫu/size khác nhau cộng số lượng; parent/child category theo resolver đã được duyệt.

**Verification:**
- [ ] `node --env-file-if-exists=.env.local --experimental-strip-types --test tests/domain/gift-quantity-scope.test.ts`
### GQ03 — Schema campaign, scopes và tier/gift config tương thích ngược
**Purpose:** Thiết kế migration additive cho gift/tier, frozen scope, targets, allowlist, tiers; legacy `PromotionCampaign.discountType` giữ nguyên. **Task này sở hữu gate độc lập `LA_GIFT_QUANTITY_PROMOTIONS_ENABLED`**, exact-`true` opt-in, unset/invalid = OFF; không thay thế `LA_PROMOTION_ACTIVATION_ENABLED` của legacy. Gate phải là một boundary server-side tái sử dụng ở GQ04/07/08/09/13.

**Dependencies:** `GQ00`, `GQ02`. **Estimate:** M (5 likely files). **Gate:** MIGRATION/FLAG-OFF.

**Likely files (proposed new paths marked `new`; confirm ownership before coding):**
- `prisma/schema.prisma`
- `prisma/migrations/<gift-quantity-campaign>/migration.sql` — new
- `tests/database/gift-quantity-persistence.test.ts` — new
- `src/commerce/gift-quantity-gate.ts` — new
- `tests/domain/gift-quantity-gate.test.ts` — new

**Acceptance criteria:**
- [ ] Constraints ngăn invalid enum, duplicate tier threshold/target, mixed discount method và orphan references; legacy row đọc như trước.
- [ ] Migration additive + down/feature-off strategy được review, không viết lại price/order lịch sử.
- [ ] Read/write config round-trip; unit tests chứng minh flag unset/`false`/invalid → OFF, **chỉ** `true` → ON, và legacy flag không tự bật gift/tier. Schema validation và DB tests pass.

**Verification:**
- [ ] `pnpm prisma:validate`; focused `tests/database/gift-quantity-persistence.test.ts` và `tests/domain/gift-quantity-gate.test.ts` (env ON/OFF/malformed, không phụ thuộc CI credentials); verify legacy flag independence.
### GQ04 — Freeze fixed product IDs trong transaction publish/Scheduled edit
**Purpose:** Mở rộng activation transaction dưới lock+revision hiện có: freeze Scheduled tại publish, sửa scope thì tái snapshot, edit khác giữ, re-enable chụp lại. **Task này sở hữu enforcement gate của GQ03** tại publish/re-enable/Scheduled material edit và candidate lookup, trước Checkpoint A; không mở được campaign mới chỉ nhờ legacy activation flag.

**Dependencies:** `GQ02`, `GQ03`. **Estimate:** M (4 likely files). **Gate:** SCHEMA/LOCK.

**Likely files (proposed new paths marked `new`; confirm ownership before coding):**
- `src/commerce/promotion-activation-service.ts`
- `src/commerce/promotion-candidate-repository.ts`
- `tests/database/promotion-activation-service.test.ts`
- `tests/database/gift-quantity-persistence.test.ts`

**Acceptance criteria:**
- [ ] Publish/re-enable ghi frozen IDs, frozenAt, revision cùng commit; Scheduled chuyển Active theo clock và zero-traffic không mutate.
- [ ] Sửa scope của Scheduled atomic revalidate/replace; sửa tên hoặc giờ không âm thầm đổi frozen IDs.
- [ ] Category sync đồng thời không làm snapshot nửa cũ; **GQ03 flag OFF** chặn effective new-rule mutation/candidate reads, không bump pricing revision và không đổi legacy quote dù `LA_PROMOTION_ACTIVATION_ENABLED=true`; flag ON không bypass auth/validation; legacy overlap không hồi quy.

**Verification:**
- [ ] Focused `tests/database/promotion-activation-service.test.ts` (OFF/ON, revision, Scheduled freeze) + `tests/domain/gift-quantity-gate.test.ts`; compare existing legacy pricing/quote baseline; `pnpm test:db` và review lock order.

**Checkpoint A (sau GQ03+GQ04, trước GQ05/GQ08):** gate độc lập được tạo & test default-OFF (unset/invalid/legacy-flag-ON); new-rule publish/candidate blocked, không advance pricing revision; fixed snapshot atomic và **legacy quote/pricing baseline không đổi**. Full downstream/cart OFF parity được kiểm chứng lại ở GQ07/GQ08/Checkpoint B, không nhận vơ đã chạy trước.

### Phase Slice A — Admin scope vertical slice
### GQ05 — Admin create/edit/publish scope cho hai loại mới
**Purpose:** Mở action parser + form cho **scope và Draft** new kinds: category/product/exclude, Dynamic/Fixed/Global, preview; server kiểm tra. Chưa cho publish tier/gift **incomplete**: rule-specific parse/validate/persist/activate sẽ thuộc GQ09a/GQ13a; feature gate OFF chặn hiệu lực cho tới lúc đó, legacy writes hoạt động bình thường.

**Dependencies:** `GQ03`, `GQ04`. **Estimate:** M (4 likely files). **Gate:** OWNER+DB.

**Likely files (proposed new paths marked `new`; confirm ownership before coding):**
- `src/commerce/promotion-admin-input.ts`
- `src/app/admin/promotions/actions.ts`
- `src/components/admin/promotion-campaign-form.tsx`
- `tests/database/promotion-admin-operations.test.ts`

**Acceptance criteria:**
- [ ] Admin không thể ghi combo scope mâu thuẫn hay vượt giới hạn; authz server và revisions được kiểm chứng.
- [ ] Scheduled fixed preview hiển thị sản phẩm đã chốt tại publish; Global all-paid không đòi category.
- [ ] Draft scope có lỗi cụ thể; publish campaign new kind khi tier/gift rule còn thiếu hoặc flag OFF phải từ chối; legacy PROMOTION/FLASH_SALE/CLEARANCE action không đổi.

**Verification:**
- [ ] `pnpm test:domain` ; `pnpm test:db` ; manual admin preview trong sandbox

### Phase Slice B — Quantity tier: engine to buyer quote
### GQ06 — Pure tier pricing từng chiếc, FROM N0 và fixed-VND safety
**Purpose:** Pure tier arithmetic: highest tier, ALL/FROM `N0`, cheap/expensive, stable ties, paid `lineId` segments. **Không hardcode BigInt half-up/per-unit trước khi H0 duyệt rounding/granularity**; nếu owner duyệt phương án đề xuất, round **mỗi đơn giá** rồi mới nhóm line, không round tổng dòng.

**Dependencies:** `GQ00`, `GQ02`. **Estimate:** S (2 likely files). **Gate:** R-05 + H0 ROUNDING.

**Likely files (proposed new paths marked `new`; confirm ownership before coding):**
- `src/commerce/gift-quantity-tier.ts` — new
- `tests/domain/gift-quantity-tier.test.ts` — new

**Acceptance criteria:**
- [ ] EX-07/08/17/19: bậc cao nhất, FROM allocation, nhiều biến thể, paid split 290.003đ; không bình quân.
- [ ] Bậc discount không giảm và giá trị fixed VND phải dương; `TIER_PRICE_INVALID` khi giá còn lại ≤ số tiền giảm.
- [ ] No overflow/negative/0đ paid; deterministic segments và tests **rìa VND** theo rounding được owner duyệt: nếu per-unit half-up, `100.001×90%=90.001đ`, `5×90%=4,5→5đ/chiếc`, 3 chiếc →15đ thay vì gộp rồi round 13,5→14đ; không âm thầm đổi granularity.

**Verification:**
- [ ] Focused `tests/domain/gift-quantity-tier.test.ts` ; `pnpm test:domain`
### GQ07 — Stacking policy, priority và adapter legacy price
**Purpose:** Thêm orchestrator tính lần lượt trên giá còn lại, respect bidirectional compatibility và priority đã duyệt; không tự đổi `FIXED_PRICE` cũ hoặc existing conflict when flag OFF. Quà subtotal phải tính sau mọi bước tiền.

**Dependencies:** `GQ00`, `GQ06`. **Estimate:** M (4 likely files). **Gate:** R-01/R-02.

**Likely files (proposed new paths marked `new`; confirm ownership before coding):**
- `src/commerce/promotion-pricing.ts`
- `src/commerce/gift-quantity-stack.ts` — new
- `tests/domain/promotion-pricing.test.ts`
- `tests/domain/gift-quantity-stack.test.ts` — new

**Acceptance criteria:**
- [ ] EX-09: 1m → 900k → 855k; conflict/priority tie fail-closed theo R-01.
- [ ] Legacy `FIXED_PRICE` theo R-02; consume **gate GQ03**, flag OFF parity 100% với resolver cũ (kể cả legacy activation bật).
- [ ] Runtime VND invalid bỏ toàn tier khỏi quote, recompute downstream và phát reason; không clamp/chịu tăng giá không xác nhận.

**Verification:**
- [ ] Focused `tests/domain/gift-quantity-stack.test.ts` ; `pnpm test:domain`
### GQ08 — Đưa tier pricing vào cart quote authority dưới feature flag
**Purpose:** Kết nối bounded campaign lookup, category scope và pure pricing vào cart authority, **tiêu thụ gate default-OFF do GQ03 sở hữu** (không tự tạo flag). Không đưa giá giỏ vào PDP/Merchant như giá đơn chiếc vô điều kiện; không tạo resolver song song.

**Dependencies:** `GQ03`, `GQ04`, `GQ05`, `GQ07`. **Estimate:** M (4 likely files). **Gate:** FEATURE FLAG (GQ03 owner).

**Likely files (proposed new paths marked `new`; confirm ownership before coding):**
- `src/commerce/storefront-cart-repository.ts`
- `src/commerce/storefront-promotion-projection.ts`
- `src/commerce/gift-quantity-quote.ts` — new
- `tests/database/storefront-cart.test.ts`

**Acceptance criteria:**
- [ ] Quote paid khớp tier/stack ở server và guest checkout sau này; thay đổi quantity làm tái tính từ authoritative facts.
- [ ] OFF/unset flag giữ legacy pricing/cart/quote output bất kể legacy activation flag; ON mới đọc rule mới có bounds/no N+1. Reverify OFF parity khi runtime wiring được đưa vào, **sau Checkpoint A**.
- [ ] Không gắn nhãn giá cart-tier lên PDP/PLP/structured data như giá vô điều kiện.

**Verification:**
- [ ] `pnpm test:db` ; `pnpm test:domain` ; manual cart quote sample
### GQ09 — Admin tier ladder, stacking và preview số tiền
**Purpose:** **GQ09a (server write, merge trước)** sở hữu strict parse/validate tier ladder, method `%|VND`, ALL/FROM, priority/stack tại `promotion-admin-input.ts` → `actions.ts` → `promotion-activation-service.ts`, persist/reload/publish dưới lock+revision; invalid phải fail closed. **GQ09b (UI sau GQ09a)** form+preview Q=3→4/invalid-VND. GQ09 chỉ hoàn thành khi cả 2 sub-slices + DB/browser tests pass; không lấy client validation thay server.

**Dependencies:** `GQ05`, `GQ08`. **Estimate:** 2 reviewable sub-PRs: GQ09a (5 server/test files) → GQ09b (3 UI/a11y files). **Gate:** R-05 + H0 ROUNDING + ADMIN WRITE.

**Likely files (proposed new paths marked `new`; confirm ownership before coding):**
- `src/commerce/promotion-admin-input.ts`
- `src/app/admin/promotions/actions.ts`
- `src/commerce/promotion-activation-service.ts`
- `src/commerce/promotion-admin-repository.ts`
- `tests/database/promotion-admin-operations.test.ts`
- `src/components/admin/promotion-campaign-form.tsx`
- `src/components/admin/gift-quantity-tier-fields.tsx` — new
- `tests/a11y-runtime/admin-promotions.spec.ts`

**Acceptance criteria:**
- [ ] **GQ09a:** server parse + validate + persist tier ladder/priority/stack, one discount method per campaign, ngưỡng strict increasing, value không giảm, bounded input; invalid/malformed không persist/publish hoặc bump revision.
- [ ] **GQ09a DB:** `create Draft → read-back → edit → publish/re-enable` giữ đủ tier/stack rules và atomic revision; reject invalid config, unauthorized operation và chứng minh legacy campaign create/edit/publish không hồi quy.
- [ ] **GQ09b:** form/preview hiển thị số chiếc/money steps, EX-19, tier-invalid/priority collision; a11y keyboard/focus/errors và legacy form parity. UI không được bypass server validation.

**Verification:**
- [ ] Focused `tests/database/promotion-admin-operations.test.ts` (create/read/edit/publish + invalid + legacy), `pnpm test:db`, `pnpm test:domain`; `pnpm exec playwright test --config tests/a11y-runtime/playwright.config.ts admin-promotions.spec.ts`.

**Checkpoint B:** complete GQ09a **server tier write contract** + GQ09b Admin preview → paid cart quote, with R-05 & rounding H0 owner-approved, invalid-VND reprice proof and GQ08 downstream OFF parity.

### Phase Slice C — Gift: entitlement to cart choice
### GQ10 — Gift entitlement engine sau paid discounts
**Purpose:** Tính quyền quà theo Q/N hoặc subtotal S/T, ALL_PAID/ELIGIBLE, ONCE/REPEAT, cap, duplicate policy per product và gift variant allowlist. Gift không nâng Q/S/shipping.

**Dependencies:** `GQ02`, `GQ08`. **Estimate:** S (2 likely files). **Gate:** R-03/R-04.

**Likely files (proposed new paths marked `new`; confirm ownership before coding):**
- `src/commerce/gift-quantity-entitlement.ts` — new
- `tests/domain/gift-quantity-entitlement.test.ts` — new

**Acceptance criteria:**
- [ ] EX-01..06, EX-10..12, EX-15: threshold exact, repeat/once, stock partial, opt-out 0..entitled.
- [ ] Cùng product khác size/variant áp duplicate policy đúng R-03; quà chỉ từ biến thể READY/cấp được đúng R-04.
- [ ] Gift không được tính paid quantity, revenue hoặc subtotal; gắn campaign/version cho entitlement.

**Verification:**
- [ ] Focused `tests/domain/gift-quantity-entitlement.test.ts` ; `pnpm test:domain`
### GQ11 — Persist cart gift selections tách paid CartItem
**Purpose:** Migration additive cho selection theo cart/campaign/variant + bounds, không vi phạm `CartItem @@unique([cartId,variantId])` của hàng mua; cung cấp schema snapshot chuẩn bị cho consent.

**Dependencies:** `GQ03`, `GQ10`. **Estimate:** M (3 likely files). **Gate:** MIGRATION.

**Likely files (proposed new paths marked `new`; confirm ownership before coding):**
- `prisma/schema.prisma`
- `prisma/migrations/<gift-selection>/migration.sql` — new
- `tests/database/gift-quantity-gift-selection.test.ts` — new

**Acceptance criteria:**
- [ ] Giữ nhiều gift choices/campaigns với quantity, một cart paid variant vẫn độc lập gift cùng variant.
- [ ] FK/uniqueness/bounds, cascade/revision, không lưu stale gift selection thành paid price authority.
- [ ] Concurrent insert/update không tạo duplicate selection hoặc quantity vượt 2^31 boundary.

**Verification:**
- [ ] `pnpm prisma:validate` ; focused DB selection tests ; `pnpm test:db`
### GQ12 — Server gift selection mutation + capacity authorization
**Purpose:** Một server-owned write boundary cho khách chọn/sửa/bỏ quà bằng cart cookie/session hiện có, entitlement/allowlist/cap/duplicate/READY/stock được re-evaluate khi mutation và quote; state invalid không tự cấp quà.

**Dependencies:** `GQ10`, `GQ11`, `GQ08`. **Estimate:** M (4 likely files). **Gate:** AUTH/INVENTORY.

**Likely files (proposed new paths marked `new`; confirm ownership before coding):**
- `src/commerce/cart-gift-selection.ts` — new
- `src/commerce/anonymous-cart-public-actions.ts`
- `tests/database/gift-quantity-gift-selection.test.ts`
- `tests/domain/anonymous-cart-cookie.test.ts`

**Acceptance criteria:**
- [ ] Không thể forged cart ID, campaign, variant, quantity hay gift out of scope; Admin can change rule so old selection becomes stale.
- [ ] Partial/zero selection được phép, nhưng checkout phải cần separate explicit nonclaim acknowledgement.
- [ ] Concurrent paid/cart/gift mutation không phát sinh entitlement vượt cap; no auto-select/replacement.

**Verification:**
- [ ] Focused DB gift selection tests ; `pnpm test:db` ; authz/CSRF review
### GQ13 — Admin gift rule UX: product/variant allowlist và giới hạn
**Purpose:** **GQ13a (server write, merge trước)** sở hữu parse/validate/persist/read-back/publish gift Q/S, ALL/ELIGIBLE, ONCE/REPEAT, cap, duplicate policy và variant allowlist, qua `promotion-admin-input.ts` → `actions.ts` → `promotion-activation-service.ts` dưới auth/lock/revision. **GQ13b (UI sau GQ13a)** form, chooser, preview quota. Không xem UI form là mutation contract; hai sub-slices phải pass DB/browser tests mới hoàn thành GQ13.

**Dependencies:** `GQ05`, `GQ09`, `GQ10`, `GQ12`. **Estimate:** 2 reviewable sub-PRs: GQ13a (5 server/test files) → GQ13b (4 UI/a11y files); GQ09 trước để tránh cùng sửa write boundary. **Gate:** R-03/R-04 + ADMIN WRITE.

**Likely files (proposed new paths marked `new`; confirm ownership before coding):**
- `src/commerce/promotion-admin-input.ts`
- `src/app/admin/promotions/actions.ts`
- `src/commerce/promotion-activation-service.ts`
- `src/commerce/promotion-admin-repository.ts`
- `tests/database/promotion-admin-operations.test.ts`
- `src/components/admin/gift-quantity-gift-fields.tsx` — new
- `src/components/admin/promotion-campaign-form.tsx`
- `src/app/admin/promotions/page.tsx`
- `tests/a11y-runtime/admin-promotions.spec.ts`

**Acceptance criteria:**
- [ ] **GQ13a:** server validate Q/S scope, ONCE/REPEAT, gift variant allowlist, duplicate toggle/cap/stock/READY, bounds; malformed/unauthorized/incomplete config không persist/publish, copy/edit giữ ngữ nghĩa.
- [ ] **GQ13a DB:** `create Draft → read-back → edit → publish/re-enable`, Scheduled material edit/revision atomic; invalid allowlist/cap/eligibility reject, gift READY/composite đúng R-04, legacy create/edit/publish parity.
- [ ] **GQ13b:** UI gift Q/S and scope, choose variants/caps/duplicates, preview entitlement; keyboard/focus/errors/mobile browser tests; không rely vào client validation cho publish.

**Verification:**
- [ ] Focused `tests/database/promotion-admin-operations.test.ts` (gift create/read/edit/publish + invalid + legacy), `pnpm test:db`; `pnpm exec playwright test --config tests/a11y-runtime/playwright.config.ts admin-promotions.spec.ts`.
### GQ14 — Cart buyer gift picker và hiển thị quyền lợi
**Purpose:** Mở route cart model + UI chooser sản phẩm→variant: earned, selected, skipped, stock, thiếu tới mốc tiếp theo; empty/partial/all-out đúng; không gắn quà 0đ thành paid CartItem.

**Dependencies:** `GQ12`, `GQ08`. **Estimate:** M (5 likely files). **Gate:** BUYER UX.

**Likely files (proposed new paths marked `new`; confirm ownership before coding):**
- `src/routes/cart.ts`
- `src/routes/cart-model.ts`
- `src/app/cart/page.tsx`
- `src/components/brand/cart-gift-picker.tsx` — new
- `tests/a11y-runtime/storefront-commerce.spec.ts`

**Acceptance criteria:**
- [ ] Khách thấy quyền lợi và tự chọn 0..entitled; thay giỏ mất điều kiện phải show stale selection không thay ngầm.
- [ ] Khi quà hết/thiếu, UI cho thấy hàng còn và quyền skip, chưa tự xác nhận thay khách.
- [ ] Không tăng paid count/subtotal; keyboard/ARIA/live status/mobile hoạt động.

**Verification:**
- [ ] `pnpm exec playwright test --config tests/a11y-runtime/playwright.config.ts storefront-commerce.spec.ts` ; `pnpm test:domain`

**Checkpoint C:** Admin gift rule → cart entitlement → explicit user selection/partial skip; no automatic gift or price/ship inflation.

### Phase Slice D — Signed checkout & inventory
### GQ15 — Schema immutable paid/gift order segments và acknowledgement
**Purpose:** Thêm snapshot additive cho role PAID/GIFT, stable `lineId`, ordered discounts, campaign revision, entitled/selected/unclaimed/acknowledged; hai PAID cùng variation khác giá tồn tại riêng, order cũ không thay đổi.

**Dependencies:** `GQ01`, `GQ11`, `GQ08`. **Estimate:** M (3 likely files). **Gate:** POS+MIGRATION.

**Likely files (proposed new paths marked `new`; confirm ownership before coding):**
- `prisma/schema.prisma`
- `prisma/migrations/<gift-order-snapshot>/migration.sql` — new
- `tests/database/guest-checkout-snapshot-schema.test.ts`

**Acceptance criteria:**
- [ ] Snapshot có per-line quantity, integer unit/line VND, `lineId`, role/variant và signed consent facts; immutable finalized.
- [ ] Legacy orders vẫn đọc được, không backfill giả campaign; migration additive có rollback strategy.
- [ ] EX-17/18 không mất hai paid segments khác giá và số quà chưa nhận.

**Verification:**
- [ ] `pnpm prisma:validate` ; focused snapshot schema tests ; migration review
### GQ16 — Signed quote proof theo lineId/role và consent quà
**Purpose:** Mở rộng HMAC canonical bytes, uniqueness theo lineId thay vì variation, money signed từng đoạn; sign gift selections/entitlements và hành động xác nhận bỏ quà một cách context-bound.

**Dependencies:** `GQ14`, `GQ15`. **Estimate:** M (4 likely files). **Gate:** SECURITY.

**Likely files (proposed new paths marked `new`; confirm ownership before coding):**
- `src/commerce/checkout-quote.ts`
- `src/commerce/checkout-quote-proof.ts`
- `tests/domain/checkout-quote.test.ts`
- `tests/domain/checkout-quote-proof.test.ts`

**Acceptance criteria:**
- [ ] EX-13/14/17: PAID+PAID và PAID+GIFT cùng variation, A→B cùng total làm proof stale.
- [ ] Không tiết lộ cart ID/secret, reject forged/truncated/expired/oversized token, verify server recomputation only.
- [ ] selected < entitled buộc signed explicit acknowledgement; total tiền không phải proof duy nhất.

**Verification:**
- [ ] Focused quote/proof domain tests ; security review HMAC canonicalization
### GQ17 — DRAFT order + reservation từ paid/gift price segments
**Purpose:** Đưa quote đã ký qua checkout snapshot, tính stock bằng tổng lượng vật lý theo variant kể cả gift, composite components, giữ chỗ một lần/variant/order; lưu provenance bất biến và không reissue gift trên retry.

**Dependencies:** `GQ15`, `GQ16`, `GQ01`. **Estimate:** M (4 likely files). **Gate:** CAPACITY.

**Likely files (proposed new paths marked `new`; confirm ownership before coding):**
- `src/commerce/guest-checkout-snapshot.ts`
- `src/commerce/capacity-reservation.ts`
- `tests/database/guest-checkout-snapshot.test.ts`
- `tests/database/capacity-reservation.test.ts`

**Acceptance criteria:**
- [ ] EX-18: 2 paid giá A+1 paid giá B giữ đúng 3 chiếc cùng variation, không double-hold; paid+gift cũng cộng đúng.
- [ ] Kiểm tra stock/concurrency trong lock boundary hiện hữu, tính ship paid-only và lưu đúng snapshot.
- [ ] Draft retry/unknown/cancel không tạo duplicate holds/snapshot/line prices; legacy checkout flag OFF parity.

**Verification:**
- [ ] `pnpm test:db` focused snapshot/capacity ; `pnpm test:domain`
### GQ18 — Submit/reprice handshake, VND-invalid và gift nonclaim
**Purpose:** Trước gửi POS re-resolve tất cả quote facts, rule revision, base live price, stock và acknowledgement; nếu khác tạo PRICE_CHANGED + quote mới chờ user action, không tự submit khi tổng tiền có vẻ bằng.

**Dependencies:** `GQ16`, `GQ17`, `GQ08`. **Estimate:** M (4 likely files). **Gate:** SECURITY.

**Likely files (proposed new paths marked `new`; confirm ownership before coding):**
- `src/commerce/guest-checkout-submit.ts`
- `src/commerce/guest-checkout-submit-runtime.ts`
- `tests/domain/guest-checkout-submit.test.ts`
- `tests/database/guest-checkout-p9a-quote-proof.test.ts`

**Acceptance criteria:**
- [ ] EX-21 invalid VND runtime loại toàn tier, recompute price/gift/ship và yêu cầu buyer reconfirm.
- [ ] Out-of-stock gift/changed category/variant/ack proof invalid phải trả quote mới, không tự đổi gift.
- [ ] No repeat submit/hold trong SYNC_UNKNOWN, DRAFT/CONFIRMED idempotency và state gate đúng.

**Verification:**
- [ ] `pnpm test:domain` ; focused `tests/database/guest-checkout-p9a-quote-proof.test.ts` ; `pnpm test:db`
### GQ19 — Checkout UX xác nhận thiếu/bỏ quà và báo giá mới
**Purpose:** Nối route checkout model/guest form với quote role gift, số suất nhận/bỏ qua, explicit acknowledgment và replay-safe submit; hiển thị tách quà giá 0đ và từng bước giảm giá.

**Dependencies:** `GQ18`, `GQ14`. **Estimate:** M (5 likely files). **Gate:** BUYER UX.

**Likely files (proposed new paths marked `new`; confirm ownership before coding):**
- `src/routes/checkout.ts`
- `src/routes/checkout-model.ts`
- `src/components/brand/guest-checkout-form.tsx`
- `src/app/checkout/page.tsx`
- `tests/a11y-runtime/checkout.spec.ts`

**Acceptance criteria:**
- [ ] Chọn 0 quà hoặc nhận thiếu yêu cầu thao tác xác nhận mới được đặt đơn; không pre-checked.
- [ ] Đổi quà hoặc giá mà tổng không đổi vẫn phải hiển thị quote mới và buộc xác nhận lại.
- [ ] Tổng paid+ship và gift 0đ chính xác; keyboard/live errors/mobile UX đạt.

**Verification:**
- [ ] `pnpm exec playwright test --config tests/a11y-runtime/playwright.config.ts checkout.spec.ts` ; manual 0/partial/all gift

**Checkpoint D:** signed buyer quote/consent → immutable paid/gift snapshots → atomic stock reservations → re-quote, before any outbound POS.

### Phase Slice E — POS order & reconciliation
### GQ20 — POS create-order giữ line-level exact money
**Purpose:** Mở rộng outbound Pancake adapter từ typed quote/snapshot, chỉ theo contract đã chứng minh ở GQ01 (hoặc giải pháp owner-approved); PAID+PAID và PAID+GIFT cùng variation không bị gộp sai.

**Dependencies:** `GQ01`, `GQ17`, `GQ18`. **Estimate:** M (4 likely files). **Gate:** R-06.

**Likely files (proposed new paths marked `new`; confirm ownership before coding):**
- `src/integrations/pancake/order-create.ts`
- `src/commerce/pancake-order-submit.ts`
- `tests/domain/pancake-order-openapi-contract.test.ts`
- `tests/database/pancake-order-submit.test.ts`

**Acceptance criteria:**
- [ ] Outbound mỗi segment đúng variation/qty/unit VND và total; EX-17 290.003đ, GIFT 0đ khi POS chấp nhận.
- [ ] Fresh-base recheck so với snapshot theo `lineId`/discount provenance; mismatch làm re-quote, không viết order sai.
- [ ] Không có supported contract/fallback thì flag relevant path OFF và không gọi POS; legacy path vẫn hoạt động.

**Verification:**
- [ ] Focused Pancake contract/domain + DB submission tests; no live side effects in CI
### GQ21 — POS reconciliation/recovery cùng idempotency và inventory
**Purpose:** Read-back price segments và quà theo giới hạn POS, kiểm tra tổng tiền/quantity, reserve state transitions, cancellation/retry/unknown và snapshot audit; không tự tạo lại order khi ambiguous response.

**Dependencies:** `GQ20`, `GQ17`. **Estimate:** M (4 likely files). **Gate:** R-06.

**Likely files (proposed new paths marked `new`; confirm ownership before coding):**
- `src/commerce/pancake-order-reconciliation.ts`
- `src/commerce/pancake-order-submit-runtime.ts`
- `tests/database/pancake-order-reconciliation-runtime.test.ts`
- `tests/database/pancake-order-p10-convergence.test.ts`

**Acceptance criteria:**
- [ ] Read-back/exact-money drift → alert/reconcile chứ không silently CONFIRMED.
- [ ] Cancelled/UNKNOWN/timeout/retry không double-order/double-gift/double-reserve; stock resource accounting đúng.
- [ ] Operator-approved live acceptance (trước production) chứng minh mapping thực tế + cleanup an toàn.

**Verification:**
- [ ] `pnpm test:db` ; controlled live POS check only with independent operator approval

**Checkpoint E:** exact-money Pancake adapter + response/read-back + unknown/retry/cancel/reconcile evidence (GQ01 operator gate already cleared).

### Phase Slice F — Downstream consumers & operations
### GQ22 — Shipping paid-only và analytics Purchase revenue parity
**Purpose:** Audit paid quantity/subtotal của quà 0đ trong free-ship calculation và Meta/analytics purchase projections; không đổi điều kiện > / >= hiện hành. Loại quà khỏi doanh thu, lưu gift identity trong audit.

**Dependencies:** `GQ17`, `GQ20`. **Estimate:** M (4 likely files). **Gate:** ANALYTICS.

**Likely files (proposed new paths marked `new`; confirm ownership before coding):**
- `src/commerce/guest-shipping-policy.ts`
- `src/commerce/meta-purchase-snapshot.ts`
- `tests/domain/guest-shipping-policy.test.ts`
- `tests/database/meta-purchase-reporting.test.ts`

**Acceptance criteria:**
- [ ] Shipping thresholds giữ nguyên, gift units không đẩy paid quantity hoặc merchandise subtotal.
- [ ] Purchase revenue/transaction ID reflect tiền trả thật (gift =0), không double-send event qua retry.
- [ ] Paid+gift same variation giữ identity provenance riêng; full regression parity.

**Verification:**
- [ ] `pnpm test:domain` ; `pnpm test:db` ; event payload inspection in test fixtures
### GQ23 — Merchant/SEO/listing không công bố giá theo giỏ vô điều kiện
**Purpose:** Giữ authoritative per-unit unconditional price trên PDP/PLP/feed/structured data, tier/cart price chỉ hiện khi đạt điều kiện; Merchant cache revision/invalidation và `/sale` semantics không bị phá.

**Dependencies:** `GQ08`, `GQ22`. **Estimate:** M (4 likely files). **Gate:** MERCHANT/SEO.

**Likely files (proposed new paths marked `new`; confirm ownership before coding):**
- `src/commerce/merchant-offer-mapper.ts`
- `src/commerce/storefront-discount-presentation.ts`
- `tests/domain/merchant-structured-data-parity.test.ts`
- `tests/database/shop-effective-price-parity.test.ts`

**Acceptance criteria:**
- [ ] Không quảng cáo tier cart-only như unconditional single-unit product price.
- [ ] Merchant success cache và revision respect effective campaign mutation, no stale price across publish/disable.
- [ ] `/sale` và existing FLASH/CLEARANCE listings truthfully reflect legacy discount status when flag OFF.

**Verification:**
- [ ] `pnpm test:domain` ; `pnpm test:db` ; Merchant/structured-data parity review
### GQ24 — Telemetry, kill switch, audit và rollback readiness
**Purpose:** Thêm signal theo campaign/quote/stock/POS và giám sát fail-closed; feature flag OFF mặc định, bounded/no-PII logs, clear pause/disable/rollback runbook không sửa order immutable.

**Dependencies:** `GQ07`, `GQ18`, `GQ21`. **Estimate:** M (4 likely files). **Gate:** SHIP.

**Likely files (proposed new paths marked `new`; confirm ownership before coding):**
- `src/commerce/promotion-runtime-health.ts`
- `src/operations/promotion-observability.ts`
- `tests/domain/promotion-pricing.test.ts`
- `docs/audits/gift-quantity-rollback.md` — new

**Acceptance criteria:**
- [ ] Có metrics counts: conflict, TIER_PRICE_INVALID, entitlement, unclaimed, quote stale, stock insufficient, POS rejected/unknown.
- [ ] Kill switch ngăn quote mới dùng rule mới mà giữ nguyên trạng thái order cũ; audit revision traceable.
- [ ] Không log cart UUID/token/PII/secret; alert threshold và operator owner/rollback triggers ghi rõ.

**Verification:**
- [ ] Focused telemetry tests; feature-flag OFF/ON smoke; review runbook và alert definitions

### Phase Final — E2E acceptance / launch readiness
### GQ25 — Integration acceptance, DoD và controlled rollout gate
**Purpose:** Chạy exact-head full suite/CI, end-to-end cross-account checkout, concurrency/load bounds, docs/audit, browser accessibility và controlled POS read-back. Chỉ /ship khi tất cả hard gate và owner approve còn hiệu lực.

**Dependencies:** `GQ09`, `GQ13`, `GQ19`, `GQ21`, `GQ22`, `GQ23`, `GQ24`. **Estimate:** M (3 likely files). **Gate:** DoD/SHIP.

**Likely files (proposed new paths marked `new`; confirm ownership before coding):**
- `docs/audits/gift-quantity-acceptance.md` — new
- `tasks/gift-quantity-promotions-v1-todo.md`
- `docs/audits/gift-quantity-rollback.md` — new

**Acceptance criteria:**
- [ ] EX-01..EX-22, AC-01..AC-12 có test/evidence links; 0 Critical/Required, no fake vendor acceptance.
- [ ] Feature flag OFF regression và staged ON path; rollback/drift alert/PII/bounds reviewed; human go/no-go riêng.
- [ ] CI exact head pass; lệnh lint/type/domain/DB/browser/build/release pass với môi trường thật; status ghi failures minh bạch.

**Verification:**
- [ ] `pnpm prisma:validate && pnpm lint && pnpm typecheck && pnpm test && pnpm test:db && pnpm build && pnpm release:check` ; `pnpm exec playwright test --config tests/a11y-runtime/playwright.config.ts` ; operator-approved Pancake

## 5. Parallelization and sequencing

- GQ00 (owner decisions) and GQ01 (POS capability discovery) can be investigated in parallel; neither means permission to mutate live POS. GQ02 category resolver work waits for R-07 decision.
- GQ06 tier pure tests may start after GQ00/GQ02 while GQ03/GQ04 persistence proceeds; **do not** start runtime tier pricing until R-05 is explicitly approved. GQ07 stacking needs R-01/R-02.
- Sau GQ05/GQ08, **GQ09a server tier write → GQ09b UI**; GQ10–12 gift engine/cart mutation có thể tiến hành song song khi không đụng cùng module. **GQ13a server gift write chỉ sau GQ09a/b**, rồi GQ13b UI; serialize các chỉnh sửa `promotion-admin-input.ts`, `actions.ts`, `promotion-activation-service.ts` và shared form, không tạo hai write authorities.
- Migration owners GQ03 → GQ11 → GQ15 must serialize schema changes (GQ11 and GQ15 may each have other prerequisites); reuse additive migrations, never rebase live DB history without review.
- Buyer cart and checkout surfaces GQ14 → GQ19 must coordinate quote role shape with GQ15/GQ16; do not ship UI stating benefits that checkout cannot honor.
- POS adapter GQ20 cannot begin without GQ01 evidence or explicit fallback approval; GQ21 observes the actual adapter contract. GQ22/GQ23 analytics/SEO can proceed behind flag after paid quote/order owner seams stabilize.
- Checkpoint after every 2–3 mergeable tasks, and immediately at any migration, HMAC, concurrency, vendor or human-gate boundary. Small revertible branches, exact-head CI before merge.

## 6. Verification matrix / ship conditions

| Surface | Focused evidence required | Full gate |
|---|---|---|
| Scope/Admin/lifecycle | GQ02–05 fixed scope/default-OFF gate; **GQ09a/GQ13a** create→read→edit→publish, invalid payload rejection, revision/legacy parity | `pnpm prisma:validate`, focused gate tests, `pnpm test:db`, admin Playwright |
| Tier/stack/cart | EX-07/08/09/17/19/21, same variation split, VND > remaining price, quote recompute, legacy OFF | `pnpm test:domain`, `pnpm test:db` |
| Gift selection | EX-01..06/10..16/22, out-of-stock, partial/zero, duplicate products/variants, forged mutation | `pnpm test:domain`, `pnpm test:db`, Playwright |
| Checkout/proof/stock | HMAC on `lineId`/role/price/discount+ack; quote diff with same total; stock paid+gift; race/retry/unknown | `pnpm test:db`, Playwright checkout |
| Pancake | Operator-approved 0đ, paid+gift, paid+paid custom-price read-back; cancel/unknown idempotency | Manual POS acceptance outside CI; no claims before run |
| Marketing | Paid-only shipping, Meta Purchase paid revenue, Merchant/PDP unconditional-price policy | Domain + database parity tests |
| Ship | Flag OFF regressions, security, a11y, metrics/alert, rollback, no Critical/Required | Exact-head CI + build + release check + human `/ship` |

**Repository-defined commands (verified from `package.json` on merged `main`):**
```bash
pnpm install --frozen-lockfile
pnpm prisma:validate
pnpm lint
pnpm typecheck
pnpm test:domain
pnpm test
pnpm test:db
pnpm exec playwright test --config tests/a11y-runtime/playwright.config.ts
pnpm build
pnpm release:check
```

Do not run live Pancake acceptance on CI or without explicitly approved test-shop credentials, safe order data, rollback/cancel plan and operator supervision. Exact CI job names, flags, and feature toggles are reviewed at implementation time; this plan neither invents current environment secrets nor marks tests passed.

## 7. Definition of Done and sign-off

Each task must: prove new behavior with tests that would fail without it, pass focused and relevant regression checks, preserve existing legacy/feature-OFF behavior, maintain authz and bounded external inputs, record migration/backcompat and immutable order semantics, provide observability, rollback and exact-head verification. Review order: correctness → security → architecture → simplicity → performance. Repo PR-scope ADR 0005 governs cohesion and diff size. No unapproved new dependency/secret, live POS write, deploy or indexation change.

**Current state:** `/plan` artifacts only. GQ00–GQ25 are **all unchecked**. PR #136 merged a reviewed DRAFT spec; R-01..R-05/R-07, **rounding/granularity**, and R-06 are not inferred approved from that merge. Implementation requires explicit plan approval; production requires separate `/ship` approval.
