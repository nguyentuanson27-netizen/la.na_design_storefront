# ADR 0011 — Merchant + structured-data availability semantics

- Status: **Accepted.** The owner accepted this mapping as the Checkpoint B G1 gate on
  2026-09-17 (`docs/specs/la-na-design-owner-approved-facts-and-decisions.md` › Settled
  decisions). The acceptance covers the mapping, not publication of every row: I9 stays
  blocked for the internal-preorder → `backorder` row until a reviewed product-level public
  availability date authority exists.
- Date: 2026-09-16
- Scope: G1 only. No Merchant/JSON-LD implementation change is made by this ADR.

## Context

La.na has three internal selling modes: `standard`, `oversell`, and `preorder`. Internal `preorder` means an **already released** product remains orderable after normal stock reaches zero, subject to a negative limit. That is not Google's meaning of `preorder`.

Current code only publishes `in_stock | out_of_stock` from `merchant-offer-mapper.ts` and `IN_STOCK | OUT_OF_STOCK` from `storefront-product-structured-data.ts`. The repository has no website-owned product-level public availability date in `ProductContent`, `ProductMerchantFacts`, `ProductMirror`, or related catalog persistence.

The business preparation rule (`+15 calendar days after successful system order confirmation`) is an order-specific shopper ETA. It begins only after a particular order is confirmed, so it cannot truthfully serve as a feed item's product-level availability date.

## Official-source evidence

Reviewed 2026-09-16. Normative conclusions use official sources only.

1. Google Merchant Center Help — **Availability [availability]**  
   https://support.google.com/merchants/answer/6324448?hl=en  
   Google defines `in_stock` as accepting orders and able to fulfill/ship in a timely manner; `out_of_stock` as not accepting orders or unavailable; `preorder` as an unreleased product; and `backorder` as an existing product unavailable now but still accepting orders. `preorder` and `backorder` require `availability_date`, and availability must stay consistent with landing page, checkout, and structured data.
2. Google Merchant Center Help — **Availability date [availability_date]**  
   https://support.google.com/merchants/answer/6324470?hl=en  
   `availability_date` is required for `preorder` and `backorder`, may be exact or estimated, is limited to a date up to one year in the future, describes when the product will be available/shipped, and must be visible on the landing page.
3. Google Search Central — **Product snippet (`Product`, `Review`, `Offer`) structured data**  
   https://developers.google.com/search/docs/appearance/structured-data/product-snippet  
   `Offer.availability` supports schema.org `InStock`, `OutOfStock`, `BackOrder`, `PreOrder`, and related `ItemAvailability` values.
4. Google Search Central — **Merchant listing (`Product`, `Offer`) structured data**  
   https://developers.google.com/search/docs/appearance/structured-data/merchant-listing  
   Merchant-listing markup uses the same `Offer.availability` vocabulary.
5. schema.org — **ItemAvailability**  
   https://schema.org/ItemAvailability  
   Canonical vocabulary includes `InStock`, `OutOfStock`, `BackOrder`, and `PreOrder`.

### Semantic mismatch

Google explicitly reserves `preorder` for products not yet released. La.na's internal `preorder` is a released product that may remain purchasable after ready stock is exhausted. When ready stock is exhausted but orders remain accepted, Google's matching external term is `backorder`, not `preorder`.

## Decision

Availability is projected from **shopper sellability**, not from the literal internal mode name. The negative limit is exclusive while there is remaining capacity and becomes unavailable exactly at the limit.

| Internal state | Shopper-facing state | Merchant | Structured data | Date source | Status |
|---|---|---|---|---|---|
| `standard`, stock > 0 | ready / purchasable | `in_stock` | `InStock` | none | allowed |
| `standard`, stock <= 0 | unavailable | `out_of_stock` | `OutOfStock` | none | allowed |
| `oversell`, stock > negative limit and purchasable | purchasable under oversell policy | `in_stock` | `InStock` | none | allowed, provided storefront/checkout can truthfully fulfill in a timely manner |
| `oversell`, exact negative limit | unavailable | `out_of_stock` | `OutOfStock` | none | allowed |
| internal `preorder`, stock > 0 | ready / purchasable | `in_stock` | `InStock` | none | allowed; no external preorder label |
| internal `preorder`, stock <= 0 but > negative limit | released product accepted while not ready-stocked | `backorder` | `BackOrder` | reviewed public **product-level** availability date | **blocked until that authority exists** |
| internal `preorder`, exact negative limit | unavailable | `out_of_stock` | `OutOfStock` | none | allowed |

### Oversell rationale

External `in_stock` is not a statement that an internal integer warehouse quantity is positive. Google's contract is that the merchant is accepting orders and can fulfill the purchase in a timely manner. Therefore a La.na oversell state that remains genuinely purchasable and fulfillable may be projected as `in_stock`. If future fulfillment evidence shows that this promise is untrue, I9 must fail closed rather than relabel it optimistically.

## `availability_date` authority

**No valid product-level authority exists in the current repository.** Campaign dates, order timestamps, customer/order state, and the `+15 days after successful system order confirmation` rule are not product availability facts.

Accordingly:

- do not derive `today + 15`;
- do not derive `order confirmation + 15` for a feed item;
- do not use promotion/campaign expiry;
- do not overload `ProductMerchantFacts`, order/customer state, or mirrored Pancake fields;
- do not continuously move a public product date merely because the feed is regenerated.

Merchant publication of the internal-preorder/zero-stock state is **BLOCKED** until the business supplies and Checkpoint B reviews a website-owned, product-level public date authority that can also be shown on the landing page. This ADR deliberately does not invent the persistence field for that future authority.

A mixed ready + preorder cart also cannot define a product-level public date. Its ETA depends on the actual order composition and confirmation event; Merchant's `availability_date` belongs to the product offer before any such order exists.

## Structured-data parity

I9 must implement one shared availability projection consumed by both Merchant output and product JSON-LD. A consumer must not independently translate internal selling-mode names. The projection should either return a supported paired Merchant/schema state or a bounded blocked/unresolved result.

For the blocked backorder row above, the feed must not fabricate `availability_date`, and JSON-LD must not independently advertise a contradictory state. Implementation should fail closed until the same public product-level authority can support the landing page, feed, and structured-data representation.

## Rejected alternatives

- **Map internal `preorder` to Google `preorder`.** Rejected: the product is already released.
- **Use `out_of_stock` while checkout still accepts the item.** Rejected: contradicts the landing page/checkout.
- **Use an order ETA as `availability_date`.** Rejected: order-specific and unavailable at feed time.
- **Use a moving `today + 15` date.** Rejected: creates a synthetic product fact and continuously changes it.
- **Put the date in `ProductMerchantFacts` now.** Rejected: no owner-approved product-level date exists, and this G1 wave must not invent schema.

## Consequences for I9

I9 will need to extend the current two-value Merchant and structured-data availability contracts to include a backorder state only after the date authority is approved. Both output paths must consume the same availability decision. Missing/invalid date authority is an explicit blocked result, not a fallback date.

No migration, feed write, Merchant API call, or JSON-LD code change is part of G1.