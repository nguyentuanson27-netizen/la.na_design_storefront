import { prisma } from "../db/prisma.ts";
import { readPancakeShopId } from "../integrations/pancake/config.ts";
import { getCurrentAnonymousCart } from "./anonymous-cart-next.ts";
import { createStorefrontCartRepository } from "./storefront-cart-repository.ts";
import { cookies } from "next/headers";
import { createCartGiftSelectionService } from "./cart-gift-selection.ts";
import { isGiftQuantityPromotionsEnabled } from "./gift-quantity-gate.ts";
import { readShippingQuote } from "./shipping-campaign-repository.ts";
import { readGuestShippingPolicy } from "./guest-shipping-policy.ts";
import { readLineLevelPricingVerifiedShopIds } from "./pancake-line-level-contract.ts";

/**
 * The buyer's cart with its gift / quantity-tier state.
 *
 * `benefitCheckoutOpen` (GQ19) says whether checkout may be offered for a benefit cart: the POS shop
 * has line-level pricing evidence (GQ20), the same condition under which the submit would send such an
 * order at all. Offering the link while the submit is certain to close the order would cost the buyer
 * a form and an order number for nothing.
 */
async function readCartMerchandiseBenefits(now: Date) {
  if (!isGiftQuantityPromotionsEnabled()) return { lines: await getCurrentStorefrontCartLines(now) };
  const result = await createCartGiftSelectionService(prisma, await cookies(), { shopId: readPancakeShopId() }).get(now);
  if ("state" in result) {
    return {
      lines: result.state.quote.lines,
      giftState: result.state,
      benefitCheckoutOpen: readLineLevelPricingVerifiedShopIds().includes(readPancakeShopId()),
    };
  }
  return { lines: await getCurrentStorefrontCartLines(now), benefitsUnavailable: "ok" in result && result.reason !== "CART_UNAVAILABLE" };
}

/**
 * The cart the drawer and the cart page render: lines, benefits, shipping, and each line's Flash Sale
 * countdown and "Còn x". The urgency read is presentation only, so a failure drops it and nothing else.
 */
export async function getCurrentStorefrontCartBenefits(now = new Date()) {
  const cart = await readCartBenefitsWithShipping(now);
  if (cart.lines.length === 0) return cart;
  try {
    const lineUrgency = await createStorefrontCartRepository(prisma).getLineUrgency({
      shopId: readPancakeShopId(),
      items: cart.lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
      now,
    });
    return { ...cart, lineUrgency };
  } catch {
    return cart;
  }
}

/** Shipping is read for every non-empty cart, including when gift/quantity promotions are disabled. */
async function readCartBenefitsWithShipping(now: Date) {
  const cart = await readCartMerchandiseBenefits(now);
  if (cart.lines.length === 0 || ("benefitsUnavailable" in cart && cart.benefitsUnavailable)) return cart;
  const state = "giftState" in cart ? cart.giftState : undefined;
  try {
    const shippingQuote = await prisma.$transaction((tx) => readShippingQuote({
      client: tx, shopId: readPancakeShopId(), now, policy: readGuestShippingPolicy(),
      paidItems: cart.lines.filter((line) => line.available),
      hasOtherPromotions: Boolean(state?.selections.length) ||
        Boolean(state?.quote.benefits.enabled && state.quote.benefits.ok && state.quote.benefits.groups.some((group) => group.steps.some((step) => step.outputPriceVnd < step.inputPriceVnd))) ||
        cart.lines.some((line) => line.price !== null && line.basePrice !== undefined && line.price < line.basePrice),
    }));
    return { ...cart, shippingQuote };
  } catch {
    // Unknown shipping is not "no campaign": hide totals and close checkout instead of guessing a fee.
    return { ...cart, benefitsUnavailable: true };
  }
}

export async function getCurrentStorefrontCartLines(now: Date = new Date()) {
  return (await getCurrentStorefrontCheckoutContext(now))?.lines ?? [];
}

/**
 * The cart lines plus the server-read cart identity behind them.
 *
 * Checkout needs both and must read them together: the rendered-quote proof is bound to the cart
 * whose lines produced the quote, so resolving the identity in a second request would open a window
 * where the two disagree. The raw id is server-only — it goes into the proof's MAC context and
 * never into anything the browser receives.
 */
export async function getCurrentStorefrontCheckoutContext(now: Date = new Date()) {
  const cart = await getCurrentAnonymousCart(now);
  if (!cart || cart.items.length === 0) return null;

  const lines = await createStorefrontCartRepository(prisma).getLines({
    shopId: readPancakeShopId(),
    items: cart.items,
    now,
  });
  return { cartId: cart.id, lines };
}
