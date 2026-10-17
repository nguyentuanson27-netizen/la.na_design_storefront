# PR #176 review verification

Review: https://github.com/nguyentuanson27-netizen/la.na_design_storefront/pull/176#issuecomment-6217848340

Reviewed head: `453cb79100a3be7ffe5b49932849e2c706efda5f`. Updated with current main
`1c9f34d7` before validation. All local runs use isolated PostgreSQL test databases,
local auth fixtures and pinned Playwright Chromium; no production writes or smoke runs.

## PR176-F1 — resource-derived composite capacity

The Merchant repository loads edge quantities, component presence/shop/warehouse facts and
reservation resources in one parameterized batch. It calls `resourceHoldsCapacity` and
`deriveCompositeCapacitySnapshot`, the same authorities as the PDP, with the parent's own policy.
Parent WarehouseStock remains a verbatim mirror. Invalid resources remain withheld; verified zero
capacity publishes out_of_stock; a purchasable preorder requires its persisted availability date.
Candidate bounds and the nine-operation whole-generation budget are preserved.

`tests/database/composite-preorder-parity.test.ts` invokes the real repository, PDP and parent-feed
mapper. Cases cover both review counterexamples, negative/zero parent mirrors with available
components, multipliers, component-at-floor, unknown/committed/released/handed-off resources,
absent/cross-shop components, and stable query count with 1 versus 201 parent variants.

## PR176-F2 — policy ownership survives label merging

Merged kinds retain a variant-ID-to-capacity-policy map. Every variant uses its owning product's
policy while ambiguity detection still sees the entire merged kind. Missing policy is STANDARD.
Domain cases reverse input order, mix STANDARD/PREORDER and distinct preorder floors, preserve
individual dates and reject cross-product color/size collisions. The real PDP fixture reverses
product-name ordering, checks one merged kind, rejects the STANDARD child at zero and accepts the
PREORDER child through the real cart authority and checkout's verified PREORDER fulfillment state.

The initial regression run against the reviewed commerce implementation was RED: 11 failures among
23 tests, including the review counterexamples and merged-policy case. The fixed cases are GREEN.

## Feedback viewer CI diagnosis

Original failed job: https://github.com/nguyentuanson27-netizen/la.na_design_storefront/actions/runs/38899126454/job/116966802337

The original keyboard viewer case passed locally on both reviewed base `8cac5275` (12.1s) and
reviewed head `453cb791` (13.4s), and the complete original homepage spec passed after updating main
(8/8). This does not prove the historical CI failure's exact cause.

A controlled event-order regression independently reproduced a real close/reopen race: native
`dialog.close()` queues a close event, and the old onClose state write can dismiss a viewer just
reopened by Enter. The regression holds that native event until after reopening, then delivers it;
it failed before the fix at the visible-dialog assertion. Escape now prevents native cancellation
and uses the same state-driven close path as the close button. Queued close events do not perform
another state write. The final regression and original keyboard case pass at desktop and mobile
widths. Existing tests, assertions, timeouts and retry settings remain intact.

## Local validation

- `pnpm test`: 3,258/3,258 passed.
- `pnpm test:db`: 953/953 passed, including all 14 new repository/PDP/cart/checkout cases.
- `pnpm lint`: 0 errors; 21 existing warnings. Final feedback component lint: clean.
- `pnpm typecheck`: passed, including a final run after restoring generated Next files.
- `pnpm build`: passed; 3 existing dynamic filesystem tracing warnings in product-image-cache.
- Requested browser files (`storefront-composite`, `pdp-preorder-availability`,
  `homepage-refresh-acceptance`): 12/12 passed. After simplifying the final feedback close handler,
  both affected keyboard/queued-close cases passed again (2/2); final production build passed.
- Local Node 24.19.0 and pinned pnpm 11.4.0; GitHub CI uses Node 22.
- `git diff --check`: passed. No schema, checkout authority, dependency or lockfile changes.
