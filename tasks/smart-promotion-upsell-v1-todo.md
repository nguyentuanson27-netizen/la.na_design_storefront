# Smart Promotion Upsell v1 — implementation checklist

**Status:** NOT STARTED — /plan review pending; **owner U-01/A, U-02/A approved**, implementation not authorized by this docs PR.
**Plan:** [smart-promotion-upsell-v1-plan.md](./smart-promotion-upsell-v1-plan.md) · **Spec:** [SPEC-UPS-001 v1.6](../docs/specs/smart-promotion-upsell-v1.md) · **Source:** `main@17d34e0`.
**Scope:** U-03 bounded candidate read, U-05 safe +1; then minimal checkout UX. Only check items after real execution/evidence.

## UP-00 — Technical evidence + stop rule (blocks write)
- [ ] Read exact implementation HEAD and confirm current checkout quote-proof, cart lock, gift authority, POS gate semantics.
- [ ] Test quote freshness, two-tab/double-click/stale/A→B→A replay **và admin sửa/tắt campaign đồng thời**. Kiểm thứ tự cart → campaign locks, tránh deadlock; không coi HMAC proof tự chống ABA.
- [ ] Dùng catalog đại diện để chọn **bounded query/full-quote caps** (không đặt 24/24 trước khi đo), tối đa **5 mẫu hiển thị**; test truncated pool, deterministic ranking và error fallback.
- [ ] If guard inadequate, propose minimal persisted cart write-revision (all paid mutation paths), migration/backward compatibility/rollback, tests and technical approval **before UP-03**. Do not build nonce/token subsystem speculatively.

## UP-01 — Pure near policy + gate (depends UP-00)
- [ ] Cả hai flags phải ON **và shop có POS line-level capability verified** trước discovery/render; nếu thiếu ⇒ không Upsell, không thêm query/side effect làm hỏng checkout hiện hành.
- [ ] Quantity exactly missing 1; gift ONCE/cap and next tier real gain.
- [ ] Monetary [80%,100%) using PR169 gift/tier **stage-specific** amounts, not list prices or progress UI.
- [ ] Focused domain tests plus existing PR169 tier/stack regressions.

## UP-02 — Bounded read-only offers (depends UP-01)
- [ ] Query fixed/dynamic/global products ngoài giỏ, cùng shop: dynamic = **category membership ∪ explicit INCLUDE targets**, rồi EXCLUDE; giữ batch + measured cap.
- [ ] Hypothetical +1 quote/entitlement/stack preserve ALL pre-existing benefits and selected gifts; no DB write or speculative reservation.
- [ ] Rank by U-01/A `totalPayableAfter-totalPayableBefore`; shipping default 30k, free >1m or ≥3 paid items, actual server policy overrides.
- [ ] Tối đa 5 mẫu, một winner trong verified pool: sort theo **total payable delta, rồi campaignId → productId → variantId** (khác discovery order); đổi variant phải re-quote, không claim rẻ nhất toàn catalog.
- [ ] Unit/DB tests cover money thresholds, stack drop, stock, variant prices, shipping changes, pool truncation and quote parity. **Checkpoint.**

## UP-03 — Safe +1 action (requires UP-00 security gate and UP-02)
- [ ] Trong **một transaction**, khóa Cart `FOR UPDATE` và **relevant campaign rows `FOR SHARE`** (thứ tự ổn định như gift selection); kiểm ACTIVE/revision, current quote, rung/variant, stock và gift preservation **trước commit +1**.
- [ ] Reuse quote-proof/guard; cart UUID chỉ được dùng qua **HttpOnly `la_cart` cookie** và server MAC context, không nhận từ public action fields/không lộ trong token/HTML/URL/log. Token/schema mới chỉ khi có failed test + duyệt.
- [ ] Test forged/cross-cart/stale, double-click/2 tabs/A→B→A, stock, **concurrent admin revision/disable race**, rollback và lock order.
- [ ] No order/Pancake submission; refresh quote/proof/summary; exact-head focused DB tests **pass before UI integration**.

## UP-04 — Checkout UX (depends UP-02 and UP-03)
- [ ] Một Upsell widget + kind/color/size, add/skip, không thêm form/banner; theo đúng patterns Next.js thực tế ở HEAD build.
- [ ] On variant change price/estimate/offer readiness from verified server quote; refresh proof after successful add.
- [ ] Preserve entered name/phone/address and previous checkout behavior with flag OFF.
- [ ] Mobile/desktop keyboard/accessibility and browser tests.

## UP-05 — New gift inline + dismissal (depends UP-04)
- [ ] Reuse cart gift selection authority in checkout when Upsell creates gift; existing `/cart` picker stays unchanged.
- [ ] Gift choice refreshes benefits/proof/acknowledgment; never auto-select; retain form.
- [ ] Skip UI-only across same-attempt reload/requote; reset new attempt/cart/paid mutation including A→B→A; no hydration flash.
- [ ] Browser tests for picker, skip, race-safe invalidation and failed Upsell not blocking COD checkout.

## UP-06 — Verification/release handoff (depends UP-01…UP-05)
- [ ] TG-01…TG-12 mapped and verified by **focused** tests, not 50 duplicate E2Es; existing PR169/checkout regression intact.
- [ ] Run `pnpm lint`, `pnpm typecheck`, `pnpm test:domain`, `pnpm test`, `pnpm test:db`, `pnpm build`; Prisma commands only as needed.
- [ ] Security review, exact-head CI, documented test results/limits; no new unintended DB migration/dependency.
- [ ] Staging/POS/real migrations checked with approved environment before flag ON; rollback by Upsell flag; no deployment in /plan.

**Not claimed by this PR:** passing application tests, browser/E2E, DB, POS, applied production migration or feature readiness. Human approves plan before build.
