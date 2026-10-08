# Pancake PDP image delivery checklist

- [x] RED: add hard-cap / width / bounded-retry domain tests (CI typecheck failed before implementation as expected).
- [x] RED: add trusted fetch/transcode integration tests.
- [x] GREEN: add explicit `sharp@0.35.4` production dependency.
- [x] GREEN: implement pure delivery policy and bounded compression schedule.
- [x] GREEN: implement trusted Pancake fetch + Sharp WebP transcode.
- [x] GREEN: bind `GET /api/product-image` on Node runtime.
- [x] GREEN: wire PDP gallery/stage through the custom loader.
- [x] VERIFY: focused tests (domain + integration + route-boundary tests).
- [x] VERIFY: `pnpm lint` (CI `verify`, green on `255cfd4`).
- [x] VERIFY: `pnpm typecheck` (CI `verify`, green on `255cfd4`).
- [x] VERIFY: `pnpm test` (CI `verify`, green on `255cfd4`).
- [x] VERIFY: `pnpm build` (CI `verify`, green on `255cfd4`).
- [x] REVIEW: correctness/security/architecture/simplicity/performance; 0 Critical / 0 Required before merge (re-review of `255cfd4`).
- [x] VERIFY: production-server smoke of `GET /api/product-image` (streamed body, `Content-Length`, mid-stream cancel) in `p18-final-qa` with a controlled Pancake upstream fixture.
- [x] VERIFY: existing browser suites (`storefront-media`, `try-on`, `variant-deep-link`) migrated to the `/api/product-image` boundary; all four `admin-a11y-runtime` shards green on `255cfd4`.
