# Facebook Live product-level XML feed

> **Superseded in part by PR #125 (owner decision, 2026-10-09):** `/feeds/google-merchant` and
> `/feeds/google-merchant.xml` now also serve one parent-level item per Pancake product
> (`merchant-parent-feed.ts`), so the per-size Google feed is no longer "untouched" and the Google
> items carry no `g:size`, `g:color` or `g:item_group_id`. Price and availability on parent items come
> from the same orderable offers (`representative-offers.ts`), and the unselected product page now quotes that
> same set, so the `Từ` floor no longer includes a sold-out size (not the cross-size floor described below). Meta Live remains a
> separate catalog.

## Objective
Commerce Manager's live-product picker should show **one catalog item per original Pancake product**, not one item per size. This is a separate opt-in catalog source at `GET /feeds/facebook-live.xml`; the existing `/feeds/google-merchant` remains untouched.

## Contract
- Source only trusted, published, validated standalone storefront offers from the existing Merchant repository/mapper (including effective promotion price, availability and trusted image URLs). Never fetch Pancake, trust request headers as storefront origin, or invent stock/prices.
- Collapse by stable `Pancake product ID` (`itemGroupId`). Emit **one** RSS `<item>` with `g:id = product ID`, product-level title/description, a canonical `/shop/<slug>` link **without a `variant` query**, a trusted image, price in the approved currency, and Meta availability.
- Availability, representative image and copy come from the strongest availability class (in stock, then backorder, then out of stock; stable variant-ID tie-break). At least one live in-stock variant => `in stock`; else at least one backorder => `available for order`; else `out of stock`. No claim of exact aggregate inventory/quantity.
- `g:price` is the **minimum promotion-aware price across every validated size**, sold-out and backorder sizes included. This is the same floor the unselected (no `?variant`) PDP shows as "Từ <price>" (`getStorefrontResolvedPriceRange`), so the feed and the page its link opens agree. Example: S in stock 899,000 + L sold out 849,000 => feed 849,000, PDP "Từ 849.000đ". Checkout pricing is untouched.
- **Complete products only.** The unselected PDP floors the price across every priced size, but Merchant emits only validated sizes. If the mapper excluded *any* size of a product (missing MPN, media, duplicate identity, composite, ...), the whole parent is withheld from this feed rather than summarised from the surviving offers. The per-size Google feed is unchanged.
- Do **not** emit variation-level `g:size`, `g:color`, `g:mpn`, or `g:item_group_id` on a synthetic parent item. No fake `Freesize` or option-specific deep link. Buyers choose real sizes on the website.
- Fail closed for ambiguous/invalid group identities, inconsistent group metadata/landing paths, unsupported Meta availability states or unsafe XML text. Deterministic order independent of source ordering. Bound raw inputs to the existing 7,000 candidate-variant ceiling, bound **emitted parent items** (not source variants) to 5,000, and bound UTF-8 XML output to the existing 16 MiB Merchant ceiling.
- The endpoint is read-only, public, `no-store` at the HTTP boundary and cached only via a dedicated per-process single-flight coordinator with the same pricing-revision/transition invalidation as the Merchant feed. No request query/header changes the trusted origin or cache domain.
- The separate Meta catalog must be created/selected in Commerce Manager; **do not** mix the existing per-variant Google feed into the Live catalog. Changing the XML URL alone will not delete items imported from another feed.
- This catalog is for livestream product selection/link-out, **not** a drop-in replacement for SKU-level Google Shopping, inventory operations or variant-level Meta DPA/CAPI `content_ids`. Meta import eligibility and business-side display are a separate human verification gate; no Meta account is modified by this PR.

## Acceptance / tests
1. Product SD1701 with three size offers produces exactly one parent `<item>`; another product remains independent.
2. The parent URL has no size selection; variant IDs do not appear as catalog item IDs; Meta availability/price (cross-size floor) are deterministic across permutations and stock states.
3. Duplicate/conflicting product IDs/links fail closed rather than merging unrelated products.
4. XML escaping/invalid code points/byte and item budgets are tested: 5,100 size variants collapsing to 1,700 parents succeed, while more than 7,000 source variants or more than 5,000 parent items are rejected. Existing Google serialization is unchanged.
5. New route returns a complete RSS response through the Next production server in CI; query noise has no effect; `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` and existing runtime gates pass.

## Plan
1. Write product-collapse and RSS contract tests (RED).
2. Implement pure deterministic collapse/serialization using the shared XML security/byte-budget primitives (GREEN).
3. Add independent read-only service and Next route; extend existing Merchant runtime HTTP smoke.
4. Verify exact-head CI, review security and release notes, open PR as draft if any gate is unresolved.

## Non-goals
- No modification to product mirrors, size stock, price rules, Google Merchant feed URL, Pixel/CAPI IDs, Meta Commerce Manager settings, DB schema or live Meta/Pancake API writes.
- No fake apparel size, invented parent MPN, or automatic migration/deletion of old catalog records.

## Verification & rollout
- After merge/deploy, inspect the XML and add its URL as the **only source** in a dedicated Live catalog. Confirm real import results, product click-through, images, availability and Meta's apparel eligibility before using in livestreams.
- Keep SKU feed/Meta ads in their existing catalog. Verify dynamic-ad event ID matching separately if reusing the Live catalog for ads.
