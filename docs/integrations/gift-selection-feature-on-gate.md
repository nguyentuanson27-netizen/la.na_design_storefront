# GQ12: required before feature-on / Checkpoint C

Review reference: [PR #158, comment 4266573343](https://github.com/nguyentuanson27-netizen/la.na_design_storefront/pull/158#discussion_r4266573343), 2026-10-14.

GQ12 remains independently reviewable with the feature flag default OFF. Its current standalone
paid quote has no persisted legacy stacking consent reader; this is **not evidence of full stacking semantics**.

Before enabling `LA_GIFT_QUANTITY_PROMOTIONS_ENABLED` or passing Checkpoint C, integrate the
default `createLegacyConsentReader` wiring owned by [GQ09a / PR #155](https://github.com/nguyentuanson27-netizen/la.na_design_storefront/pull/155)
into `StorefrontCartRepository.getQuote()`, bound to its injected client (including the GQ12 transaction).
The cart read and gift mutation must use that same quote authority. Do not add an alternate price calculation.

Required database evidence through `createCartGiftSelectionService(...).get()` and `.set()` without
an injected test reader: persisted two-way Flash 10% + tier 5% consent yields 855.000đ from 1.000.000đ,
so a gift threshold of 880.000đ grants no gift. Clearing consent yields 900.000đ and the corresponding
entitlement. Reader failures must return `LOOKUP_FAILED`; gate OFF must preserve exact legacy
output and read no consent. These integration checks remain pending, not satisfied by pure engine tests.

GQ13 remains deferred. Checkout/proof/order/reservation work (GQ15–GQ18), live Pancake calls and
production enablement are outside this review fix. H1/H5 and all other feature-on gates remain open.

## GQ14: dropped-tier acknowledgement gate

[PR #159, GQ14-F3 / comment 4266695929](https://github.com/nguyentuanson27-netizen/la.na_design_storefront/pull/159#discussion_r4266695929), 2026-10-14:
the cart withholds checkout and explains `TIER_PRICE_INVALID`, even if the recomputed paid total
equals legacy (EX-21). This is presentation protection, not a checkout authority guard.
Before feature-on, GQ16–GQ18 must re-quote and guard direct `/checkout` access and submission,
reject stale proof even when totals match, and require buyer acknowledgement of changed provenance.
Those integration checks remain pending; hiding the cart CTA does not satisfy them.
