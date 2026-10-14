# GQ12: required before feature-on / Checkpoint C

Review reference: [PR #158, comment 4266573343](https://github.com/nguyentuanson27-netizen/la.na_design_storefront/pull/158#discussion_r4266573343), 2026-10-14.

GQ12 remains independently reviewable with the feature flag default OFF. After GQ09a / PR #155
merged, `StorefrontCartRepository.getQuote()` now binds the persisted `createLegacyConsentReader`
to its injected client by default; GQ12 uses the same repository within its cart transaction.
This wiring alone is **not evidence of full stacking semantics**.

## Consent integration verification (satisfied, 2026-10-14)

Evidence: `tests/database/gift-quantity-consent-integration.test.ts` 7/7 against a real PostgreSQL 16
with all migrations applied. Every case goes through `createCartGiftSelectionService(...).get()` and
`.set()`; the service has no consent-reader parameter, so the persisted `LegacyPromotionStackConsent`
rows written by `setLegacyPromotionStackConsent` / `clearLegacyPromotionStackConsent` are the only
source. Fixture: Flash 10% on 1.000.000đ, a tier 5% that names `FLASH_SALE:*` and stacks, and a gift
campaign with an 880.000đ threshold (`ORDER_SUBTOTAL`, `ALL_PAID_LINES`).

| Case | Result |
| --- | --- |
| Persisted two-way consent | `get()` quote 855.000đ, gift entitlement 0, `set()` returns `SELECTION_INVALID`, no row written |
| Consent cleared | `get()` quote 900.000đ, entitlement 1, `set()` stores the choice, validation ok |
| Consent set again after a choice | entitlement drops to 0; the stored row stays visible and invalid (never deleted or replaced); re-saving is refused; removal (`quantity 0`) still works |
| One-way (tier does not name the Flash Sale, or the legacy campaign has no consent row) | the tier steps aside, 900.000đ |
| Consent read failure | `get()` and `set()` return `LOOKUP_FAILED` with no cause in the payload; nothing written or deleted; removal still works |
| Gate OFF (unset, legacy activation only, `"1"`) | `get()` returns `{ enabled: false }`, `set()` returns `FEATURE_DISABLED`, zero SQL statements are issued (so no consent row is read), and `getQuote().lines` is byte-identical to `getLines` with no consent or gift table queried |

Mutation check: replacing the default reader in `storefront-cart-repository.ts` with an empty one
makes the persisted-consent and read-failure cases fail (4 of 7); the file was restored.

This closes the "required before feature-on" item for **consent integration only**. Every other
feature-on gate is still open: H1/H5, the default-OFF flag, GQ15–GQ18 checkout/proof/order/reservation,
live Pancake evidence and production enablement. Do not add an alternate price calculation.

## GQ13a release gates (before feature-on)

GQ13a (server write for gift campaigns, PR #161) is built separately; see the todo entry. GQ13b (gift UI),
checkout and production enablement remain outside this gate. Known gaps that must be closed or
explicitly accepted before `LA_GIFT_QUANTITY_PROMOTIONS_ENABLED` is turned on:

- **Option shop filter.** `giftOptionErrors` checks that an allowlisted variant exists, is active and
  not composite, but does not filter by `pancakeShopId`, while the cart does. A variant of another shop
  is ignored by the cart (it simply never becomes selectable), so nothing breaks, but the admin gets no
  warning. Add the filter, or accept it, with the single configured shop.
- **Combined active-campaign bound.** The candidate reader refuses more than 50 active gift *and* tier
  campaigns together (`LOOKUP_FAILED`). Gift publish is capped at 20 concurrent gift campaigns
  (`MAX_GIFT_CAMPAIGNS`), but nothing bounds gifts + tiers at 50, and tier publish (GQ09a) has no
  admission check at all. The same writer/consumer alignment is needed for the combined bound.
- **Stock at publish is advisory.** One READY option is required, not net of reservations; the cart
  decides what is selectable on every read.
- **Gift-to-gift stacking consent** has no admin write yet; two gift campaigns earning on one cart both
  step aside (fail closed).


## GQ14: dropped-tier acknowledgement gate

[PR #159, GQ14-F3 / comment 4266695929](https://github.com/nguyentuanson27-netizen/la.na_design_storefront/pull/159#discussion_r4266695929), 2026-10-14:
the cart withholds checkout and explains `TIER_PRICE_INVALID`, even if the recomputed paid total
equals legacy (EX-21). This is presentation protection, not a checkout authority guard.
Before feature-on, GQ16–GQ18 must re-quote and guard direct `/checkout` access and submission,
reject stale proof even when totals match, and require buyer acknowledgement of changed provenance.
Those integration checks remain pending; hiding the cart CTA does not satisfy them.

## GQ15 / GQ16 -- order quote snapshot and signed quote proof

Built and tested, **not yet wired**: nothing writes `OrderQuoteSnapshot` and nothing issues or verifies the `laq3` / `laa1` tokens until the checkout DRAFT step (GQ17) and the submit/reprice handshake (GQ18). Until then the buyer checkout link stays withheld for any cart that has a gift or a split-price tier segment, so the legacy checkout cannot silently lose a benefit.

Release gates this adds before the flag is turned on:

- The migration `20261014120000_add_order_quote_snapshot` is additive with a written rollback (drop four tables, one enum, three functions). Apply it, and read it, before any deploy that contains GQ17.
- An order that leaves DRAFT freezes its quote rows. Any flow that must re-quote after `VALIDATING` (none exists today) would have to create a new order, not edit the snapshot.
- The acknowledgement endpoint (GQ19) must verify the buyer's render proof for the quote being acknowledged before it issues `laa1`; the token module deliberately does not decide that.
- `vendorProjectionHash` / `vendorProjection` are empty until GQ20 writes the Pancake projection (ADR 0016 D-08); reconciliation (GQ21) compares read-back against that projection.

