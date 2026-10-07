# Pancake PDP image delivery plan

Source: `docs/specs/pancake-pdp-image-delivery.md`

## Dependency graph

```text
pure delivery policy + RED tests
  -> trusted Pancake fetch/transcode adapter
     -> same-origin route
        -> PDP next/image loader wiring
           -> full verification/review
```

## Task 1 — Contract and RED tests

**Acceptance criteria**
- hard cap is exactly 3,000,000 bytes and successful results must be strictly smaller;
- responsive widths are allowlisted and malformed/cardinality-busting widths are rejected;
- compression retry policy is bounded and returns null when no attempt can satisfy the cap.

**Verification:** focused domain test.

## Task 2 — Trusted fetch + bounded Sharp transcode

**Acceptance criteria**
- only `parseTrustedProductImageUrl` sources/hops are fetched;
- source bytes/pixels/time/redirects are bounded;
- successful output is WebP below the cap; failures expose only a stable reason.

**Verification:** focused integration test plus `pnpm typecheck`.

## Task 3 — Route and PDP wiring

**Acceptance criteria**
- PDP stage/gallery use the same custom loader for all Pancake product photography;
- route accepts only allowlisted widths and trusted source URLs;
- non-PDP media contracts keep original URLs.

**Verification:** rendering assertions + `pnpm build`.

## Final gate

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, then code review with correctness -> security -> architecture -> simplicity -> performance.
