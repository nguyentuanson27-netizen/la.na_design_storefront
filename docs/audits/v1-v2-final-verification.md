# V1 + V2 final verification

Status: **V1 + V2 verification complete; final exact-head CI is the remaining runtime confirmation for this housekeeping commit**

Base: `main@53b227568e14a7d89809687fbab3423dd3512f20`
Performance baseline: `main@8f7b20552d7dee0df4dff8e662ce508276a65f72`

This audit is the convergence/final-verification record for V1 + V2. It does not authorize deployment or search-index enablement.

## V1 browser / accessibility acceptance

The existing buyer suite remains the deep behavioral authority for checkout, preorder/inventory, confirmation/tracking, PDP behavior, search, and the evergreen policy details.

PR #39 adds focused convergence coverage for the surfaces that were not previously exercised at both buyer viewports:

- viewports: `390x844` and `1440x900`;
- homepage;
- PLP / discovery;
- About;
- Contact;
- Shipping;
- Returns;
- Size Guide;
- policy hub.

For every route the focused V1 acceptance checks HTTP 200, a rendered main surface, horizontal overflow, Axe with the buyer tag set, keyboard focus, console/page errors, and failed HTTP responses. The PLP additionally exercises the search form and verifies the resulting query URL.

Search overlay convergence is also pinned separately on mobile + desktop: dialog open/close, initial focus, Escape, focus restoration, overflow, Axe, console and failed-response guards.

The authoritative release result remains the exact-head `CI / admin-a11y-runtime` job; this document does not substitute a historical green run for that gate.

## V1 performance comparison

Harness: `tests/a11y-runtime/v1-performance-compare.spec.ts`.

Comparable profile for baseline and current:

- exact baseline SHA: `8f7b20552d7dee0df4dff8e662ce508276a65f72`;
- same Postgres fixture and product data;
- mobile `390x844`, desktop `1440x900`;
- 100 ms latency;
- 4,000,000 bit/s download;
- 1,000,000 bit/s upload;
- CPU slowdown 4x;
- one excluded warm-up plus 3 measured samples per route/runtime;
- table values below are medians.

### Final measured result after the V1 fixes

| Viewport | Route | Baseline FCP/LCP | Current FCP/LCP | Load delta | Transfer delta | Current transfer |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| mobile | Home | 544 ms | 576 ms | +16.36% | +29.11% | 293,817 B |
| mobile | PLP | 560 ms | 588 ms | +7.45% | +13.90% | 290,205 B |
| mobile | PDP | 548 ms | 584 ms | +6.72% | +15.66% | 278,456 B |
| desktop | Home | 552 ms | 576 ms | +11.88% | +26.01% | 309,771 B |
| desktop | PLP | 556 ms | 580 ms | +7.92% | +15.32% | 306,148 B |
| desktop | PDP | 544 ms | 588 ms | +8.52% | +17.75% | 294,409 B |

CLS is unchanged at 0 for five route/viewport pairs. Desktop PLP is effectively unchanged: baseline `0.0104918`, current `0.0104610`.

No performance improvement versus the baseline is claimed. The current storefront has a larger merged feature surface and remains measurably heavier.

## Findings and fixes

### V1 finding — raw footer master logo dominated transfer

The first comparable run found the owner-approved master PNG being shipped directly at about 194 KB on representative buyer routes. The observed current-vs-baseline transfer delta was about +84% to +109%, with load roughly +36% to +44%.

Root cause: the footer rendered the 4,185 px source through a raw `<img>` even though CSS displays the logo at at most 11rem.

Minimal fix:

- retain the same approved source PNG;
- render it through Next `Image`;
- publish the actual rendered size with `sizes="176px"`;
- keep lazy loading because the footer is below the fold;
- regression-test that the rendered source is the optimizer endpoint while the approved raw source asset remains directly reachable.

### Review remediation — benchmark no longer mocks the asset being measured

The first post-fix performance harness still intercepted every `/_next/image` request, which also replaced the optimized local brand logo with the tiny JPEG fixture. That invalidated the logo portion of the after-measurement.

The harness now mocks only optimizer requests whose decoded `url` points to the controlled Pancake fixtures matching `https://content.pancake.vn/...v1-performance-*`. All other optimizer requests continue normally.

A dedicated harness regression drives the current PDP, forces the footer logo into view, and verifies:

- the local master-logo response is a real optimizer response, larger than the tiny JPEG fixture;
- the controlled Pancake product fixture still returns exactly the tiny mocked body;
- console and failed-response guards remain clean.

On the corrected benchmark, the real optimized local image appears as `/_next/image` at about 11.6 KB in the representative resource list, instead of the original raw ~194 KB source.

### V1 acceptance finding — Size Guide escaped the mobile viewport

The focused two-viewport acceptance caught the Size Guide document at 584 px wide on a 390 px viewport.

Root cause: the 560 px minimum-width table sits in a CSS Grid item. The table's intended `overflow-x-auto` wrapper could scroll, but the grid item's automatic minimum size still contributed the table's intrinsic width and expanded the document.

Minimal fix: add `min-w-0` to the per-chart grid item. The table remains 560 px minimum width and horizontally scrollable inside its own container; the document itself can now remain viewport-bounded.

### V1 acceptance finding — mobile search focus restored to body

The focused search-overlay acceptance also caught Escape closing the mobile-opened search overlay without returning focus to the hamburger trigger.

Root cause: opening search from the mobile menu closes/unmounts the clicked menu search button in the same state transition. By the time the overlay effect sampled `document.activeElement`, the browser could already have moved focus to `body`; that valid-in-DOM body node then won over the explicit trigger fallback on close.

Minimal fix: when a caller supplies an explicit `triggerRef`, the overlay records that as the restoration target before falling back to `document.activeElement`. This applies equally to desktop and mobile callers and does not special-case menu copy or fixture data.

## V2

A dedicated one-off GitHub Actions job ran the requested commands as separate fail-fast steps on `8598dea2f8dfe46e366e76602e21b63b589025a3`, using the repository's pinned Node/pnpm, PostgreSQL 16, deployed migrations, and the canonical project identity workflow.

The first run found a verification-harness defect rather than a storefront defect: the temporary workflow hard-coded a database/domain identity. `pnpm test:domain` correctly failed `project-identity-operations.test.ts`. The workflow was fixed to call `./.github/workflows/project-identity.yml` and consume its `database-name` / `production-domain` outputs; no product code changed for this finding.

The rerun passed all requested commands:

```text
pnpm lint           PASS
pnpm typecheck      PASS
pnpm test:domain    PASS
pnpm test           PASS
pnpm test:db        PASS — 529/529
pnpm build          PASS — optimized production build; 38 static-page generation slots completed
pnpm release:check  PASS
```

`release:check` ran with the canonical production domain from `project.config.json`, CI-only placeholder credentials, and `SEARCH_INDEXING_ENABLED=false`.

The one-off V2 workflow is deleted in the final housekeeping commit so this convergence PR does not add permanent CI cost.

## Security / indexing / migration readiness

- No auth, API, selling-policy, order-history authority, or production secret boundary is changed.
- PR diff scan found no private-key / GitHub token / API-key / OpenAI-style secret pattern; workflow values are explicit CI placeholders.
- PR #39 introduces no Prisma schema or migration file.
- The production fixes are additive/reversible code changes: footer image delivery, search focus restoration, and Size Guide layout/focusability can each be reverted without data migration.
- `SEARCH_INDEXING_ENABLED=false` remains fail-closed: V2 `release:check` passed with it disabled, and exact-head P18/Catalog runtime checks have continued to pass without enabling indexing.
- No deploy or indexing enablement is performed by this PR.

## Checklist convergence

Merged PR evidence used to correct stale feature boxes only:

- F7a — PR #30;
- F7b — PR #33;
- F7c — PR #35;
- F7d/F7e — PR #36;
- F9a — PR #31;
- F8c — PR #38.

No unrelated task descriptions were rewritten.

## Final review

Review order: correctness → security → architecture → simplicity → performance.

- Correctness: V1 browser/Axe and V2 command gates pass; each V1 regression has a behavior test.
- Security: no trust-boundary weakening; no secret found in diff; indexing remains disabled/fail-closed.
- Architecture: fixes reuse existing UI/Next/project-identity authorities; no new product subsystem or schema.
- Simplicity: production changes remain narrow; one-off benchmark/V2 CI is not left as permanent workflow cost.
- Performance: benchmark is corrected to measure the real local optimizer response; no unsupported improvement claim is made.

Self-review verdict: **0 Critical / 0 Required**.

The final housekeeping commit changes only checklist/audit state and removes the one-off V2 workflow. Its exact-head CI is the final runtime confirmation before the PR can be considered release-ready.
