# Storefront Virtual Try-on — Nano Banana Pro migration todo

- [x] Owner decision: replace `virtual-try-on-001` with Nano Banana Pro for quality.
- [x] Verify official model/API facts: `gemini-3-pro-image`, GA, Vertex `global`,
  `:generateContent`, multi-image editing, 1K/2K/4K support.
- [x] Amend provider spec and operational docs.
- [x] Replace request with two inline references + fixed server-owned fidelity prompt.
- [x] Pin one candidate, 2K PNG, `personGeneration=allow_all` and reviewed safety settings.
- [x] Retain ADC, one provider-phase timeout, no retry/fallback and bounded output validation.
- [x] Fail closed on stale regional location configuration.
- [x] Update provider tests and hermetic browser fixture.
- [ ] GitHub Actions green on the migration PR.
- [ ] Live non-production quality evaluation with consented inputs: garment fidelity, person
  preservation, artifacts, latency, cost and safety-block behavior.
- [ ] Human launch gate: consented 13–17 case with guardian permission remains age-appropriate and
  non-sexualised.
- [ ] Limited production enablement only after quality acceptance.

Note: Google does not advertise a dedicated Virtual Try-On capability for `gemini-3-pro-image`; this
uses its image-editing capability. Live quality acceptance is therefore mandatory.
