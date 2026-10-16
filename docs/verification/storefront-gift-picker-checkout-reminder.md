# Gift picker and checkout reminder — implementation evidence

Implementation: [PR #175](https://github.com/nguyentuanson27-netizen/la.na_design_storefront/pull/175), following the owner-approved plan in PR #174. Baseline `8cac52754d1d65b317e7ba3a81e8272856a0712f`. The stale shipping headline assertions were fixed before PR #174 merged; all four baseline workflows passed at `43365ce`. They are not waived for this feature.

## Environment and boundaries

No production database, checkout or POS is used. Initial local browser checks used a disposable in-memory PGlite database with all repository migrations, synthetic receiving data and the existing Pancake fetch fixture. PGlite is not evidence of PostgreSQL locking semantics. Those initial checks used Node 24 and Chromium 153 as fallbacks; CI uses Node 22, PostgreSQL 16 and the pinned Playwright browser. The final browser run for that implementation blocked external requests and used intentional image fallbacks. The F1–F3 follow-up below uses PostgreSQL 16 and the pinned browser. No dependencies, schema, workflow or production POS mapping are changed.

## Verification

- RED before implementation: repair view-model test failed on absent picker data; reminder/mutation tests failed before their modules existed.
- Focused proof/action/service/reminder/mutation suites: **80 passed**. Final view-model/reminder/route/mutation selection after repair-display changes: **41 passed**. Tests assert missing proof/totals during repair while retaining the physical paid items and quantities.
- `pnpm lint`: **0 errors**, 21 existing warnings. Focused final source checks retain the existing province-request cleanup warning. `pnpm typecheck`: passed. Local production build passed before the final layout/lifecycle refinements; exact final build is verified by CI.
- [CI run 38870306637](https://github.com/nguyentuanson27-netizen/la.na_design_storefront/actions/runs/38870306637), head `b123a48`: verify passed (lint/typecheck/application tests/build); browser shard 1 **81 passed**, shards 3/4 passed. PostgreSQL runtime **938/939 passed**; the remaining test expected the old public CART_CHANGED shape. Browser shard 2 **84 passed, 1 failed** on the missing unavailable-cart heading. Both regressions are corrected in the next commit: assert the additive `giftRepairRequired` flag and retain the existing heading alongside inline repair. This run is not reported as green.
- Browser shard 1 exercised real action → proof → snapshot → confirmed sandbox order, including only-chip, partial and full gifts; it also checked one order under double click, form retention, readback-only recovery, blocked storage, reload/navigation and fresh explicit submission after quote changes.
- Local final browser verification covers correct fresh-render screenshot timing, multiple invalid rows, browser Back while the modal is open, widths 320/375/390/768/1024/1440, 200% text and Axe. The first correctly synchronized zoom check found a total-row overflow; the total now wraps when required. Final local responsive/Axe and browser-Back tests: **2 passed (2.1m)**; multiple-invalid-row check passed separately. All 12 original screenshots were generated locally; representative desktop/full and mobile/repair images were visually inspected. Publishing these images was blocked by automatic approval review because checkout screenshots may contain private data. No screenshot is included in this PR. See PR checks for the exact final-head CI outcome.

Reproduce normal CI verification with `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:db`, `pnpm build`, and `(cd tests/a11y-runtime && npx playwright test --config playwright.config.ts --workers=1)`. Use isolated test-only database/auth/POS configuration as in the CI workflow. Do not run this suite against a production database.

## Review follow-up: F1–F3

The [review comment](https://github.com/nguyentuanson27-netizen/la.na_design_storefront/pull/175#issuecomment-6212740865) at `9c96bf758e5546ba359fcfd06c54f77d3f8ee778` identified three missing branches. The follow-up keeps the existing pricing, entitlement validator, ownership, proof, acknowledgement and submit authorities.

- **F1:** upsell reports both pending and uncertain outcomes to the checkout owner. Synchronous locks are tracked independently for gifts, upsell, quote refresh and submission. The recovery button calls the existing cookie-owned `readStorefrontCartGifts` action: its service reads the paid cart, quote and gift state, and its response refreshes the whole checkout. The transition remains locked until that response installs the rendered cart/quote; failed reads retain uncertainty and never replay the add. Receiving fields and the reminder's seen state remain in memory.
- **F2:** the picker DTO projects validator issues onto the original validated selection by `lineIndex`, then uses `campaignId/variantId` to identify that row. Aggregate issues become labelled groups containing the affected choices, without marking one arbitrary member as the sole invalid gift. Missing catalog labels retain the existing fallback and explicit removal controls. A valid gift remains persisted when its invalid neighbour is removed.
- **F3:** one prioritized block reason determines both the receive button's disabled state and its visible, `aria-describedby`-linked explanation. Uncertain/pending operations take precedence; existing invalid choices, full entitlement, missing size, duplicate-product restrictions and remaining variant capacity have separate explanations. Chips remain browse-only, and an uncertain save does not announce a confirmed addition.

Before changing application code, three new model tests and all five new browser scenarios failed against the reviewed source. Browser failures demonstrated the enabled submit button after both committed and uncommitted lost adds, absent per-choice repair information, and missing accessible button descriptions. After the fix, the model suite passes **11/11**, including real-validator aggregate entitlement/duplicate/shared-stock cases. The five focused browser regressions also pass.

Current local verification uses Node 24.19.0, pnpm 11.4.0, PostgreSQL 16 with separate disposable browser and database-suite databases, and Playwright 1.62.0's pinned Chromium 151.0.7922.34. All repository migrations are applied. The existing fetch fixture handles sandbox POS/geo responses; no production orders are created.

- `pnpm lint`: passed, **0 errors / 21 existing warnings**.
- `pnpm typecheck`: passed, including after restoring Next-generated changes to tracked configuration files.
- `pnpm test`: **3,253 passed**, no failed/skipped/cancelled tests. The separately repeated model suite passes after completing the fixture's declared record fields.
- `pnpm test:db`: **939 passed**, no failed/skipped/cancelled tests (**377 seconds**) on a freshly created, separately migrated PostgreSQL database, with local auth settings and CI's `x-ci-client-ip` header. Earlier local runs are not counted as passes: the first lacked auth environment settings, and its child runner outlived an interrupted outer command, interfering with a second runner on the same database (revision assertions / SQLSTATE `40001`). The complete final run used a different fresh database with no overlapping runner; no application checks were weakened to address this setup error.
- `pnpm build`: passed. The first build exposed incomplete fields in the new test fixture; these were supplied without weakening types. The final build retains three existing dynamic-filesystem tracing warnings in `product-image-cache.ts`.
- Focused browser command from the review: **35 passed**, no retries, failures or skips (**4.3 minutes**). This includes the five new regressions, both lock directions, repair with missing proof, reminder retention, committed gift readback, explicit sandbox-order confirmation, responsive layout, text zoom and Axe checks.

The new upsell regressions count mutation requests and stored paid quantities, hold the authoritative read response to verify the lock remains closed until rendering, fail a read before recovering, exercise Enter and form submission, and assert unchanged gifts plus zero new orders/reservations before a fresh explicit submission. They do not substitute variant requoting for a whole-cart read. The mixed-validity checkout regression asserts the error next to the invalid gift, removes only that gift, and verifies the valid gift, receiving fields, note, reminder and new proof.

Automated descriptions and Axe do not establish human screen-reader output. The existing screen-reader, physical-device and image-handoff gates remain open; this follow-up does not mark the Draft ready for release.

## AC traceability

Browser references below are in `tests/a11y-runtime/checkout-benefit.spec.ts` unless noted. Tests inspect persisted selections/orders, not only copy or screenshots.

| AC | Evidence |
|---|---|
| 01–05 | Single picker and paid-list assertions; independent gift DTO even with upsell off; cart-gift-model and checkout-benefit-ui tests; cart-gift-picker.spec.ts partial/full/zero and fallback rendering. |
| 06–08 | “validation precedes one reminder”; Escape returns focus; no order/reservation before explicit submit; “dialog continuation shares the submit lock” confirms one order. |
| 09–11 | Invalid gifts retain every receiving field and note through refresh/removal; no proof means disabled submit; synchronous coordination with upsell/gifts and lost-response test. |
| 12–13 | Reload stores bounded version/key/seen metadata only; client navigation and browser Back end the visit; blocked/corrupt storage tests use memory fallback; StrictMode lifecycle covered in development browser runtime. |
| 14–15 | Existing tampered/stale/cross-cart proof and snapshot tests; “changed quote is displayed” requires fresh explicit submit; public action acknowledgement flows into confirmed sandbox order. |
| 16–17 | Initial and submit-time invalid gift repair; several invalid rows; database snapshot/selection tests for entitlement, duplicate policy, paid demand and shared stock. |
| 18–19 | One shared submit lock; double click/Enter guard; native modal inert background, named heading, Escape/focus return; uncertain writes read back instead of retrying. Human screen-reader verification remains pending. |
| 20 | Responsive test widths and text zoom; existing checkout.spec.ts mobile/desktop/sticky-side-summary/one-total regression. Physical-device verification remains pending. |
| 21–23 | Ready → unquotable repair → ready retains form and physical items; final invalid removal restores proof; cart removal/refusal/readback checks; neutral limited-choice copy from existing validation, no new entitlement engine. |
| 24 | Screenshot matrix below, taken only after a new server render is installed. |
| 25–26 | “popup → picker → chip only / receive 1 / receive 2 → payment → one explicit order”: draft does not save; count follows persisted selection; pending/uncertain disables dependent action; payment heading focus and all fields retained; no order before next explicit submit. |
| 27–28 | Cart keyboard/save/full/reduce/remove test and responsive checkout test: full slots remain browsable, warning precedes removal, status follows confirmed save, no automatic replacement/restoration; collapsed view shows count, expanded view contains useful management, final removal does not auto-close. |

## Screenshot matrix

All images contain synthetic test data and local fallback media. These are emulated browser viewports, not physical devices.

| State | Output filename at 390 / 1440 px |
|---|---|
| Unopened | `gift-layout-{width}-unopened.png` |
| Choosing, not saved | `gift-layout-{width}-choosing.png` |
| Full, management open | `gift-layout-{width}-full-open.png` |
| Full, management collapsed | `gift-layout-{width}-full-collapsed.png` |
| Limited choices | `gift-layout-{width}-limited.png` |
| Invalid gift, inline repair | `gift-layout-{width}-repair.png` |

The responsive test writes these files under `tests/a11y-runtime/test-results/` for local review. Automatic approval review blocked external publication; image handoff remains open. No workflow was changed to upload them indirectly.

## Review and remaining gates

Self-review order: correctness (single authority/state transaction, no fabricated proof); security (cookie-owned writes/readback, signed proof unchanged, cart-bound UI key is not authority, no PII persisted); architecture (one form/picker/action path, no alternate order engine); simplicity (bounded reminder model, no schema/dependency changes). Only explicit submit supplies acknowledgement for the current quote. Receiving fields are in memory; storage contains UI metadata only. The POS browser fixture preserves the approved vendor gift-price projection; storefront gift price remains zero.

Human screen-reader/status verification, physical mobile-device verification and independent PR review remain pending. Automated accessibility, screenshots and self-review do not satisfy those manual gates. The feature has not been merged or deployed; C4/C5 and release approval remain open until their complete evidence is available.

## Rollback

Revert the feature PR to baseline `8cac527`. Trigger rollback for lost form data, repeated reminder, stale proof acceptance, duplicate orders, or misleading saved-gift status. Verify legacy cart/checkout/proof and confirmed-order regressions after reverting. Preserve the order ledger and resolve uncertain POS outcomes through the existing reconciliation flow; never blind retry or delete orders. No migration or data rollback is required.
