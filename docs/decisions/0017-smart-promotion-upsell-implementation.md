# ADR 0017 — Checkout Upsell proof, paid revision and bounded read

Status: implementation proposed for review; production rollout is not authorized by this ADR.
Source: SPEC-UPS-001 v1.6, PR #171 plan, owner request to implement the whole plan and open a new PR.

## UP-00 evidence and smallest guard

`tests/domain/promotion-upsell-proof-gap.test.ts` demonstrates that the existing stateless COD HMAC
accepts an old proof after A→B→A. A cart row lock serializes simultaneous actions but does not record
that intervening writes occurred. Neither timestamps nor a paid-line fingerprint establishes this.

The implementation adds one `Cart.paidRevision BIGINT DEFAULT 0`. A `CartItem` trigger advances it for
insert, delete, and actual paid identity/quantity/source changes, in the same transaction. It covers
all existing primitives and direct SQL writers, including add/delete cycles that leave every original
line unchanged. Gift choices, reads, and no-op quantity writes do not advance it. Rollback rolls back
the revision too. No nonce table, new secret, queue or dependency is introduced.

The normal COD proof/verification is unchanged. The Upsell intent reuses its canonical bytes, bounded
envelope and HMAC implementation, with a distinct MAC context: server cookie cart identity, current
paid revision, target campaign revision, selected variant, issue time and hypothetical after-quote
digest. A public intent contains only campaign/variant IDs, issue time and the opaque proof. Five-minute
expiry is verified server-side, including future-time rejection. Re-quote renews only a still-valid
intent. Add independently recomputes both quotes; token bytes never supply money or eligibility.

This additive migration is included for technical/security review in the implementation PR. Only a
local disposable database was migrated during implementation; target-environment migration approval
and rollout remain separate gates.

## Atomic add and lock order

1. Lock the live cookie-owned Cart FOR UPDATE.
2. Hold PromotionPricingRevision/current FOR SHARE. Both gift/tier and legacy effective mutations
   take FOR UPDATE here first, including publication of previously inactive campaigns and consents.
   This covers activation phantoms as well as already-active campaign edits.
3. Hold the existing shop catalog advisory lock in shared mode. Catalog synchronization and selling
   policy writes already take its exclusive form. Category membership replacement now joins the
   same exclusive boundary before deleting/recreating memberships.
4. Lock sorted ProductMirror rows FOR SHARE for paid, gift, candidate and composite component
   products. Publication-only admin actions update these rows without taking the catalog guard.
   Then lock sorted VariantMirror resource rows FOR SHARE. Capacity reservation takes FOR UPDATE
   on these same variant rows. Re-read after acquiring both sets so publication changes and
   reservations committed while waiting are visible; hold both sets through commit.
5. Recompute canonical before/+1 quotes, verify intent/version/expiry, actual rung gain, existing
   per-campaign savings, gift entitlement/grantability/choices and READY aggregate component demand.
   Insert exactly one paid line. The revision trigger runs in the same commit.

No admin/catalog path acquires Cart after these locks; catalog synchronization does not acquire the
promotion revision. A lock wait or timeout rejects without a write. Tests exercise both writers that
commit before add and writers blocked through the CartItem insert/commit. No stock is reserved, no
order is created and no Pancake write is sent by this operation.

## U-03 budget and measurement boundary

Initial local fixture: 33 products, up to 3 sizes, including paid, gift, category, explicit INCLUDE
and fixed-scope cases. The test records three recommendation durations rather than claiming a
production percentile. Initial runs before the extra component guard were 449–506 ms. The final
verification result is recorded in `tasks/smart-promotion-upsell-v1-evidence.md`.

The pilot budget is 10 discovered products, at most 3 variants per product, 20 hypothetical quotes,
2 seconds per read transaction, 200 ms transaction admission and 1.8 seconds per SQL statement. A
batched lateral query allocates stable round-robin product slots across near campaigns; each scope
lookup is capped before pooling. The variant loop also visits one size per product before taking
another size. Each hypothetical quote evaluates all near campaigns once. Winner ordering is payable
delta then campaign/product/variant ID, independent of discovery allocation. Only five products from
the winning campaign are displayed. Every displayed size has its own server quote, and selection
performs a fresh read-only verification before enabling add.

This is fixture evidence, not measurement of the user's live catalog or a production latency claim.
Staging must repeat the bounded-pool/latency check on the real catalog before enabling a pilot.
Timeout or failure hides Upsell and leaves the ordinary checkout alone. Existing checkout quote
failures retain their existing fail-closed behavior.

## Checkout attempt and gift lifecycle

The shared checkout form remains mounted across Server Action refreshes. Its receiving fields stay
in React state, its proof comes from the current server render, and submission is locked throughout
Upsell/gift mutation and refresh. Separate Upsell and gift pending states are combined before
notifying the form; each locks the other's controls, and action handlers also guard pending writes.
Gift selection uses the existing cart service, hook and picker; all picker buttons explicitly use
`type=button` inside checkout.

Session storage contains an opaque HMAC paid-cart key, dismissal and newly unlocked campaign
IDs. Before add it also records the server's opaque next-revision key and current entitlement
counts. If the add response is lost, a reload matching that expected key recovers newly unlocked
campaigns from the current server gift model. A different cart/revision resets the attempt. These
UI markers grant no permission and cannot authorize a gift or paid write. Hydration hides the widget
until this state is known. Reload may restore the same attempt, quote-only refresh preserves it,
paid revision changes invalidate it
(including A→B→A), and client navigation/Activity exit ends it. New gifts from successful Upsell can
be selected inline; gifts already earned before checkout continue using the cart picker. No gift is
automatically selected. An unknown add outcome disables further adds until reload.

## Release and rollback

Both flags default OFF. Unverified shop POS capability prevents discovery as well as add. Do not enable
production until migration, real-catalog staging, POS line-level acceptance and checkout UX are signed
off. Roll back behavior by setting LA_PROMOTION_UPSELL_ENABLED=false; leave the additive column and
trigger in place for compatibility and replay safety. Do not drop the migration as an online rollback.

Aggregate `promotion_upsell` telemetry carries fixed event/outcome enums and a bounded duration only:
recommendations offered/empty/failed/timed_out, adds added/quote_changed/failed. It supports latency,
timeout, rejection and offer-to-add inspection without logging tokens, cart/customer IDs or exceptions.
