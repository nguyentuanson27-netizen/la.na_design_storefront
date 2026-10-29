import { randomUUID } from "node:crypto";
import { readBankTransferConfig } from "@/commerce/bank-transfer";
import { checkoutAttemptKey } from "@/commerce/checkout-attempt-key";
import { isPromotionUpsellEnabled } from "@/commerce/promotion-upsell-policy";
import { connection } from "next/server";

import { readAuthServerConfig } from "@/auth/config";
import { readBenefitCheckoutRender } from "@/commerce/benefit-checkout-render";
import { buildRenderedCheckoutQuoteFacts } from "@/commerce/checkout-quote";
import { issueRenderedQuoteProof } from "@/commerce/checkout-quote-proof";
import { getCurrentStorefrontCheckoutContext } from "@/commerce/storefront-cart-runtime";
import { buildCheckoutBeginEvent } from "@/components/analytics/cart-funnel-tracking";
import { loadCurrentVoucherPicker } from "@/commerce/voucher-picker-runtime";
import { readCartHeldUntilMs } from "@/commerce/voucher-own-holds";
import { canGrantHonourableVoucherHolds } from "@/commerce/voucher-gate";
import { prisma } from "@/db/prisma";
import { readPancakeShopId } from "@/integrations/pancake/config";

import {
  buildBenefitCheckoutViewModel,
  buildBenefitUnavailableCheckoutViewModel,
  buildCheckoutViewModel,
  buildCheckoutVoucherView,
  benefitCheckoutPixelParameters,
  checkoutPixelContentIds,
  type CheckoutViewModel,
} from "./checkout-model.ts";
import { sealRoute, type RouteHandle, type RoutePixelEvent } from "./core.tsx";

/** Checkout's loader: the cart being ordered, the quote over it, and the proof binding the two. */

export type CheckoutRouteProps = Readonly<Record<string, never>>;

function withCheckoutExtras(base: CheckoutViewModel): CheckoutViewModel {
  // Keep the optional feature gate stable across ready ↔ unquotable renders. An absent
  // quote proof disables fetching, not D-06 dismissal persistence within this checkout.
  // Malformed promotion config must never fail the canonical checkout render.
  let upsellEnabled = false;
  if (base.state !== "empty") {
    try {
      upsellEnabled = isPromotionUpsellEnabled(readPancakeShopId());
    } catch {
      upsellEnabled = false;
    }
  }
  return { ...base, bankTransferEnabled: readBankTransferConfig() !== null, upsellEnabled };
}

export async function loadCheckoutRoute(): Promise<RouteHandle<CheckoutViewModel>> {
  await connection();
  const quoteRenderId = randomUUID();
  const checkoutContext = await getCurrentStorefrontCheckoutContext();
  const lines = checkoutContext?.lines ?? [];

  // GQ19 -- a cart with gifts or quantity-tier segments is quoted and proven by the very derivation the
  // submit re-runs. With the gate OFF (or nothing applying) this is `LEGACY` after reading nothing but
  // the gate, and the rest of this loader is the ordinary checkout, unchanged.
  const benefitRender =
    checkoutContext && lines.length > 0
      ? await readBenefitCheckoutRender({
          client: prisma,
          cartId: checkoutContext.cartId,
          lines,
          shopId: readPancakeShopId(),
          now: new Date(),
          secret: readAuthServerConfig().secret,
        })
      : ({ kind: "LEGACY", giftPicker: undefined, shippingQuote: undefined } as const);
  // V18: what the vouchers have to say about this cart. Read-only: a held voucher is already in the render's quote, an
  // offer is the shopper's own selection previewed by the server, and nothing here can hold anything.
  const voucherView = checkoutContext && lines.length > 0
    ? buildCheckoutVoucherView({
        render: benefitRender,
        picker: await loadCurrentVoucherPicker(),
        heldUntilMs: benefitRender.kind === "BENEFIT" && benefitRender.voucher ? await readCartHeldUntilMs(prisma, checkoutContext.cartId) : null,
        // An offer is only worth showing (and blocking an order for) when the hold button can actually grant it.
        offerAllowed: canGrantHonourableVoucherHolds(readPancakeShopId()),
      })
    : null;
  if (benefitRender.kind !== "LEGACY") {
    const data =
      benefitRender.kind === "BENEFIT"
        ? buildBenefitCheckoutViewModel({ lines, render: benefitRender })
        : buildBenefitUnavailableCheckoutViewModel(benefitRender, lines);
    // The dataLayer funnel prices one unit per variation, which a split-price or gift order cannot say
    // truthfully, so a benefit checkout publishes no `begin_checkout`. Meta's InitiateCheckout is still
    // reported, with the order total and paid units the page shows and no per-item prices, so the
    // cart → checkout step stays measurable while a gift campaign runs. (The purchase itself is
    // reported from the order, money paid only -- GQ22.)
    const benefitPixel = benefitRender.kind === "BENEFIT" ? benefitCheckoutPixelParameters(data, lines) : null;
    return sealRoute({
      data: { ...withCheckoutExtras(data), quoteRenderId, giftPicker: benefitRender.giftPicker, attemptKey: checkoutContext ? checkoutAttemptKey(checkoutContext.cartId, readAuthServerConfig().secret) : undefined, ...(voucherView ? { vouchers: voucherView } : {}) },
      refreshAfterMs: 60_000,
      trackingEvent: null,
      structuredData: [],
      pixelEvents: benefitPixel ? [{ name: "InitiateCheckout", capiPath: "/checkout", parameters: benefitPixel }] : [],
    });
  }

  const totals = lines.length > 0 ? buildRenderedCheckoutQuoteFacts(lines, { shippingQuote: benefitRender.shippingQuote }) : null;
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
  const contentIds = checkoutPixelContentIds(lines);

  // Both are emitted only once the quote gate has passed, which is what establishes that every line
  // resolved, priced and had sufficient stock. Analytics never gates checkout itself: an
  // unavailable cart suppresses them and changes nothing else.
  const pixelEvents: readonly RoutePixelEvent[] =
    data.state === "ready" && totals && contentIds
      ? [
          {
            name: "InitiateCheckout",
            capiPath: "/checkout",
            parameters: {
              content_ids: contentIds,
              contents: lines.map((line, index) => ({ id: contentIds[index]!, quantity: line.quantity, item_price: line.price! })),
              content_type: "product",
              currency: "VND",
              value: totals.totalVnd,
              num_items: totals.totalQuantity,
            },
          },
        ]
      : [];

  return sealRoute({
    data: { ...withCheckoutExtras(data), quoteRenderId, giftPicker: benefitRender.giftPicker, attemptKey: checkoutContext ? checkoutAttemptKey(checkoutContext.cartId, readAuthServerConfig().secret) : undefined, ...(voucherView ? { vouchers: voucherView } : {}) },
    // Checkout prices are re-resolved on every request, so nothing here is promotion-cached; the
    // shared default cadence is what the shell mounts.
    refreshAfterMs: 60_000,
    trackingEvent: data.state === "ready" ? buildCheckoutBeginEvent(lines) : null,
    structuredData: [],
    pixelEvents,
  });
}
