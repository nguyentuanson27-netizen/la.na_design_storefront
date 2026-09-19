# V1 + V2 final verification

Status: **V1 evidence captured; release completion remains gated by exact-head CI and V2**

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

## V2

V2 remains a separate gate after V1:

```bash
pnpm lint
pnpm typecheck
pnpm test:domain
pnpm test
pnpm test:db
pnpm build
pnpm release:check
```

No command is marked complete here until its exact result is captured.

## Security / indexing

No auth, API, secret, selling-policy, order-history authority, or indexing-enablement boundary is changed by the V1 remediation.

`SEARCH_INDEXING_ENABLED=false` remains the required release mode. Deployment and indexing enablement remain out of scope.

## Final review

Required order: correctness → security → architecture → simplicity → performance.

The PR is not release-complete until exact-head gates and V2 satisfy the repository Definition of Done.
