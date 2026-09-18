# ADR 0011 — Merchant + structured-data availability semantics

- Status: **Accepted, and the backorder row is now unblocked.** The owner accepted this mapping
  as the Checkpoint B G1 gate on 2026-09-17
  (`docs/specs/la-na-design-owner-approved-facts-and-decisions.md` › Settled decisions). That
  acceptance covered the mapping only, and left the internal-preorder → `backorder` row **blocked**
  for want of a date authority. On **2026-09-18** the owner supplied and approved that authority —
  an automatic **variant-level** preorder availability cycle — which supersedes the blocked state.
  See [§`availability_date` authority — approved 2026-09-18](#availability_date-authority--approved-2026-09-18).
- Date: 2026-09-16 (amended 2026-09-18)
- Scope: G1 was mapping only, and made no implementation change. I9 implements it, on the
  2026-09-18 authority.

## Context

La.na has three internal selling modes: `standard`, `oversell`, and `preorder`. Internal `preorder` means an **already released** product remains orderable after normal stock reaches zero, subject to a negative limit. That is not Google's meaning of `preorder`.

As of 2026-09-16, code published only `in_stock | out_of_stock` from `merchant-offer-mapper.ts` and `IN_STOCK | OUT_OF_STOCK` from `storefront-product-structured-data.ts`, and the repository held no website-owned public availability date in `ProductContent`, `ProductMerchantFacts`, `ProductMirror`, or related catalog persistence. Both statements describe the day this ADR was written; the 2026-09-18 amendment below changes them.

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
| internal `preorder`, stock <= 0 but > negative limit | released product accepted while not ready-stocked | `backorder` | `BackOrder` | the approved **variant-level** availability cycle (2026-09-18) | allowed while the cycle date is present and has not passed; otherwise fail closed |
| internal `preorder`, exact negative limit | unavailable | `out_of_stock` | `OutOfStock` | none | allowed |

### Oversell rationale

External `in_stock` is not a statement that an internal integer warehouse quantity is positive. Google's contract is that the merchant is accepting orders and can fulfill the purchase in a timely manner. Therefore a La.na oversell state that remains genuinely purchasable and fulfillable may be projected as `in_stock`. If future fulfillment evidence shows that this promise is untrue, I9 must fail closed rather than relabel it optimistically.

## `availability_date` authority — as assessed 2026-09-16 (historical)

This section records the state of the repository on the day the mapping was accepted, and the
reasoning that blocked the backorder row. It is kept because the *refusals* it lists are still
binding — the approved authority below satisfies them rather than repealing them.

**No valid product-level authority existed in the repository on 2026-09-16.** Campaign dates, order timestamps, customer/order state, and the `+15 days after successful system order confirmation` rule are not product availability facts.

Accordingly:

- do not derive `today + 15`;
- do not derive `order confirmation + 15` for a feed item;
- do not use promotion/campaign expiry;
- do not overload `ProductMerchantFacts`, order/customer state, or mirrored Pancake fields;
- do not continuously move a public product date merely because the feed is regenerated.

On 2026-09-16 Merchant publication of the internal-preorder/zero-stock state was therefore
**BLOCKED** until the business supplied, and Checkpoint B reviewed, a website-owned public date
authority that could also be shown on the landing page. This ADR deliberately did not invent the
persistence field for that future authority. **That condition has since been met — see the next
section.**

A mixed ready + preorder cart also cannot define a product-level public date. Its ETA depends on the actual order composition and confirmation event; Merchant's `availability_date` belongs to the product offer before any such order exists. This remains true, and is why the approved authority below is a property of a *variant*, never of an order.

## `availability_date` authority — approved 2026-09-18

The owner approved an automatic, website-owned **variant-level** availability cycle, together with
the small persistence needed to store it. It supersedes the blocked state above. Note the level:
the 2026-09-16 assessment anticipated a *product-level* authority, and the approved one is finer —
per size/variant — which is strictly more truthful, because two sizes of one product sell out on
different days and a product-level date would be wrong for at least one of them.

The approved rules, which are the authority and not an implementation's summary of it:

1. The rule applies **per size/variant**, never per product.
2. It applies only to variants whose internal selling mode is `preorder`.
3. A preorder availability cycle **starts** when any of these is observed:
   - ready stock goes from `> 0` to `<= 0`; or
   - the feature begins operating and the variant is already `preorder` with stock `<= 0` — the
     cycle starts on the first day the website observed that state; or
   - an admin turns `preorder` off and on again while stock is still `<= 0` — that is a **new**
     cycle, even though the stock never moved.
4. Cycle dates are Vietnam time, UTC+7.
5. `availability_date = cycle start date + 15 calendar days`.
6. The date is **persisted, fixed**. It is never recomputed as `today + 15` on a feed run.
7. When ready stock returns to `> 0` the cycle ends. The next `<= 0` opens a new cycle with a new
   date.
8. If the date has passed and stock is still `<= 0`, **15 more days are not added**. Publication of
   `backorder` stops for that cycle and the product page hides the date line. The variant may still
   be offered to the shopper as `Đặt trước` under the capacity policy — the storefront and the feed
   are allowed to differ there, because only the feed and the markup are making a dated public
   promise.
9. The Merchant feed and the JSON-LD consume the **same** projection and the same date.
10. On the product page the line `Dự kiến có hàng: <date>` appears only once the shopper has
    selected the preorder variant it belongs to; it never shows another variant's date, and it is
    hidden once the date has lapsed.
11. This date rule is **not** the I7 order ETA and must not be used for it.
12. I7's order ETA remains order confirmation + 15 calendar days, decided separately.
13. The owner approved the migration/persistence that stores the cycle start and date per variant.

What it does not repeal: every refusal in the historical section still stands. Nothing derives
`today + 15`, an order-confirmation date, or a campaign expiry; nothing overloads
`ProductMerchantFacts` or mirrored Pancake fields; and no historical date is backfilled by
inference — rule 3's first-observation clause applies only from the moment the feature begins
operating under this contract.

Recorded in the fact authority at
`docs/specs/la-na-design-owner-approved-facts-and-decisions.md` › Settled decisions, with
provenance.

## Structured-data parity

I9 must implement one shared availability projection consumed by both Merchant output and product JSON-LD. A consumer must not independently translate internal selling-mode names. The projection should either return a supported paired Merchant/schema state or a bounded blocked/unresolved result.

For the backorder row, the feed must not fabricate `availability_date`, and JSON-LD must not independently advertise a contradictory state. A missing, malformed or expired cycle date is a **blocked** result on both surfaces at once: the offer is withheld rather than relabelled. Relabelling it `out_of_stock` is specifically rejected, because checkout is still accepting the order and the landing page still offers it.

## Rejected alternatives

- **Map internal `preorder` to Google `preorder`.** Rejected: the product is already released.
- **Use `out_of_stock` while checkout still accepts the item.** Rejected: contradicts the landing page/checkout.
- **Use an order ETA as `availability_date`.** Rejected: order-specific and unavailable at feed time.
- **Use a moving `today + 15` date.** Rejected: creates a synthetic product fact and continuously changes it.
- **Put the date in `ProductMerchantFacts` now.** Rejected: no owner-approved product-level date exists, and this G1 wave must not invent schema.

## Consequences for I9

I9 extends the two-value Merchant and structured-data availability contracts to include the
backorder state, on the 2026-09-18 authority. Both output paths consume the same availability
decision. Missing, malformed or expired date authority is an explicit blocked result, not a
fallback date.

No migration, feed write, Merchant API call, or JSON-LD code change was part of G1; all of it
belongs to I9.