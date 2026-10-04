# Storefront Virtual Try-on — Plan

Contract: [`docs/specs/storefront-virtual-try-on.md`](../docs/specs/storefront-virtual-try-on.md).
Operations: [`docs/integrations/vertex-virtual-try-on.md`](../docs/integrations/vertex-virtual-try-on.md).

Dependency order (each slice was written test-first and left green):

1. **Policy + eligibility** — shared constants; eligibility composed from the category taxonomy and the
   trusted-media authority (`aoDai`/`setDo`/`vayDam`, exact first image JPEG/PNG).
2. **Request validation** — likeness, age state, exactly one JPEG/PNG ≤ 7 MB with signature check; a
   client product URL has no field to travel in.
3. **Vertex boundary** — config/kill switch, request builder pinned by test, response validation,
   safety fail-closed, no retry; trusted product-image fetch (redirect-safe, bounded).
4. **Service + limiter + telemetry** — the one ordering of gates; the owner-approved quotas (guest 1/min
   and 5 in total then login; member 2/min and 10/day), an upload concurrency cap and a generation cap
   (resource bounds); allow-listed signals. Guest-vs-login and the quota values were decided by the
   owner on 2026-10-04 (spec §21).
5. **Endpoint + PDP wiring** — same-origin, bounded body, status mapping; server-decided PDP prop.
6. **UI** — headless `useTryOn` + brand dialog (existing token set, native `<dialog>`).
7. **Browser coverage** — `tests/a11y-runtime/try-on.spec.ts` with a hermetic outbound fixture.
8. **Verify, review, simplify, docs, PR.**

Out of scope (spec §23): history/storage, queues, WebP conversion, provider framework, age
verification/geolocation, consent ledger, admin UI, model fallback, multiple outputs.
