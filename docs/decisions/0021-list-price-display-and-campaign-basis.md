# ADR 0021: Derived list prices and product percentage campaign basis

- Status: Accepted for implementation; all rollout flags default OFF
- Date: 2026-10-30
- Authority: [merged PR225 spec v6](../specs/list-price-display-v1.md)

ADR 0018 already records the voucher accepted-order architecture. This decision uses
0021 to preserve that existing authority rather than overwrite it.

The canonical list price is the smallest 49/99 thousand-VND price at least 120% of
positive safe-integer POS money. No markup ceiling is imposed. The pure list-price
module owns exact BigInt arithmetic, campaign classification and list presentation.
Only the existing sanctioned listing SQL mirror duplicates arithmetic, with database
parity checks across both bases; filtering/sorting must occur before pagination.

`LIST_PRICE_DISPLAY` adds a reference/badge without changing payable facts or
campaign membership. Representative and selected price clusters keep one variant
identity. `isDiscounted`, sale listings and Flash Sale timers retain their campaign
meaning. The truthful policy explains that the reference is derived, not a price
previously charged. The owner must review the copy before storefront rollout.

`LIST_PRICE_CAMPAIGN_BASIS` requires display ON. Product percentage campaigns use
list money, half-up to 1,000 VND. Only positive safe results below POS apply. A pure
threshold miss may warn on partial publish; unsafe list/math/zero results block.
Fixed-price campaigns, quantity/order tier arithmetic and monetary proof formats
remain unchanged. At a legacy step after an earlier tier, the list-based resolved
price acts as a ceiling, preserving explicit stack priority and preventing a later
campaign from raising money. Tiers still chain on current money, never on list.

Every paid snapshot gets its nullable list metadata from server POS facts within
the write transaction, including undiscounted and split paid segments. Gifts get
null. Quote names/options are also frozen so public gift history needs no mutable
catalog lookup. No historical row is backfilled and no list metadata enters laq2,
laq3 or benefit quote digest bytes.

All campaign creation, editing, copying and publication acquire revision before
campaign locks, then check the shared DB freeze. Disable and early-end remain
available. Freeze ownership/actor/time and successful preflight revision/time are
persisted. Release requires a fresh owned preflight, no enabled future/current
percentage campaign, basis OFF, activation disabled and operator verification of
all web/worker instances. The following basis phase adds the transactional rollback implementation and runbook.

`LIST_PRICE_ORDER_HISTORY` reads only immutable metadata after exact code/phone
verification; incomplete legacy paid references suppress whole-order savings.
Quote and legacy rows are never counted twice. The existing confirmation links to
that verified lookup; no new email transport is added.

Catalog audit runs after full sync and from the recurring inventory batch for daily
checks/retries. Outliers and invalid money emit bounded operator signals plus a
persisted summary. Failures persist retry state; neither audit nor alert errors
undo catalog/inventory commits or silently cap prices.

Merchant phase 4 remains NO-GO: there is no approved historical-price evidence or
owner GO in this task. `LIST_PRICE_MERCHANT` is reserved/default OFF. Current feed
and JSON-LD continue publishing actual payable money with no new sale-price or
strikethrough claims. Cache identity includes formula/display/basis configuration.
