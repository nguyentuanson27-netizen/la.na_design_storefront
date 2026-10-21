# PR198 shipping promotion implementation

Contract: docs/specs/shipping-campaigns-pr198.md. No merge, deployment, production migration or campaign activation.

1. [x] Remove permanent shipping thresholds; prove stale configuration is inert.
2. [x] Add a bounded, pure shipping-campaign evaluator using the existing scope/lifecycle authorities. Paid quantities only; independent of gift campaigns and their feature gate.
3. [x] Add campaign storage and an admin-managed create/edit/enable/disable surface, with authorization and optimistic revisions. New campaigns are disabled.
4. [x] Carry one shipping decision through cart, render, proof, draft and POS revalidation. Read failure closes checkout, not a guessed charge. Preserve committed orders.
5. [x] Derive public campaign copy from active campaigns; remove obsolete environment configuration and shipping promises.
6. [ ] Focused unit/domain tests, typecheck, lint, schema validation, affected DB/HTTP/UI checks and regression review. Remove temporary workspace workflow before handoff.

Implementation choices: shipping campaigns have their own dynamic category/product scope. Shipping stacking is explicit on that campaign and never changes the merchandise/gift result. Multiple eligible shipping campaigns waive shipping once, ordered by priority then ID. Active edits increment revision and existing quote amount checks require reconfirmation on fee changes.

Threat boundaries: client forms/proofs are untrusted; campaign values are validated again in the admin service; role and shop ownership are checked for every mutation. Checkout uses server-read membership/paid quantities, never client fees or eligibility. Admin logs contain operation and categorical outcome only; no customer data, campaign names or secrets.

Verification baseline: `npm run typecheck` passed on the exact e3dc6f8 source/dependency snapshot. The complete domain run was stopped by a 90-second execution limit after 756 tests; existing failures included old fixed-shipping-threshold assertions. This is not a full baseline pass.

Verification evidence and remaining gates: docs/specs/shipping-campaigns-pr198.md. Item 6 stays open until CI build and browser/runtime checks pass.
