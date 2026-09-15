import { readCanonicalPurchaseSnapshotSafely } from "@/commerce/canonical-purchase-snapshot";
import { buildMetaPurchasePixelParameters } from "@/commerce/meta-pixel-parameters";
import { readMetaPurchaseSnapshot } from "@/commerce/meta-purchase-snapshot";
import { prisma } from "@/db/prisma";

import {
  buildCheckoutSuccessViewModel,
  parseOrderCode,
  type CheckoutSuccessViewModel,
} from "./checkout-success-model.ts";
import { sealRoute, type RouteHandle, type RoutePixelEvent } from "./core.tsx";

/** The order confirmation's loader: the order's state, and the Purchase this page reports once. */

export type CheckoutSuccessRouteProps = Readonly<{
  searchParams: Promise<{ order?: string | string[] }>;
}>;

export async function loadCheckoutSuccessRoute({
  searchParams,
}: CheckoutSuccessRouteProps): Promise<RouteHandle<CheckoutSuccessViewModel>> {
  const orderCode = parseOrderCode((await searchParams).order);
  const order = orderCode
    ? await prisma.orderMirror.findUnique({
        where: { publicCode: orderCode },
        select: { state: true },
      })
    : null;

  const data = buildCheckoutSuccessViewModel({
    orderCode,
    confirmed: order?.state === "CONFIRMED",
  });

  // Vendor-neutral canonical Purchase, built from immutable finalized order facts (T7).
  const canonicalPurchase =
    data.confirmed && data.orderCode
      ? await readCanonicalPurchaseSnapshotSafely(prisma, data.orderCode)
      : null;

  // The Conversions API reports this same sale from the server action that placed it. Both carry
  // the order code as the event id, so Meta collapses them into a single Purchase.
  let pixelEvents: readonly RoutePixelEvent[] = [];
  if (data.confirmed && data.orderCode) {
    try {
      const purchase = await readMetaPurchaseSnapshot(prisma, data.orderCode);
      if (purchase) {
        pixelEvents = [
          {
            name: "Purchase",
            eventId: data.orderCode,
            once: true,
            parameters: buildMetaPurchasePixelParameters(purchase),
          },
        ];
      }
    } catch {
      // Tracking failures must never affect checkout success.
    }
  }

  return sealRoute({
    data,
    // Nothing on this page is promotion-priced -- the order is already placed -- but the shell's
    // cadence is unconditional, so the shared default is what it gets.
    refreshAfterMs: 60_000,
    trackingEvent: canonicalPurchase ? canonicalPurchase.event : null,
    structuredData: [],
    pixelEvents,
  });
}
