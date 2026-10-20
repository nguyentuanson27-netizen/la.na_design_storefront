# Shipping campaigns - PR 198

Status: implemented on PR198; release approval requires the verification gates below.

## Owner decision

Confirmed in the project conversation on 2026-10-20:

- Remove the permanent free-shipping rules for three paid products or a subtotal above VND 1,000,000 completely.
- Buying two Sets is a time-dependent, editable promotion, not the default shipping policy.
- Keep the existing base shipping fee (VND 30,000 by default, configured by `LA_SHIPPING_FEE_VND`).

This decision supersedes the permanent shipping-threshold behavior for new checkout quotes. Historical committed orders retain their accepted amounts.

## Acceptance contract

1. No active applicable shipping campaign means the base fee, irrespective of quantity or subtotal. Old `LA_FREE_SHIPPING_MIN_QUANTITY`, `LA_FREE_SHIPPING_SUBTOTAL_VND`, and `LA_FREE_SHIPPING_MIN_SET_QUANTITY` environment values cannot grant free shipping.
2. An administrator can create/edit/enable/disable and schedule a free-shipping campaign, choosing its own product/category scope and minimum paid quantity. No automatically active campaign is seeded.
3. Scope uses canonical category membership and the existing category hierarchy, with explicit inclusions/exclusions. It is never inferred from the first gift or quantity-tier campaign.
4. Only eligible paid quantities count. Gift lines never earn free shipping. Campaign minimums and schedules are server-owned, bounded and validated.
5. Campaign time windows are start-inclusive/end-exclusive. Disabled, future and expired campaigns do not apply.
6. Stacking with merchandise/gift promotions is explicit; free shipping cannot produce a negative shipping charge. Multiple qualifying shipping campaigns grant the shipping waiver once with a deterministic winner.
7. Cart, checkout render/proof, draft validation and POS submission use the same server-side shipping decision. Clients cannot submit their own qualifying quantity or fee.
8. Changes/expiry before order commitment require a new quote/confirmation when the amount changes. Existing accepted order history is not rewritten.
9. A lookup failure is not an empty campaign list. An uncertain checkout quote must not silently charge the base fee and commit it.
10. Public shipping campaign copy follows campaign lifecycle; there is no permanent 'two Sets' shipping headline.

## Scope and boundaries

Always: preserve ownership/auth checks, quote-proof validation, stock holds, idempotency and integer VND arithmetic; add behavioral regression tests; keep reads bounded.

Not included: merge, deployment, production database writes, activation of a campaign, changes to merchandise promotion prices or unrelated UI.

A campaign starts disabled. Its activation and real dates belong to the administrator. Schema work must be additive, leaving existing order snapshots intact.

## Implementation slices

1. Base fee and pure campaign contract: regression tests for stale environment variables, campaign lifecycle, scope, paid-only counting, stacking and failure states.
2. Persistence/admin: bounded campaign repository, additive migration, authorization and optimistic revision checks, management UI following existing admin patterns.
3. Checkout integration: authoritative context at cart/render/draft/POS boundaries; preserve quote provenance and reconfirmation semantics.
4. Public copy/config migration: remove legacy thresholds and permanent freeship copy, document deployment/rollback.
5. Verification: focused tests, existing relevant tests, typecheck/lint/build, DB/HTTP/UI checks where the runtime is available; report unavailable checks explicitly.

## Repository commands

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:domain`
- `pnpm test:db`
- `pnpm build`
- `pnpm prisma:validate`
- `pnpm prisma:generate`

Use focused `node --experimental-strip-types --test tests/domain/<file>.test.ts` while developing pure modules. Do not call a focused fixture a full application test.

## Required scenarios

- No campaign: 3 products, > VND 1 million, 2 Sets, and stale legacy env values all retain the base fee.
- Active campaign: 2 eligible paid units waive the fee; 1 paid unit plus a gift does not.
- Threshold changes from 2 to 3 without deployment.
- Disabled/future/expired campaigns, exact start/end boundaries, own category descendants and exclusions.
- Unrelated gift campaigns cannot alter shipping eligibility.
- Campaign read failure, untrusted client fee/quantity, concurrent admin edits, and quote expiry before submission.
- Cart/render/draft/Pancake parity and unchanged committed order amounts.

## Verification record

Implementation: `ShippingPromotionCampaign`, `/admin/promotions/shipping`, and the independent shipping quote resolver. Campaigns start disabled and no campaign is seeded. v1 supports dynamic category membership plus explicit product inclusions/exclusions; it does not add a second fixed-product-snapshot lifecycle.

Verified locally with Node 22.16 and PostgreSQL 16.15 in an isolated database:
- Domain suite: 3,100 pass, one pre-existing skip, zero failures.
- Typecheck: pass. ESLint: zero errors, 19 existing warnings outside the new modules.
- Prisma schema validation, generation and all migrations (including the additive shipping migration): pass.
- Shipping / benefit checkout database suites: 66 pass, including actual order persistence, proof invalidation, gift/tier stacking, POS payloads, expiry during the final address read, authorization and concurrent campaign edits.
- Updated auth / snapshot / upsell database regression suites: 29 pass.
- Clean full database rerun with the proper test environment: 991 pass, zero failures.

The first broad DB run used incomplete local auth configuration and ran alongside CPU/memory-heavy checks; its seven failures comprised missing test auth configuration, retired-contract assertions, and one timing-budget failure. The affected suites pass after supplying the test environment and updating the intentional contract changes. The clean full rerun subsequently passed all 991 cases; the first run is not represented as green.

Limitations: the first local production build was killed under parallel memory pressure. Local Chromium navigation was refused by environment policy (`ERR_BLOCKED_BY_ADMINISTRATOR`), before any UI assertion ran. Neither is claimed as successful verification. CI build and browser/runtime checks remain required before merge. Local warning suppression (`NODE_NO_WARNINGS=1`) only accommodates Node 22.16 experimental type-strip stderr in existing CLI golden-output tests.

No production database writes, campaign activation, merge or deploy were performed. See `docs/operations/shipping-campaigns.md` for rollout and rollback boundaries.
