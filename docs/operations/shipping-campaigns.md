# Shipping campaigns: rollout and operation

## Before release

1. Require typecheck/lint/domain/database/build and applicable HTTP/browser CI gates. Review the additive `20261020170000_shipping_promotion_campaigns` migration. This change does not authorize a deployment or enable a promotion.
2. Apply migrations before starting code that reads `ShippingPromotionCampaign`. No campaign is inserted or enabled by the migration. Existing accepted order totals and quote snapshots are untouched.
3. Keep the server-owned `LA_SHIPPING_FEE_VND` (default 30000). Remove `LA_FREE_SHIPPING_MIN_QUANTITY`, `LA_FREE_SHIPPING_SUBTOTAL_VND` and `LA_FREE_SHIPPING_MIN_SET_QUANTITY` from deployment configuration; the new code ignores them even before operators remove them.
4. Audit manually overridden announcement text (`LA_TOP_PROMOTION_HEADLINE`) and external ads for retired fixed-threshold claims. The automatic shipping notice is separate and follows active shipping campaigns.

## Create an offer

Open **Admin > Promotions > Shipping promotions** (`/admin/promotions/shipping`). An admin role is required for the page, searches and every write.

- Enter a name, minimum paid quantity, the campaign's own categories and/or product inclusions, and any product exclusions. Parent categories include descendants; exclusion wins. A minimum of 2 is one campaign's configuration, not a system default.
- For the proposed two-Set campaign, choose its approved Set categories/products and enter 2. Do not borrow another gift/tier campaign's scope.
- Dates are entered in Vietnam time. A blank boundary is unbounded; start is inclusive and end is exclusive. A scheduled campaign still requires explicit enabling.
- Explicitly select stacking to allow shipping alongside merchandise discounts or selected gifts. Leaving it off preserves the merchandise/gift result but does not waive shipping on an already-benefited cart. Gifts never raise the paid minimum.
- Save creates a disabled draft. Review it, then enable it from the list only when its commercial activation has been approved.

The same screen edits thresholds/scope/schedule/priority, enables and disables campaigns without a deployment. A stale browser revision is rejected rather than overwriting another administrator's changes. Active edits affect new quote evaluations. Multiple qualifying campaigns waive the fee once; lower numeric priority wins, then the stable ID.

No applicable campaign means the base fee, including three-item and million-VND orders. Shipping-only orders work with gift/quantity promotions disabled and do not require split-line POS price capability.

## Quote and history boundaries

Cart, checkout render/proof, draft snapshot and the last local POS-submitting claim derive shipping from server-owned paid identities and membership. A changed fee invalidates the amount the shopper acknowledged. A read failure refuses the checkout/claim rather than interpreting it as no campaign. The shipping read takes a shared shop lock; admin edits/enables/disables take its exclusive counterpart. Their lock order does not alter the existing stock hold/idempotency ownership.

Order audit keeps base fee, selected campaign ID and revision alongside accepted fee/total. These fields are scalars so later campaign edits do not rewrite history. A confirmed order is not recalculated on a retry. Disable/expiry never mutates previously committed order amounts.

Public notices are derived from active rules, rechecked on visible-page refresh/once per minute and hidden on read failure or known expiry. Checkout always makes a fresh authoritative decision, independent of this best-effort advertising refresh. No internal product scope IDs are sent by the public notice action.

## Verification and observability

Inspect `shipping_campaign_admin` categorical outcomes (`committed`, `refused`, `forbidden`, `unavailable`), checkout quote-unavailable/reconfirmation results and existing POS validation/reset telemetry. No customer names, phones, cookies or secrets should be logged for this feature.

Verify in a non-production environment: no campaign, stale legacy env, 2 paid units, 1 paid + gift, mixed-category scope, exclusion, future/start/end dates, threshold edits, stacking, campaign read failure, failed proof, concurrent admin edit, expiry immediately before outbound submission and confirmed-order retry. Check mobile/desktop admin form, anonymous access, duplicate submission and public notice lifecycle in browser CI.

## Rollback

To stop an offer, disable its campaign; base shipping remains intact. If checkout cannot read campaigns, restore the read/storage service or forward-fix the code; do not silently charge the base fee for an unknown quote.

Prefer a forward fix or a base-policy-only compatible release. Rolling back to a pre-PR198 binary reintroduces the retired built-in free-shipping rules and needs a separate business/engineering decision. Setting old thresholds to zero is NOT a safe rollback for that old binary: its old subtotal comparison may make every positive subtotal free. Keep additive tables and historical audit columns; do not drop quote history or rewrite accepted amounts as an operational shortcut.
