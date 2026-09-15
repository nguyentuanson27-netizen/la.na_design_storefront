# Phase G — full regression and the discardability exercise

Phase G runs no feature work. Task 34 is the whole verification suite on a clean environment; Tasks
35A–D throw the presentation layer away in a temporary worktree and rebuild it from the public
contracts, to find out whether the architecture's central claim is true. What follows is what the
work turned up.

## 1. What the exercise was actually testing

Spec 04 says a brand fork rewrites `src/app/**/page.tsx`, `src/app/globals.css` and
`src/components/brand/**`, and nothing else. That is a claim with a sharp failure mode: if a redraw
has to reach into `src/commerce`, `src/routes` or `src/components/headless` even once, the seam is
in the wrong place and every future fork pays for it.

So the exercise was run as a measurement, not a demonstration. A baseline of tree hashes for every
shared directory was recorded before anything was touched, and the pass criterion was a **zero-file
diff** across all of them afterwards — not "it looked fine".

## 2. Result: the claim holds

A complete second brand was written: all 19 storefront pages, a new stylesheet with no token carried
over from brand 1, and 6 of the 9 brand components rewritten from scratch (radio-group selectors
instead of button rows, a stacked gallery instead of a thumbnail strip, a flat bordered card, an
inline cart row, monospace type on a warm ground).

| measure | result |
| --- | --- |
| presentation files changed | **26** |
| shared-layer files changed | **0** |
| `tsc --noEmit` | clean |
| `eslint .` | 0 errors, 12 pre-existing warnings |
| `test:domain` | **1629/1629** |

The shared set held to zero covers `src/commerce`, `src/routes`, `src/components/headless`,
`src/seo`, `src/db`, `src/auth`, `src/integrations`, `src/tracking`, `src/content`,
`src/operations`, `prisma`, `scripts`, `.github`, `package.json`, `pnpm-lock.yaml`, `tsconfig.json`
and `tests`.

Three brand components needed no rewrite at all, which is the right answer rather than a gap:
`guest-checkout-form.tsx` and `guest-order-tracking-form.tsx` are deliberate adapters over one
workflow each (T18/T30), and `commerce-event-reporter.tsx` is a thin mount. A brand restyles the
shared form; it does not fork the workflow.

The route shell did its job silently throughout. Promotion refresh, the commerce event, JSON-LD and
the Meta pixel events are mounted by `StorefrontRoute`, so a redrawn page cannot drop them by
forgetting — no redrawn page mentions any of them.

## 3. Findings

### 3.1 Required — shared tests regex-matched brand source (fixed)

`tests/domain/selection-gallery-seam.test.ts` used to assert the **source text** of
`src/components/brand/purchase-panel.tsx` and `src/components/brand/product-gallery.tsx`:

```ts
assert.match(source, /export function PurchasePanelView\(\{ controller \}/, …);
assert.match(source, /Omit<GalleryModelInput, "manualSelection">/);
```

Both files are designated per-brand throwaway. The redraw was semantically correct and still failed
`test:domain` twice — once for putting the destructure on its own line, once for writing
`GalleryModelInput` where the test wanted the `Omit<…>` spelling. Conforming to both was a
formatting change with no behavioural content, after which the suite was 1629/1629.

The contracts these tests defend are real and worth keeping: a panel must be able to render a
controller it does not own (or a page cannot drive panel and gallery from one selection), and the
gallery must not accept a `manualSelection` it immediately overwrites. What was wrong was the
enforcement: a text match on a file the architecture promises a brand may rewrite freely turns a
formatting choice into a test failure.

**Fixed** in response to review. The obligations moved to compiled fixtures under
`tests/fixtures/brand-seam/`, using the same type-fixture pattern as the route factory and handle
tests. The fixtures compare the props object types directly instead of assigning components to
function types: the first attempt did the latter and was vacuous because function parameters are
contravariant, so a component declaring too little can still be assignable as a function.

The compiled gallery contract checks that the full resolved gallery input is assignable to the
brand gallery props and that `manualSelection` is not accepted. The purchase-panel contract checks
that an externally owned hook controller and the full standalone hook input are accepted. A
dedicated negative fixture covers the separate panel failure mode where the view owns its own hook.
The exact formatting the old regex rejected now passes.

One assertion stays a source check and says why: "this module imports nothing from `@/commerce`" is
an absence no type can express, and it constrains where a brand imports from rather than how it
writes anything, so a redraw cannot trip it on formatting.

### 3.2 Minor — one route exports no props type

`src/routes/collections.ts` exports `CollectionsRouteData` and `loadCollectionsRoute` but no
`CollectionsRouteProps`. It is alone in this: the other **18 of 19** routes export their own props
type. Both the shipped page and the exercise's redraw had to re-declare the shape by hand, which is
a small tax on every fork and an easy place to get `searchParams` subtly wrong.

Not a blocker — the redraw worked — and deliberately left for follow-up rather than widening the
final Phase G patch.

### 3.3 Minor — the deployment template omits four `LA_*` variables

Writing the README's configuration section for T35D surfaced this. The app reads ten `LA_*`
variables; `deploy/vps/env.example` carries six — the shipping and merchant-feed values. Missing:

```
LA_TRACKING_MODE  LA_BUILD_FACEBOOK_PIXEL_ID  LA_GTM_CONTAINER_ID  LA_PROMOTION_ACTIVATION_ENABLED
```

All four have safe defaults, so nothing breaks; an operator deploying from the template simply
never learns they exist, and a fork that wants a pixel or GTM container has to find them in source.
The fix is four placeholder lines in `deploy/vps/env.example`. Not made here — Phase G does not need
configuration churn to prove discardability — and the README states the gap instead of implying the
template is complete.

### 3.4 Not a finding, recorded so it is not re-derived

`resolveGalleryModel` returns `activeImage: TrustedProductImage | null`, and the first draft of the
redrawn gallery assumed it non-null. The type caught it immediately. That is the seam working:
a nullable field that a brand must handle is exactly what belongs in the public shape.

## 4. Task 34 verification

Run on a dropped-and-remigrated database, with the environment each suite expects.

| gate | result |
| --- | --- |
| `pnpm lint` | 0 errors, 12 pre-existing warnings |
| `pnpm typecheck` | clean |
| `pnpm test` | **1754/1754** |
| `pnpm test:db` | **433/433** |
| `pnpm build` | exit 0 |
| `pnpm release:check` | `ok: true` |
| `pnpm money:audit` | exit 0 |
| `pnpm merchant:identity:audit` | exit 0 |
| `pnpm sitemap:capacity:audit` | exit 0 |

The full Playwright configuration is the remaining merge gate for T34. It is also run by the PR CI
job with the exact command from the plan. Local full-suite runs on this Linux container still expose
intermittent timeout behaviour: the two `evergreen-pages` cases fail only in the 91-spec run, while
the spec passes 6/6 alone and 10/10 when run after its immediate predecessor. Earlier CI runs have
also shown isolated 120-second timeouts in different specs, while other runs passed 91/91.

No single root cause was established, so the notes do not invent one. Final T34 closure therefore
uses the exact-head PR #9 CI result: if that full command is green, the required gate is satisfied;
if it is not, the PR remains blocked and the failing spec must be investigated from that exact run.

`release:check` needs the release environment to be complete — `PANCAKE_API_KEY`, and an
`APP_DOMAIN` matching the production domain in `project.config.json`. Two runs failed on a partial
local environment before the correctly configured run returned `ok: true`; those failures were
configuration errors, not accepted regressions.

The manual checks the plan lists — a COD order reaching Pancake, Purchase deduplication against the
Conversions API, Rich Results validation — need live credentials this environment does not have.
They are not claimed here.

## 5. Still open

- **3.2 and 3.3 above** are minor follow-ups and are deliberately not expanded into this final PR.
- **Exact-head full Playwright** must be green before T34 and the Core Kit v1 review can close.
- The carry-forwards from Phase E stand: the root layout is outside the boundary by approved
  exception (spec 04 §8.1, plan Task 36), checkout's buyer copy has no targeted language test, and
  `flash-sale-freshness.spec.ts` waits a fixed 500 ms for hydration instead of a signal.
