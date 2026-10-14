# Gift & Quantity Promotions v1 — task checklist

**Status:** IN PROGRESS — owner started `/build` (13/10/2026). H0 decisions: ADR 0016. Tasks are checked only after merge **and** verification evidence.
**Source spec:** [`docs/specs/gift-quantity-promotions-v1.md`](../docs/specs/gift-quantity-promotions-v1.md), merged PR #136 at `main@431e0deccf5500d9f5adbddfa4528ddcd0926cbf`.
**Implementation plan:** [`tasks/gift-quantity-promotions-v1-plan.md`](./gift-quantity-promotions-v1-plan.md). Do not alter historical `tasks/plan.md` or `tasks/todo.md`.

## Hard approvals / blockers
- [x] **H0 Owner (ADR 0016, 13/10/2026):** R-01..R-05/R-07 **và quyết định riêng rounding/granularity** (BigInt half-up **mỗi chiếc** vs cách khác) có owner sign-off; update spec/EX/AC/ADR trước GQ06/GQ07 `/build` nếu khác phương án đề xuất.
- [ ] **H1 POS (OPEN — API-level; owner amended gift representation to 1.000đ per unit, ADR 0016 D-08):** per-case live evidence (GIFT 0đ; PAID+GIFT duplicate variant; PAID+PAID different prices) **or** owner-approved exact-money alternative; no build of vendor-dependent path before this gate.
- [x] **H2 Plan (owner issued `/build` 13/10/2026):** Owner reviews/approves this plan and PR sizing/dependency graph.
- [ ] **H3 Core:** GQ03 tạo gate `LA_GIFT_QUANTITY_PROMOTIONS_ENABLED` độc lập default-OFF; GQ04 chứng minh OFF chặn new publish/candidates, không bump revision, legacy activation/quote parity trước Checkpoint A; GQ07/08 reverify cart OFF parity sau wiring.
- [ ] **H4 Checkout:** HMAC+nonclaim consent, reservation race/idempotency, Pancake read-back/reconcile.
- [ ] **H5 Ship:** exact-head CI, DoD, a11y, security, observability, rollback, separate launch approval; feature gate mặc định OFF cho tới `/ship`.

## Task execution (all initially unchecked)

### Decision / POS evidence gates
- [x] **GQ00 — Chốt R-01..R-05/R-07, rounding và ownership** _(deps: none; gate: OWNER)_
  - [x] Chốt từng R-01..R-05/R-07 **và rounding/granularity riêng biệt** (quy tắc, lúc làm tròn, per-unit/per-line) có bằng chứng owner; nếu thiếu, implementation liên quan BLOCKED.
  - [x] Nếu owner chọn khác `N0`/stack/half-up per-unit, sửa spec/EX-17/VND boundary/AC/ADR trước GQ06/GQ07.
  - [x] R-06 được giữ là gate riêng cần evidence POS; không coi custom-price dương là evidence đủ.
  - [x] **Evidence:** Owner link sign-off cho R-01..R-05/R-07 **và rounding**; spec/ADR/EX/AC nhất quán; không cần runtime tests.
  - Evidence (13/10/2026): owner answers captured in `/build` session; recorded in [ADR 0016](../docs/decisions/0016-gift-quantity-promotions-v1-decisions.md); spec status updated. Owner chose the spec's proposal for every item, so EX/AC values are unchanged. R-06 remains an open POS gate.
- [ ] **GQ01 — Khảo sát ba trường hợp Pancake POS và phương án thay thế** _(deps: none; gate: POS)_ — **BUILD DONE (probe + runbook + tests); LIVE EVIDENCE PENDING (H1/R-06) — task stays open**
  - [x] Trước thao tác POS có explicit operator consent (`GQ_POS_PROBE_APPROVED=shop:<id>` + danh sách case), preflight stock, một lần tạo duy nhất (không retry; run id trong note), cleanup bằng huỷ đơn mọi đường thoát, log không PII/secret (tests với fake client).
  - [ ] Mỗi case ghi chính xác request/response/read-back tổng tiền/số lượng, gồm case 290.003đ — **cần operator chạy live**; chưa có kết quả, không ngụy tạo vendor support.
  - [x] Case không được hỗ trợ có phương án thay thế đề xuất trong runbook (cần owner duyệt trước khi xây luồng phụ thuộc). Cases theo ADR 0016 D-08: `PAID_PAID_DIFFERENT_PRICE` (290.003đ), `PAID_GIFT_VENDOR_PRICE_SAME_VARIATION` (99.000đ + quà 1.000đ), `GIFT_ZERO_PRICE_INFORMATIONAL` (không gating).
  - [x] **Evidence (offline):** `tests/domain/pancake-gift-quantity-capability-probe.test.ts` 16/16 pass; runbook [`docs/integrations/pancake-gift-quantity-acceptance.md`](../docs/integrations/pancake-gift-quantity-acceptance.md). **Live evidence log: NOT RUN.**

### Scope & persistence
- [x] **GQ02 — Quy ước scope Dynamic/Fixed/Global theo taxonomy hiện có** _(deps: GQ00; gate: R-07)_
  - [x] Dynamic đọc membership hiện tại; Fixed chỉ nhận frozen ProductMirror IDs; include/exclude đúng ưu tiên và bounded.
  - [x] `GLOBAL_ALL_PAID_LINES` không đòi category/targets nhưng không được kết hợp includes/excludes; eligible subtype đòi scope.
  - [x] Một set thương mại = một chiếc, các mẫu/size khác nhau cộng số lượng; parent/child category theo resolver đã được duyệt.
  - [x] **Evidence:** `node --env-file-if-exists=.env.local --experimental-strip-types --test tests/domain/gift-quantity-scope.test.ts`
  - Evidence: `tests/domain/gift-quantity-scope.test.ts` 16/16 pass (EX-05/06/16/22, include/exclude, bounds, frozen never widens, global refused outside GIFT ORDER_SUBTOTAL ALL_PAID_LINES); `src/commerce/gift-quantity-scope.ts`; parent/child via `categoryListingKeys` (ADR 0016 D-07).
- [x] **GQ03 — Schema campaign, scopes và tier/gift config tương thích ngược** _(deps: GQ00, GQ02; gate: MIGRATION/FLAG-OFF)_
  - [x] Constraints ngăn invalid enum, duplicate tier threshold/target, mixed discount method và orphan references; legacy row đọc như trước.
  - [x] Migration additive + down/feature-off strategy được review, không viết lại price/order lịch sử.
  - [x] Persist/read config round-trip; độc lập gate default-OFF khi unset/invalid/legacy-ON, chỉ exact `true` bật; schema, DB & domain gate tests pass.
  - [x] **Evidence:** `pnpm prisma:validate` ; focused `tests/database/gift-quantity-persistence.test.ts` + `tests/domain/gift-quantity-gate.test.ts` (OFF/ON/invalid, legacy independent).
  - Evidence: migration `20261013120000_add_gift_quantity_campaigns` (additive, own tables/enums, rollback = drop tables then types, documented in the migration header; ADR 0016 D-09); `tests/database/gift-quantity-persistence.test.ts` 19/19 and `tests/domain/gift-quantity-gate.test.ts` 5/5 pass; `pnpm prisma:validate` ok; full `pnpm test:db` 642/642 and `pnpm test` 2852/2852 (1 skipped) locally.
- [x] **GQ04 — Freeze fixed product IDs trong transaction publish/Scheduled edit** _(deps: GQ02, GQ03; gate: SCHEMA/LOCK)_
  - [x] Publish/re-enable ghi frozen IDs, frozenAt, revision cùng commit; Scheduled chuyển Active theo clock và zero-traffic không mutate.
  - [x] Sửa scope của Scheduled atomic revalidate/replace; sửa tên hoặc giờ không âm thầm đổi frozen IDs.
  - [x] Sync category không tạo snapshot nửa cũ; **GQ03 flag OFF** chặn publish/re-enable/candidate new kinds, không bump pricing revision; legacy flag ON không bật gift/tier, legacy quote/overlap không hồi quy.
  - [x] **Evidence:** focused `tests/database/promotion-activation-service.test.ts` + domain gate tests (OFF/ON/revision/fixed freeze), legacy pricing baseline; `pnpm test:db` + lock review.
  - Evidence: `src/commerce/gift-quantity-activation-service.ts` (publish / re-enable / Scheduled edit / disable / end-early under the shared revision lock) and `gift-quantity-candidate-repository.ts`; `tests/database/gift-quantity-activation-service.test.ts` 26/26 pass: gate OFF (incl. legacy flag ON) refuses and reads/advances nothing, Fixed ids + frozenAt + campaign revision frozen at publish, nothing written at startsAt (EX-20), scope edit replaces the snapshot, name/time/priority edits keep it, re-enable re-captures, refused edits roll back, disable/end-early ungated, concurrent publishes serialized, a rename is neither gated nor rule-validated, a Scheduled edit can never clear or backdate startsAt, disable only for ACTIVE/SCHEDULED, end-early bumps the campaign revision, excludes applied before the freeze bound. Membership is read with one SQL statement (one snapshot). Production rule validator refuses publish until GQ09a/GQ13a (fail closed). Full `pnpm test:db` 642/642 locally.
- [x] **Checkpoint A:** sau GQ03+GQ04, chứng minh independent gate default-OFF/invalid/legacy flag ON, no new-rule publish/candidates/revision bump, fixed freeze + legacy quote baseline; downstream OFF cart parity đợi GQ07/08.
  - Evidence: GQ03 gate default-OFF (unset/invalid/legacy-flag-ON all OFF), new-rule publish/candidate lookup blocked with no revision bump, Fixed freeze atomic, legacy suites unchanged (full `pnpm test:db` 642/642, `pnpm test` 2852/2852). Downstream cart OFF parity remains for GQ07/GQ08.
### Admin scope vertical slice
- [x] **GQ05 — Admin create/edit/publish scope cho hai loại mới** _(deps: GQ03, GQ04; gate: OWNER+DB)_
  - [x] Admin không thể ghi combo scope mâu thuẫn hay vượt giới hạn; authz server và revisions được kiểm chứng.
  - [x] Scheduled fixed preview hiển thị sản phẩm đã chốt tại publish; Global all-paid không đòi category.
  - [x] Scope Draft UI validated; incomplete tier/gift publish hoặc flag OFF bị reject trước GQ09a/GQ13a; legacy PROMOTION/FLASH_SALE/CLEARANCE vẫn đúng.
  - [x] **Evidence:** `pnpm test:domain` ; `pnpm test:db` ; manual admin preview trong sandbox
  - Evidence: `/admin/promotions/gift-quantity` (list, create, edit Draft/Scheduled, copy, publish, disable, end-early) with its own server actions, funnel and form; legacy `/admin/promotions` form/actions untouched (only a header link added). `tests/domain/gift-quantity-admin-input.test.ts` 10/10, `tests/domain/gift-quantity-admin-operation.test.ts` 8/8 (authorize-before-parse order, per-action label/service contract, no payload in messages), `tests/database/gift-quantity-admin-operations.test.ts` 9/9 (authz, round trip, contradictions refused and nothing written incl. global+targets/ALL_PAID_LINES with a real scope/unknown product/oversized lists, trigger change clears the replaced trigger, kind immutable, Draft-only edits, copy re-captures its own freeze), `tests/a11y-runtime/admin-gift-quantity.spec.ts` 8/8 in Chromium (Axe clean at 390px, EX-22 form reshapes and hides category/product pickers, keyboard, typed announced refusal while the gate is OFF, DB rows exactly as typed) and the legacy `admin-promotions.spec.ts` still 7/7; `scripts/admin-authz-http-smoke.ts` extended and passing. Publish stays refused (`INVALID_RULE`) until GQ09a/GQ13a.

### Quantity tier: engine to buyer quote
- [x] **GQ06 — Pure tier pricing từng chiếc, FROM N0 và fixed-VND safety** _(deps: GQ00, GQ02; gate: R-05 + H0 ROUNDING)_
  - [x] EX-07/08/17/19: bậc cao nhất, FROM allocation, nhiều biến thể, paid split 290.003đ; không bình quân.
  - [x] Bậc discount không giảm và giá trị fixed VND phải dương; `TIER_PRICE_INVALID` khi giá còn lại ≤ số tiền giảm.
  - [x] No overflow/negative/0đ paid; stable paid segments và boundary theo rounding được owner duyệt; nếu half-up mỗi chiếc: `100.001×90%=90.001`, `5×90%=5` mỗi chiếc, qty=3→15 thay vì line-round 14.
  - [x] **Evidence:** Focused `tests/domain/gift-quantity-tier.test.ts` ; `pnpm test:domain`
  - Evidence: `src/commerce/gift-quantity-tier.ts` + `tests/domain/gift-quantity-tier.test.ts` 21/21 pass: EX-07/08/17/19, highest-tier-only, FROM from N0, half-up per unit (`5×90%=5`, 3 units = 15), 290.003đ split without averaging, whole-tier `TIER_PRICE_INVALID` (no clamp, no partial), monotonic-benefit property, bounds/overflow; `pnpm test:domain` locally.
- [x] **GQ07 — Stacking policy, priority và adapter legacy price** _(deps: GQ00, GQ06; gate: R-01/R-02)_
  - [x] EX-09: 1m → 900k → 855k; conflict/priority tie fail-closed theo R-01.
  - [x] Legacy `FIXED_PRICE` R-02; consume gate GQ03 và OFF parity với resolver cũ kể cả legacy activation ON.
  - [x] Runtime VND invalid bỏ toàn tier khỏi quote, recompute downstream và phát reason; không clamp/chịu tăng giá không xác nhận.
  - [x] **Evidence:** Focused `tests/domain/gift-quantity-stack.test.ts` ; `pnpm test:domain`
  - Evidence: `src/commerce/gift-quantity-stack.ts` + `tests/domain/gift-quantity-stack.test.ts` 17/17 pass: no-tier parity with the legacy resolver, EX-09 (1.000.000 → 900.000 → 855.000), priority order changes money, two-way consent (kind/id/stacking flag), tie/missing priority fail closed, R-02 ceiling, EX-21 whole-tier drop + chain re-run, determinism, money identities. Legacy `FIXED_PRICE`/resolver untouched (only `applyPercentage` is now exported). Gate consumption/OFF cart parity is wired and re-verified in GQ08. ADR 0016 D-10 records the consent model.
- [ ] **GQ08 — Đưa tier pricing vào cart quote authority dưới feature flag** _(deps: GQ03, GQ04, GQ05, GQ07; gate: FEATURE FLAG from GQ03)_
  - [ ] Quote paid khớp tier/stack ở server và guest checkout sau này; thay đổi quantity làm tái tính từ authoritative facts.
  - [ ] Gate GQ03 OFF/unset giữ exact legacy quote/cart output; ON bounded lookups/no N+1; verify lại sau wiring, không tính vào Checkpoint A.
  - [ ] Không gắn nhãn giá cart-tier lên PDP/PLP/structured data như giá vô điều kiện.
  - [ ] **Evidence:** `pnpm test:db` ; `pnpm test:domain` ; manual cart quote sample
- [ ] **GQ09 — Admin tier ladder, stacking và preview số tiền** _(deps: GQ05, GQ08; gate: R-05 + H0 ROUNDING + ADMIN WRITE)_
  - [ ] **GQ09a server:** parse/validate/persist/publish ladder, method, FROM, priority/stack, strict bounds; malformed/unbounded không write; Draft incomplete được lưu nhưng publish business-invalid bị chặn và không bump revision.
  - [ ] **GQ09a DB:** create Draft → read → edit → publish/re-enable, invalid payload reject, atomic revision & legacy create/edit/publish parity.
  - [ ] **GQ09b UI:** tier preview EX-19, money steps, invalid VND/priority; browser keyboard/focus/errors & legacy form parity; finish GQ09 only after a+b.
  - [ ] **Evidence:** focused `tests/database/promotion-admin-operations.test.ts` (create/read/edit/publish + invalid + legacy), `pnpm test:db`, `pnpm test:domain`, `pnpm exec playwright test --config tests/a11y-runtime/playwright.config.ts admin-promotions.spec.ts`.
- [ ] **Checkpoint B:** GQ09a tier server write + GQ09b UI, authoritative tier quote, R-05/rounding owner approval and GQ08 downstream OFF parity.

### Gift: entitlement to cart choice
- [ ] **GQ10 — Gift entitlement engine sau paid discounts** _(deps: GQ02, GQ08; gate: R-03/R-04)_
  - [ ] EX-01..06, EX-10..12, EX-15: threshold exact, repeat/once, stock partial, opt-out 0..entitled.
  - [ ] Cùng product khác size/variant áp duplicate policy đúng R-03; quà chỉ từ biến thể READY/cấp được đúng R-04.
  - [ ] Gift không được tính paid quantity, revenue hoặc subtotal; gắn campaign/version cho entitlement.
  - [ ] **Evidence:** Focused `tests/domain/gift-quantity-entitlement.test.ts` ; `pnpm test:domain`
  - Pending-merge evidence (tick only after PR merge and verification): `src/commerce/gift-quantity-entitlement.ts` (`evaluateGiftEntitlements`, `validateGiftSelections`) + `tests/domain/gift-quantity-entitlement.test.ts` 35/35 pass (`pnpm test:domain` 2724 pass, 0 fail, 1 skipped; `pnpm test` 2986 pass, 0 fail, 1 skipped; `pnpm test:db` 668/668): EX-01/02/03/04/05/06/10/11/12/15/22, boundaries at N-1/N/2N/2N+1 and T-1/T/2T+1 (`>=`), ONCE vs REPEAT, cap + technical cap, R-03 duplicates per `ProductMirror` (across variants), R-04 READY-only / composite / zero-stock options never selectable, 0..entitled selection with acknowledgement split into skipped-while-available vs short-for-stock, shared stock across campaigns, entitlement carries campaign id + revision (stale revision refused), forged campaign/variant/malformed lines refused without echoing client text, order-independent output, BigInt threshold + safe-integer overflow refusal. Pure and paid-groups-only, so a gift never moves Q/S/paid count. Mutation-checked: `>` instead of `>=`, per-variant instead of per-product duplicates, allowing composite, and ignoring scope each fail the suite. Not wired into cart yet (GQ08 wiring is a separate task; engine takes its own explicit input type). Review fixes F1/F2: the unclaimed-slot split is computed on the stock left after the chosen gifts (`skippedWhileAvailable` only for stock guaranteed even if other campaigns claim first, `contendedForSharedStock` for shared stock that cannot be attributed, `shortForStock` otherwise; order independent) and `GiftSelectionLine.campaignRevision` is REQUIRED (missing -> `SELECTION_REVISION_INVALID`, mismatch or edited campaign -> `STALE_CAMPAIGN_REVISION`). GQ12 must map `CartGiftSelection.campaignRevision` straight through.
- [ ] **GQ11 — Persist cart gift selections tách paid CartItem** _(deps: GQ03, GQ10; gate: MIGRATION)_
  - [ ] Giữ nhiều gift choices/campaigns với quantity, một cart paid variant vẫn độc lập gift cùng variant.
  - [ ] FK/uniqueness/bounds, cascade/revision, không lưu stale gift selection thành paid price authority.
  - [ ] Concurrent insert/update không tạo duplicate selection hoặc quantity vượt 2^31 boundary.
  - [ ] **Evidence:** `pnpm prisma:validate` ; focused DB selection tests ; `pnpm test:db`
  - PENDING MERGE evidence (not ticked until the PR is merged and verified): `prisma/migrations/20261014110000_add_cart_gift_selection` (additive `CartGiftSelection`; no existing table or `CartItem` semantics touched; rollback = `DROP TABLE "CartGiftSelection"`; `prisma migrate diff` migrations-vs-schema empty on a from-scratch DB) + `src/commerce/cart-gift-selection-repository.ts` (`setCartGiftSelection`/`removeCartGiftSelection`/`clearCartGiftSelections`/`listCartGiftSelections`/`classifyGiftSelectionFreshness`). **Low-level primitive, not an authority:** `freshness: CURRENT` only means the stored revision equals the campaign revision, and an empty `issues` list only means no known problem; neither is buyer consent nor validity. GQ12/checkout must recompute entitlement/stock and get explicit buyer confirmation, and only GQ12 may call `setCartGiftSelection`.
  - Revision rule (review GQ11-F1): `setCartGiftSelection` is one `INSERT..SELECT..FOR SHARE..ON CONFLICT` that stores only the campaign's LIVE revision (else `REVISION_MISMATCH`; unknown/tier campaign `REFERENCE_NOT_FOUND`), so a future revision cannot be pre-stored and an admin bump leaves old rows STALE; stale->current only by a write carrying the live revision. An uncommitted concurrent bump makes the writer wait, then be refused.
  - Lifecycle rule (review GQ11-F2, FR-06): lifecycle audit found no app code that hard-deletes `VariantMirror`/`ProductMirror`/`GiftQuantityCampaign` (catalog sync soft-deletes `isPresent`/`isActive=false`; campaigns are disabled, which bumps the revision; only `scripts/*-http-smoke.ts` and tests delete product mirrors). The FKs to the variant and the campaign are therefore `ON DELETE RESTRICT` (precedent: capacity reservations), only the cart cascades; `listCartGiftSelections` keeps every row and reports `issues` (`STALE_REVISION`, `CAMPAIGN_DISABLED`, `VARIANT_INACTIVE`, `NO_MIRRORED_STOCK`) plus `campaignEnabled`/`variantActive`/`mirroredStock`. Mirrored stock is advisory (composite/reserved capacity is GQ10/GQ12).
  - `tests/database/gift-quantity-cart-gift-selection.test.ts` 19/19: gift for variant V coexists with the paid line and never changes it (also under concurrent gift+paid writes); absolute/idempotent set; many gifts/campaigns per cart, carts isolated; 24 writers on one key and 32 on two keys leave one row per key with no error; 150 racing raw `quantity+1` stop at exactly 100 by the CHECK; quantity 0/101/2^31 and revision 0 refused in code and CHECK; tier campaign/unknown cart/campaign/variant refused (`REFERENCE_NOT_FOUND`); duplicate raw insert refused by the unique key; future/old revision refused and a bump never turns a row CURRENT; stale->current only through a live-revision write; deterministic concurrent-bump race (writer blocks, then `REVISION_MISMATCH`) plus a 20-bump/40-writer storm never storing a revision above the campaign; campaign disable keeps and reports the choice; chosen variant/product/campaign hard delete is refused while unrelated rows delete and the cart cascades; variant deactivated/removed-from-sync/out-of-stock keeps the row and is reported; remove/clear idempotent; >100 selections fails closed; no price/entitlement column. Mutation proof: dropping the live-revision predicate fails 2 tests, dropping `FOR SHARE` fails the race test, `ON DELETE CASCADE` on the variant FK fails the lifecycle test, dropping the quantity CHECK fails 2 tests. No code dependency on GQ10 (limits are local constants: 100 = `maxGiftsPerOrder` bound). `pnpm prisma:validate` ok; `pnpm -s typecheck` clean; lint 0 errors; `pnpm test` 2952 (2951 pass, 0 fail, 1 skipped); `pnpm test:db` 687/687 on a from-scratch DB.
- [ ] **GQ12 — Server gift selection mutation + capacity authorization** _(deps: GQ10, GQ11, GQ08; gate: AUTH/INVENTORY)_
  - [ ] Không thể forged cart ID, campaign, variant, quantity hay gift out of scope; Admin can change rule so old selection becomes stale.
  - [ ] Partial/zero selection được phép, nhưng checkout phải cần separate explicit nonclaim acknowledgement.
  - [ ] Concurrent paid/cart/gift mutation không phát sinh entitlement vượt cap; no auto-select/replacement.
  - [ ] **Evidence:** Focused DB gift selection tests ; `pnpm test:db` ; authz/CSRF review
- [ ] **GQ13 — Admin gift rule UX: product/variant allowlist và giới hạn** _(deps: GQ05, GQ09, GQ10, GQ12; gate: R-03/R-04 + ADMIN WRITE)_
  - [ ] **GQ13a server:** strict parse/validate/persist/publish Q/S, ALL/ELIGIBLE, ONCE/REPEAT, allowed variants, duplicate/cap; malformed/unauth không write; Draft incomplete được lưu, publish rule invalid bị chặn/no revision bump.
  - [ ] **GQ13a DB:** create Draft → read → edit → publish/re-enable, invalid allowlist/cap/eligibility reject; READY/composite, Scheduled revision/copy và legacy parity.
  - [ ] **GQ13b UI:** gift product/variant selector, caps/duplicates, Q/S preview; mobile/keyboard/focus/errors; finish GQ13 only after a+b.
  - [ ] **Evidence:** focused `tests/database/promotion-admin-operations.test.ts` (gift create/read/edit/publish + invalid + legacy), `pnpm test:db` + `pnpm exec playwright test --config tests/a11y-runtime/playwright.config.ts admin-promotions.spec.ts`.
- [ ] **GQ14 — Cart buyer gift picker và hiển thị quyền lợi** _(deps: GQ12, GQ08; gate: BUYER UX)_
  - [ ] Khách thấy quyền lợi và tự chọn 0..entitled; thay giỏ mất điều kiện phải show stale selection không thay ngầm.
  - [ ] Khi quà hết/thiếu, UI cho thấy hàng còn và quyền skip, chưa tự xác nhận thay khách.
  - [ ] Không tăng paid count/subtotal; keyboard/ARIA/live status/mobile hoạt động.
  - [ ] **Evidence:** `pnpm exec playwright test --config tests/a11y-runtime/playwright.config.ts storefront-commerce.spec.ts` ; `pnpm test:domain`
- [ ] **Checkpoint C:** gift selection/opt-out/cart UX verified.

### Signed checkout & inventory
- [ ] **GQ15 — Schema immutable paid/gift order segments và acknowledgement** _(deps: GQ01, GQ11, GQ08; gate: POS+MIGRATION)_
  - [ ] Snapshot có per-line quantity, integer unit/line VND, `lineId`, role/variant và signed consent facts; immutable finalized.
  - [ ] Legacy orders vẫn đọc được, không backfill giả campaign; migration additive có rollback strategy.
  - [ ] EX-17/18 không mất hai paid segments khác giá và số quà chưa nhận.
  - [ ] **Evidence:** `pnpm prisma:validate` ; focused snapshot schema tests ; migration review
- [ ] **GQ16 — Signed quote proof theo lineId/role và consent quà** _(deps: GQ14, GQ15; gate: SECURITY)_
  - [ ] EX-13/14/17: PAID+PAID và PAID+GIFT cùng variation, A→B cùng total làm proof stale.
  - [ ] Không tiết lộ cart ID/secret, reject forged/truncated/expired/oversized token, verify server recomputation only.
  - [ ] selected < entitled buộc signed explicit acknowledgement; total tiền không phải proof duy nhất.
  - [ ] **Evidence:** Focused quote/proof domain tests ; security review HMAC canonicalization
- [ ] **GQ17 — DRAFT order + reservation từ paid/gift price segments** _(deps: GQ15, GQ16, GQ01; gate: CAPACITY)_
  - [ ] EX-18: 2 paid giá A+1 paid giá B giữ đúng 3 chiếc cùng variation, không double-hold; paid+gift cũng cộng đúng.
  - [ ] Kiểm tra stock/concurrency trong lock boundary hiện hữu, tính ship paid-only và lưu đúng snapshot.
  - [ ] Draft retry/unknown/cancel không tạo duplicate holds/snapshot/line prices; legacy checkout flag OFF parity.
  - [ ] **Evidence:** `pnpm test:db` focused snapshot/capacity ; `pnpm test:domain`
- [ ] **GQ18 — Submit/reprice handshake, VND-invalid và gift nonclaim** _(deps: GQ16, GQ17, GQ08; gate: SECURITY)_
  - [ ] EX-21 invalid VND runtime loại toàn tier, recompute price/gift/ship và yêu cầu buyer reconfirm.
  - [ ] Out-of-stock gift/changed category/variant/ack proof invalid phải trả quote mới, không tự đổi gift.
  - [ ] No repeat submit/hold trong SYNC_UNKNOWN, DRAFT/CONFIRMED idempotency và state gate đúng.
  - [ ] **Evidence:** `pnpm test:domain` ; focused `tests/database/guest-checkout-p9a-quote-proof.test.ts` ; `pnpm test:db`
- [ ] **GQ19 — Checkout UX xác nhận thiếu/bỏ quà và báo giá mới** _(deps: GQ18, GQ14; gate: BUYER UX)_
  - [ ] Chọn 0 quà hoặc nhận thiếu yêu cầu thao tác xác nhận mới được đặt đơn; không pre-checked.
  - [ ] Đổi quà hoặc giá mà tổng không đổi vẫn phải hiển thị quote mới và buộc xác nhận lại.
  - [ ] Tổng paid+ship và gift 0đ chính xác; keyboard/live errors/mobile UX đạt.
  - [ ] **Evidence:** `pnpm exec playwright test --config tests/a11y-runtime/playwright.config.ts checkout.spec.ts` ; manual 0/partial/all gift
- [ ] **Checkpoint D:** HMAC/snapshot/reservation/reprice/consent verified.

### POS order & reconciliation
- [ ] **GQ20 — POS create-order giữ line-level exact money** _(deps: GQ01, GQ17, GQ18; gate: R-06)_
  - [ ] Outbound mỗi segment đúng variation/qty/unit VND và total; EX-17 290.003đ, GIFT 0đ khi POS chấp nhận.
  - [ ] Fresh-base recheck so với snapshot theo `lineId`/discount provenance; mismatch làm re-quote, không viết order sai.
  - [ ] Không có supported contract/fallback thì flag relevant path OFF và không gọi POS; legacy path vẫn hoạt động.
  - [ ] **Evidence:** Focused Pancake contract/domain + DB submission tests; no live side effects in CI
- [ ] **GQ21 — POS reconciliation/recovery cùng idempotency và inventory** _(deps: GQ20, GQ17; gate: R-06)_
  - [ ] Read-back/exact-money drift → alert/reconcile chứ không silently CONFIRMED.
  - [ ] Cancelled/UNKNOWN/timeout/retry không double-order/double-gift/double-reserve; stock resource accounting đúng.
  - [ ] Operator-approved live acceptance (trước production) chứng minh mapping thực tế + cleanup an toàn.
  - [ ] **Evidence:** `pnpm test:db` ; controlled live POS check only with independent operator approval
- [ ] **Checkpoint E:** POS acceptance/reconciliation performed under operator approval.

### Downstream consumers & operations
- [ ] **GQ22 — Shipping paid-only và analytics Purchase revenue parity** _(deps: GQ17, GQ20; gate: ANALYTICS)_
  - [ ] Shipping thresholds giữ nguyên, gift units không đẩy paid quantity hoặc merchandise subtotal.
  - [ ] Purchase revenue/transaction ID reflect tiền trả thật (gift =0), không double-send event qua retry.
  - [ ] Paid+gift same variation giữ identity provenance riêng; full regression parity.
  - [ ] **Evidence:** `pnpm test:domain` ; `pnpm test:db` ; event payload inspection in test fixtures
- [ ] **GQ23 — Merchant/SEO/listing không công bố giá theo giỏ vô điều kiện** _(deps: GQ08, GQ22; gate: MERCHANT/SEO)_
  - [ ] Không quảng cáo tier cart-only như unconditional single-unit product price.
  - [ ] Merchant success cache và revision respect effective campaign mutation, no stale price across publish/disable.
  - [ ] `/sale` và existing FLASH/CLEARANCE listings truthfully reflect legacy discount status when flag OFF.
  - [ ] **Evidence:** `pnpm test:domain` ; `pnpm test:db` ; Merchant/structured-data parity review
- [ ] **GQ24 — Telemetry, kill switch, audit và rollback readiness** _(deps: GQ07, GQ18, GQ21; gate: SHIP)_
  - [ ] Có metrics counts: conflict, TIER_PRICE_INVALID, entitlement, unclaimed, quote stale, stock insufficient, POS rejected/unknown.
  - [ ] Kill switch ngăn quote mới dùng rule mới mà giữ nguyên trạng thái order cũ; audit revision traceable.
  - [ ] Không log cart UUID/token/PII/secret; alert threshold và operator owner/rollback triggers ghi rõ.
  - [ ] **Evidence:** Focused telemetry tests; feature-flag OFF/ON smoke; review runbook và alert definitions

### E2E acceptance / launch readiness
- [ ] **GQ25 — Integration acceptance, DoD và controlled rollout gate** _(deps: GQ09, GQ13, GQ19, GQ21, GQ22, GQ23, GQ24; gate: DoD/SHIP)_
  - [ ] EX-01..EX-22, AC-01..AC-12 có test/evidence links; 0 Critical/Required, no fake vendor acceptance.
  - [ ] Feature flag OFF regression và staged ON path; rollback/drift alert/PII/bounds reviewed; human go/no-go riêng.
  - [ ] CI exact head pass; lệnh lint/type/domain/DB/browser/build/release pass với môi trường thật; status ghi failures minh bạch.
  - [ ] **Evidence:** `pnpm prisma:validate && pnpm lint && pnpm typecheck && pnpm test && pnpm test:db && pnpm build && pnpm release:check` ; `pnpm exec playwright test --config tests/a11y-runtime/playwright.config.ts` ; operator-approved Pancake

## Final quality gate (not yet run)
- [ ] `pnpm prisma:validate`
- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test:domain`
- [ ] `pnpm test`
- [ ] `pnpm test:db`
- [ ] `pnpm exec playwright test --config tests/a11y-runtime/playwright.config.ts`
- [ ] `pnpm build`
- [ ] `pnpm release:check`
- [ ] Exact-head GitHub CI success and complete EX-01..EX-22 / AC-01..AC-12 evidence.
- [ ] 0 Critical / 0 Required, security/authz/PII review, feature OFF parity, migrations reversible, rollback rehearsed.
- [ ] Owner go/no-go and independent `/ship` approval; never infer these from merging a doc PR.
