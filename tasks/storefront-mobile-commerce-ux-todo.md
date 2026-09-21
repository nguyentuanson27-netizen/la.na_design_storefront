# Mobile Storefront Commerce UX — Todo

- [x] Owner confirmed mobile interaction decisions in interview.
- [ ] T1 Add focused RED contract/browser tests.
- [ ] T1 Observe expected failure on current mobile behavior.
- [ ] T2 Implement mobile swipe gallery + index + lightbox + information order.
- [ ] T3 Implement dimension-aware sticky purchase bottom sheet only for currently supported product shapes, following kind → size → color; do not add color-only commerce behavior.
- [ ] T3 Use buyer-safe unavailable copy (`Lựa chọn này tạm hết`) unless authority proves a more specific statement.
- [ ] T3 Open cart only after server-confirmed add success; close/suspend sheet first, make cart focus owner, and keep sheet open on rejection.
- [ ] T3 Enforce single-modal size-guide handoff and restore sheet focus/state.
- [ ] T4 Update phone product-card typography/grid, header utilities and persistent filter drawer while preserving the 390×844 first-product fold gate.
- [ ] T5 Enlarge cart quantity touch targets and keep delete separate.
- [ ] T6 Reorder mobile checkout summary/form/totals/submit without duplicating checkout authority; pin `N = sum(line.quantity)`.
- [ ] T7 Run focused browser/domain/accessibility verification.
- [ ] T7 Run lint/typecheck/domain/test:db/build/full relevant CI.
- [ ] T7 Review correctness → security → architecture → simplicity → performance.
- [ ] T7 Check project Definition of Done before marking ready.
