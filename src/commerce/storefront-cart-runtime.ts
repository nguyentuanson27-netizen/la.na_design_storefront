import { prisma } from "../db/prisma.ts";
import { readPancakeShopId } from "../integrations/pancake/config.ts";
import { getCurrentAnonymousCart } from "./anonymous-cart-next.ts";
import { createStorefrontCartRepository } from "./storefront-cart-repository.ts";
import { cookies } from "next/headers";
import { createCartGiftSelectionService } from "./cart-gift-selection.ts";
import { isGiftQuantityPromotionsEnabled } from "./gift-quantity-gate.ts";
import { readLineLevelPricingVerifiedShopIds } from "./pancake-line-level-contract.ts";

/**
 * The buyer's cart with its gift / quantity-tier state.
 *
 * `benefitCheckoutOpen` (GQ19) says whether checkout may be offered for a benefit cart: the POS shop
 * has line-level pricing evidence (GQ20), the same condition under which the submit would send such an
 * order at all. Offering the link while the submit is certain to close the order would cost the buyer
 * a form and an order number for nothing.
 */
export async function getCurrentStorefrontCartBenefits(now = new Date()) {
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
  });
  return { cartId: cart.id, lines };
}
