import {
  buildStorefrontProductImpression,
  buildStorefrontProductImpressions,
  type StorefrontImpressionProduct,
  type StorefrontProductListContext,
} from "@/commerce/storefront-impressions";
import type { StorefrontPricingRule } from "@/commerce/storefront-product";
import type { TrackingEvent } from "@/tracking/commerce-events";
import {
  buildProductListViewEvent,
  buildProductSelectEvent,
} from "@/tracking/upper-funnel-events";

import { isCommerceTrackingEnabled } from "./commerce-event-reporter";

export type ProductListTracking = Readonly<{
  /** One `view_item_list` for the whole grid, or `null` when there is nothing safe to report. */
  listEvent: TrackingEvent | null;
  /** The `select_item` each card publishes when clicked, keyed by the slug the page renders. */
  selectEventBySlug: ReadonlyMap<string, TrackingEvent>;
}>;

const EMPTY: ProductListTracking = Object.freeze({
  listEvent: null,
  selectEventBySlug: new Map(),
});

type TrackedListProduct = StorefrontImpressionProduct & Readonly<{ slug: string }>;

/**
 * Builds a rendered card grid's upper-funnel events on the server, in one pass.
 *
 * The list event and every card's select event come from the same impressions and the same pricing
 * rule the grid itself renders with, so a `select_item` always describes a card that was in the
 * `view_item_list` at the same price. Building them separately, or letting the browser assemble the
 * select payload from what it can see, is how those two drift.
 *
 * A deployment that publishes no commerce events gets empty results and ships no payload at all.
 */
export function buildProductListTracking({
  products,
  list,
  pricingRule,
  startIndex = 0,
}: Readonly<{
  products: readonly TrackedListProduct[];
  list?: StorefrontProductListContext;
  pricingRule?: StorefrontPricingRule;
  /**
   * The position of the first product in the whole list. A grid that shows page 2 onward (opened by
   * URL, or appended by infinite scroll) continues the list's numbering instead of restarting at 0.
   */
  startIndex?: number;
}>): ProductListTracking {
  if (!isCommerceTrackingEnabled()) return EMPTY;

  const listEvent = buildProductListViewEvent({
    impressions: buildStorefrontProductImpressions({ products, list, pricingRule, startIndex }),
    list,
  });

  const selectEventBySlug = new Map<string, TrackingEvent>();
  products.forEach((product, offset) => {
    const impression = buildStorefrontProductImpression({
      product,
      list,
      index: startIndex + offset,
      pricingRule,
    });
    if (impression === null) return;
    const selectEvent = buildProductSelectEvent({ impression, list });
    if (selectEvent !== null) selectEventBySlug.set(product.slug, selectEvent);
  });

  return Object.freeze({ listEvent, selectEventBySlug });
}
