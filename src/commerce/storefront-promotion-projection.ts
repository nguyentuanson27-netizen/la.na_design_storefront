/**
 * The shared promotional pricing rule.
 *
 * This is the seam where the storefront prices through the central authority. It computes
 * nothing itself: it hands each variant's mirrored base price and its applicable campaigns to
 * `resolvePromotionPricing` and passes the answer back. A second formula here — even a "simple"
 * percentage — is exactly the divergence the central resolver exists to prevent.
 *
 * Two deliberate consequences.
 *
 * The base price is `pancakeRetailPrice` alone. The equality gate on
 * `pancakeRetailPriceAfterDiscount` is not applied, because W3's accepted real-catalog evidence
 * established that Pancake evaluates promotions as dynamic order rules rather than catalog price
 * mutations, so a differing after-discount field says nothing about what the website should charge.
 * A variant that gate used to hide is now priceable and purchasable here.
 *
 * That removal is scoped to callers that opt in by passing this rule. It began as the product
 * page's rule alone; the price-bearing storefront has since converged on it, so today the opted-in
 * callers are the catalog listings/cards (`storefront-catalog.ts`), the product detail page
 * (`storefront-product-detail.ts`), the cart and checkout render (`storefront-cart-repository.ts`)
 * and the guest order snapshot (`guest-checkout-snapshot.ts`) — one rule object, so those surfaces
 * cannot quote different money for the same variant at the same instant.
 *
 * `resolveStorefrontPrice` still owns the two consumers that have not converged: the Merchant
 * identity audit (`merchant-identity-audit.ts`) and the `livePrice` comparison in the outbound
 * Pancake submission (`pancake-order-submit.ts`), whose convergence is P10's to make. Add a caller
 * to the list above rather than reimplementing this projection next to it.
 *
 * `now` is supplied by the caller so one request resolves every option against a single instant.
 */

import {
  resolvePromotionPricing,
  type ApplicablePromotionCampaign,
  type PromotionCampaignKind,
  type PromotionPricingResult,
} from "./promotion-pricing.ts";
import type { StorefrontPricingRule } from "./storefront-product.ts";

export function buildPromotionalStorefrontPricing({
  campaignsByVariantId,
  now,
  onResolved,
  onlyKind,
}: Readonly<{
  /** Keyed by internal `VariantMirror.id`, which is how the candidate repository reports them. */
  campaignsByVariantId: ReadonlyMap<string, readonly ApplicablePromotionCampaign[]>;
  now: Date;
  /**
   * Observes the full resolver answer for each variant this rule prices.
   *
   * The rule itself only surfaces the three fields a storefront option needs, but the order
   * snapshot must also persist *which* campaign produced the price. Handing that consumer the
   * result it already computed here is what keeps a second copy of this projection — and therefore
   * a second chance to disagree about money — from existing.
   *
   * The contract is narrow and worth stating exactly: the callback receives the resolved result and
   * cannot influence it, because the value this rule returns is already decided by
   * `resolvePromotionPricing` before the callback runs. It is not isolated from the call, though —
   * a callback that throws propagates and the rule does not return at all. That is deliberate: an
   * observer that cannot record what it was handed means the consumer's audit would be silently
   * incomplete, and failing loudly at the pricing call is better than persisting a DRAFT whose
   * promotion audit quietly went missing. Keep implementations total.
   */
  onResolved?: (variantId: string, pricing: PromotionPricingResult) => void;
  /**
   * Show only discounts that come from this campaign kind; any other discount is shown at base.
   *
   * For a listing scoped to one kind (`/sale/uu-dai` lists Promotion only), so a variant priced by a
   * Flash Sale cannot put the Flash price on that listing's card or its tracking. It filters the
   * resolved answer rather than the campaign list on purpose: dropping a campaign before resolving
   * could turn a `PROMOTION_CONFLICT` into a discount the cart would never honour. `onResolved`
   * still observes the unscoped answer.
   */
  onlyKind?: PromotionCampaignKind;
}>): StorefrontPricingRule {
  return (variant) => {
    const pricing = resolvePromotionPricing({
      basePriceVnd: variant.retailPrice,
      campaigns: campaignsByVariantId.get(variant.id) ?? [],
      now,
    });
    onResolved?.(variant.id, pricing);

    if (onlyKind !== undefined && pricing.isDiscounted && pricing.promotion?.kind !== onlyKind) {
      return Object.freeze({
        price: pricing.basePriceVnd,
        basePriceVnd: pricing.basePriceVnd,
        isDiscounted: false,
      });
    }

    return Object.freeze({
      // `effectivePriceVnd` is base when nothing applies and stays null when the base itself is
      // unusable, so this one field covers promoted, unpromoted and unpriceable alike.
      price: pricing.effectivePriceVnd,
      basePriceVnd: pricing.basePriceVnd,
      isDiscounted: pricing.isDiscounted,
    });
  };
}
