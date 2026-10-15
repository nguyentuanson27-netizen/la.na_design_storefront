# Smart Promotion Upsell v1 — implementation checklist

**Status:** Implementation complete on the feature branch under the owner’s end-to-end request. Verification evidence and outstanding release gates are tracked below; the original docs PR itself remains historical planning evidence.
**Plan:** [smart-promotion-upsell-v1-plan.md](./smart-promotion-upsell-v1-plan.md) · **Spec:** [SPEC-UPS-001 v1.6](../docs/specs/smart-promotion-upsell-v1.md) · **Source:** `main@17d34e0`.
**Scope:** U-03 bounded candidate read, U-05 safe +1; then minimal checkout UX. Only check items after real execution/evidence.

## UP-00 — Technical evidence + stop rule (blocks write)
- [x] Read exact implementation HEAD and confirm current checkout quote-proof, cart lock, gift authority, POS gate semantics.
- [x] Test quote freshness, two-tab/double-click/stale/A→B→A replay **và admin sửa/tắt campaign, đổi dynamic category membership đồng thời**. Kiểm thứ tự cart → campaign → membership/product locks, tránh deadlock; không coi HMAC proof tự chống ABA.
- [x] Dùng catalog đại diện để chọn **bounded query/full-quote caps và deadline hữu hạn** (không đặt 24/24 trước khi đo), tối đa **5 mẫu hiển thị**; test truncated pool, deterministic ranking, **timeout ẩn Upsell nhưng checkout không lỗi**.
- [x] Demonstrated the ABA gap and documented the smallest persisted paid revision, migration/backward compatibility/rollback and tests in ADR 0017. The owner explicitly requested the full build; the additive migration is staged in this PR for independent technical review, not applied to production. No nonce subsystem.

## UP-01 — Pure near policy + gate (depends UP-00)
- [x] Cả hai flags phải ON **và shop có POS line-level capability verified** trước discovery/render; nếu thiếu ⇒ không Upsell, không thêm query/side effect làm hỏng checkout hiện hành.
- [x] Quantity exactly missing 1; gift ONCE/cap and next tier real gain.
- [x] Monetary [80%,100%) using PR169 gift/tier **stage-specific** amounts, not list prices or progress UI.
- [x] Focused domain tests plus existing PR169 tier/stack regressions.

## UP-02 — Bounded read-only offers (depends UP-01)
- [x] Query fixed/dynamic/global products ngoài giỏ, cùng shop: dynamic = **category membership đã expand parent→descendant (`expandScopeCategoryKeys`) ∪ explicit INCLUDE targets**, rồi EXCLUDE; giữ batch + measured cap.
- [x] Hypothetical +1 quote/entitlement/stack preserve ALL pre-existing benefits and selected gifts; no DB write or speculative reservation.
- [x] Rank by U-01/A `totalPayableAfter-totalPayableBefore`; shipping default 30k, free >1m or ≥3 paid items, actual server policy overrides.
- [x] Tối đa 5 mẫu **đều verified cùng campaign thắng**, một winner trong pool: sort theo **total payable delta, rồi campaignId → productId → variantId** (khác discovery order); đổi variant phải re-quote, không claim rẻ nhất toàn catalog.
- [x] Unit/DB tests cover money thresholds, stack drop, stock, variant prices, shipping changes, pool truncation and quote parity. **Checkpoint.**

## UP-03 — Safe +1 action (requires UP-00 security gate and UP-02)
- [x] Trong **một transaction**, khóa Cart `FOR UPDATE` và **relevant campaign rows `FOR SHARE`** (thứ tự ổn định như gift selection); đồng bộ dynamic membership changes với `replaceCategoryMembership` bằng guard nhỏ nhất; kiểm ACTIVE/revision, current quote, rung/variant, stock và gift preservation **trước commit +1**.
- [x] Reuse quote-proof/guard; cart UUID chỉ được dùng qua **HttpOnly `la_cart` cookie** và server MAC context, không nhận từ public action fields/không lộ trong token/HTML/URL/log. Token/schema mới chỉ khi có failed test + duyệt; **nếu tạo offer token, phải có expiry + test expired token**.
- [x] Test forged/cross-cart/stale, double-click/2 tabs/A→B→A, stock, **concurrent admin revision/disable + category reassignment races**, rollback và lock order.
- [x] No order/Pancake submission; refresh quote/proof/summary; exact-head focused DB tests **pass before UI integration**.

## UP-04 — Checkout UX (depends UP-02 and UP-03)
- [x] Một Upsell widget + kind/color/size, add/skip, không thêm form/banner; theo đúng patterns Next.js thực tế ở HEAD build.
- [x] Đổi variant phải re-quote server; **delta ≤ 0 chỉ là ước tính tổng thanh toán, không gọi chiếc PAID là miễn phí**; refresh proof sau add.
- [x] Preserve entered name/phone/address and previous checkout behavior with flag OFF.
- [x] Mobile/desktop keyboard/accessibility and browser tests.

## UP-05 — New gift inline + dismissal (depends UP-04)
- [x] Reuse cart gift selection authority in checkout when Upsell creates gift; existing `/cart` picker stays unchanged.
- [x] Gift choice refreshes benefits/proof/acknowledgment; never auto-select; retain form.
- [x] Skip UI-only across same-attempt reload/requote; reset new attempt/cart/paid mutation including A→B→A; no hydration flash.
- [x] Browser tests for picker, skip, race-safe invalidation and failed Upsell not blocking COD checkout.

## UP-06 — Verification/release handoff (depends UP-01…UP-05)
- [x] TG-01…TG-12 mapped and verified by **focused** tests, not 50 duplicate E2Es; existing PR169/checkout regression intact.
- [x] Run `pnpm lint`, `pnpm typecheck`, `pnpm test:domain`, `pnpm test`, `pnpm test:db`, `pnpm build`; Prisma commands only as needed.
- [ ] Security review, exact-head CI, documented results; telemetry tối thiểu **latency/timeout, add failures/success, quote-change rejects, offer→add**, chỉ aggregate/non-PII, không lộ cart ID/token/secret; không migration/dependency ngoài phạm vi.
- [ ] Staging/POS/real migrations checked with approved environment before flag ON; rollback by Upsell flag; no deployment in /plan.

**Implementation evidence:** [smart-promotion-upsell-v1-evidence.md](./smart-promotion-upsell-v1-evidence.md). Local application, DB and browser results are recorded there. Independent review/exact-head CI and target-environment migration/POS/staging signoff remain separate; production enablement is not claimed.
