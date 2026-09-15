import { connection } from "next/server";

import { readAuthServerConfig } from "@/auth/config";
import { buildRenderedCheckoutQuoteFacts } from "@/commerce/checkout-quote";
import { issueRenderedQuoteProof } from "@/commerce/checkout-quote-proof";
import { getCurrentStorefrontCheckoutContext } from "@/commerce/storefront-cart-runtime";
import { buildCheckoutBeginEvent } from "@/components/analytics/cart-funnel-tracking";

import {
  buildCheckoutViewModel,
  checkoutPixelContentIds,
  type CheckoutViewModel,
} from "./checkout-model.ts";
import { sealRoute, type RouteHandle, type RoutePixelEvent } from "./core.tsx";

/** Checkout's loader: the cart being ordered, the quote over it, and the proof binding the two. */

export type CheckoutRouteProps = Readonly<Record<string, never>>;

export async function loadCheckoutRoute(): Promise<RouteHandle<CheckoutViewModel>> {
  await connection();
  const checkoutContext = await getCurrentStorefrontCheckoutContext();
  const lines = checkoutContext?.lines ?? [];

  const totals = lines.length > 0 ? buildRenderedCheckoutQuoteFacts(lines) : null;
  // Issued over exactly the facts the page renders, bound to the cart the cookie names. Submission
  // recomputes this quote server-side and refuses to create a submit-capable DRAFT unless this
  // token still describes it, so what the buyer sees is what they can be charged.
  //
  // It comes back null when those facts cannot produce a token within the verifier's envelope,
  // which a long enough mirrored external id can cause. Quoting anyway would hand the buyer a proof
  // every submission rejects as oversized, so the model treats an unprovable cart exactly as it
  // treats an unpriceable one.
  const quoteProof =
    totals && checkoutContext
      ? issueRenderedQuoteProof({
          quote: totals,
          cartId: checkoutContext.cartId,
          secret: readAuthServerConfig().secret,
        })
      : null;

  const data = buildCheckoutViewModel({ lines, totals, quoteProof });

  // Both are emitted only once the quote gate has passed, which is what establishes that every line
  // resolved, priced and had sufficient stock. Analytics never gates checkout itself: an
  // unavailable cart suppresses them and changes nothing else.
  const pixelEvents: readonly RoutePixelEvent[] =
    data.state === "ready" && totals
      ? [
          {
            name: "InitiateCheckout",
            parameters: {
              content_ids: checkoutPixelContentIds(lines),
              content_type: "product",
              currency: "VND",
              value: totals.totalVnd,
              num_items: totals.totalQuantity,
            },
          },
        ]
      : [];

  return sealRoute({
    data,
    // Checkout prices are re-resolved on every request, so nothing here is promotion-cached; the
    // shared default cadence is what the shell mounts.
    refreshAfterMs: 60_000,
    trackingEvent: data.state === "ready" ? buildCheckoutBeginEvent(lines) : null,
    structuredData: [],
    pixelEvents,
  });
}
