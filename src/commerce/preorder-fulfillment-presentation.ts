import { FULFILLMENT } from "../brand/index.ts";
import { describePublicDeliveryEstimate } from "../content/public-brand-facts.ts";
import { PREORDER_PREPARATION_DAYS } from "./preorder-order-snapshot.ts";

/**
 * F8b — what a basket containing `Đặt trước` lines is true about, stated once for cart and checkout.
 *
 * Cart and checkout are two renderings of one basket, and master spec §30 makes claims about
 * preparation time and shipment grouping that a shopper must not see differently on the two pages.
 * So the claims are decided here, from facts that already have owners, and the pages render what
 * they are handed:
 *
 * - the 15 calendar days come from `PREORDER_PREPARATION_DAYS`, the I7 constant the confirmation
 *   snapshot counts from, so cart copy and the persisted order fact cannot drift apart;
 * - the shipping windows and their zone labels come from Brand Config's approved A5 delivery
 *   policy, not a second copy typed here — the same values `/shipping` publishes.
 *
 * Three things this deliberately does not do:
 *
 * - **No date.** §30 fixes the countdown basis at successful system confirmation, which has not
 *   happened yet while a basket is still a basket. Producing a date here would date the preparation
 *   from the wrong instant, and I7 owns the real one.
 * - **No guarantee.** Every window is carried as an estimate, because the approved delivery policy
 *   says so in as many words (`delivery.estimateCaveat`).
 * - **No oversell.** An `OVERSELL` line is an ordinary ready-stock sale that happens to sit below
 *   zero internally; only a `PREORDER` sale reaches this module, because only `isPreorderSale`
 *   feeds it.
 */

/**
 * The two availability words master spec §29/§30 fixes, exported so no surface re-types them.
 *
 * Both are required to be exact. They live beside the fulfillment truth because they are the same
 * decision seen from the shelf rather than from the order: whether this thing is ready.
 */
export const PREORDER_LABEL = "Đặt trước";
export const OUT_OF_STOCK_LABEL = "Hết hàng";

/** Master spec §30's two shipping zones, each with the approved window for that zone. */
export type PreorderShippingWindow = Readonly<{
  /** The approved zone label, e.g. the capital or everywhere else. */
  zoneLabel: string;
  /** The approved delivery window for that zone, formatted as the policy pages format it. */
  estimateText: string;
}>;

export type PreorderFulfillmentNotice = Readonly<{
  /** The exact §30 word, carried here so a page renders it without importing a constant. */
  preorderLabel: string;
  /** Master spec §30's preparation window, in calendar days. */
  preparationDays: number;
  /** When the preparation window starts counting, stated rather than implied. */
  preparationBasis: string;
  /** The two zone windows, applied after preparation. */
  shippingWindows: readonly PreorderShippingWindow[];
  /** True when the basket also holds ready-stock lines, so one shipment must be explained. */
  hasMixedReadyLines: boolean;
  /** The estimate caveat the approved policy requires alongside any window. */
  estimateCaveat: string;
}>;

export type PreorderBasketLineFacts = Readonly<{
  available: boolean;
  isPreorderSale: boolean;
}>;

/**
 * The preorder notice for a basket, or `null` when it has no preorder line to speak about.
 *
 * Only lines the shopper can actually buy count. An unavailable line is not going to be ordered, so
 * it can neither create a preparation window nor make an otherwise-preorder basket look mixed.
 */
export function buildPreorderFulfillmentNotice(
  lines: readonly PreorderBasketLineFacts[],
): PreorderFulfillmentNotice | null {
  const orderable = lines.filter((line) => line.available);
  const preorderLines = orderable.filter((line) => line.isPreorderSale);
  if (preorderLines.length === 0) return null;

  const delivery = FULFILLMENT.delivery;

  return Object.freeze({
    preorderLabel: PREORDER_LABEL,
    preparationDays: PREORDER_PREPARATION_DAYS,
    preparationBasis: "kể từ khi đơn hàng được hệ thống xác nhận thành công",
    shippingWindows: Object.freeze([
      Object.freeze({
        zoneLabel: FULFILLMENT.deliveryScopeLabels.innerCity,
        estimateText: describePublicDeliveryEstimate(delivery.estimateDays.innerCity),
      }),
      Object.freeze({
        zoneLabel: FULFILLMENT.deliveryScopeLabels.otherProvince,
        estimateText: describePublicDeliveryEstimate(delivery.estimateDays.otherProvince),
      }),
    ]),
    // §30's mixed-order rule turns on whether anything ready is being held, not on how many
    // preorder lines there are. Several preorder lines share one preparation window, because §30
    // gives the order one readiness basis rather than one per line — which is also why nothing
    // here computes a slowest-of.
    hasMixedReadyLines: orderable.some((line) => !line.isPreorderSale),
    estimateCaveat: delivery.estimateCaveat,
  });
}
