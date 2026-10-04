# Storefront Virtual Try-on — Todo

- [x] Spec approved and merged (`docs/specs/storefront-virtual-try-on.md`).
- [x] T1 Policy constants and eligibility (domain tests).
- [x] T2 Request validation: likeness, age state, upload boundary (domain tests).
- [x] T3 Vertex client, config/kill switch, trusted product-image fetch (integration tests, stubbed).
- [x] T4 Service ordering, rate/concurrency limiter, observability (domain tests).
- [x] T5 `/api/try-on` endpoint and PDP wiring (integration tests).
- [x] T6 PDP dialog UI (headless hook + brand markup).
- [x] T7 Playwright coverage at phone and desktop widths, axe clean, no console errors.
- [x] T8 Lint, typecheck, domain/integration tests, production build, self-review, simplification pass.
- [ ] **Human gate:** read the official Google REST/model pages (blocked in the build sandbox) and confirm
  the enum spellings and "no prompt" noted in the integration doc.
- [ ] **Human gate:** live non-production Vertex smoke test per category: latency, cost, quality.
- [ ] **Human gate (launch criterion):** consented 13–17 test image with guardian permission — result
  age-appropriate and non-sexualised.
- [ ] **Human gate:** deliver the service-account credential to the VPS and mount it; approve the final
  Vietnamese privacy copy; re-check `virtual-try-on-001` lifecycle (retires 2027-03-15).
- [ ] Limited production enablement (`LA_TRY_ON_ENABLED=true`), then monitor.

Note: the repository has no `05_SHARED_REFERENCES.md`; the Definition of Done used is the spec's §22
acceptance criteria plus the command gates in the spec's §17.
