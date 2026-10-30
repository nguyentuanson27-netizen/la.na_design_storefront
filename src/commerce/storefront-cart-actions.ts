"use server";

import { cookies } from "next/headers";

import { prisma } from "../db/prisma.ts";
import { readPancakeShopId } from "../integrations/pancake/config.ts";
import type { AnonymousCartCookieWrite } from "./anonymous-cart-cookie.ts";
import { createAnonymousCartMutationService } from "./anonymous-cart-mutation.ts";
import { createCartGiftSelectionService } from "./cart-gift-selection.ts";
import { isGiftQuantityPromotionsEnabled } from "./gift-quantity-gate.ts";
import { resolveAnonymousCartRequest } from "./anonymous-cart-request.ts";
import { createCartLineAuthorityResolver } from "./cart-line-authority.ts";
import { createStorefrontCartPublicActions } from "./storefront-cart-public-actions.ts";
import { createStorefrontCartRepository } from "./storefront-cart-repository.ts";
import { scheduleMetaAddToCartSafely } from "./meta-request-context.ts";
import { tryReadGuestShippingPolicy } from "./guest-shipping-policy.ts";
import { getCurrentStorefrontCartBenefits } from "./storefront-cart-runtime.ts";
import { buildCartViewModel, type CartViewModel } from "../routes/cart-model.ts";

async function createActionRuntime() {
  const cookieStore = await cookies();
  // One instant per request, shared by the advisory pre-check, the in-transaction re-resolution
  // and the snapshot, so a campaign boundary cannot fall between them.
  const now = new Date();
  const shopId = readPancakeShopId();
  const repository = createStorefrontCartRepository(prisma);
  const writableCookieStore = {
    get(name: string) {
      return cookieStore.get(name);
    },
    set(cookie: AnonymousCartCookieWrite) {
      cookieStore.set(cookie);
    },
  };
  const mutations = createAnonymousCartMutationService(prisma, writableCookieStore);
  const resolveLine = createCartLineAuthorityResolver({ shopId, now });

  async function getLines() {
    const cart = await resolveAnonymousCartRequest({
      client: prisma,
      store: writableCookieStore,
      now,
    });
    if (!cart || cart.items.length === 0) return [];
    return repository.getLines({ shopId, items: cart.items, now });
  }

  const actions = createStorefrontCartPublicActions({
    getLines,
    async canSetQuantity({ variantId, quantity }) {
      // Advisory only. It gives the shopper a precise message without a write, but the mutation
      // re-resolves the same facts under the cart lock and is the only authority on acceptance.
      const [line] = await repository.getLines({
        shopId,
        items: [{ variantId, quantity }],
        now,
      });
      if (line?.available === true) return true;
      // "Chỉ còn N": the same resolution names the count that would sell, when one would.
      return line?.maxQuantity ? { allowed: false, maxQuantity: line.maxQuantity } : false;
    },
    async setQuantity({ variantId, quantity }) {
      return mutations.updateExistingItemQuantity({ variantId, quantity, now, resolveLine });
    },
    async remove({ variantId }) {
      return mutations.removeItem({ variantId, now, resolveLine });
    },
  });

  async function reconcilePaidReduction(): Promise<number> {
    if (!isGiftQuantityPromotionsEnabled()) return 0;
    // A confirmed PAID mutation is the trigger. Passive reads cannot tell a basket
    // decrease from an Admin/catalog change, and must never silently discard gifts.
    const result = await createCartGiftSelectionService(prisma, writableCookieStore, { shopId })
      .reconcileAfterPaidReduction(now);
    return "autoRemovedGiftCount" in result && typeof result.autoRemovedGiftCount === "number"
      ? result.autoRemovedGiftCount : 0;
  }

  return { ...actions, getLines, reconcilePaidReduction };
}

export async function getStorefrontCartLines() {
  return (await createActionRuntime()).getLines();
}

/**
 * The cart as the drawer and the header badge draw it, benefits included.
 *
 * The drawer used to rebuild its view from bare lines in the browser, so it could never show a
 * promotion and, with quantity tiers on, quoted a subtotal the cart page did not. This builds the
 * same view model the cart page does, on the server, from the same quote. With the gift / quantity
 * gate OFF it is exactly the old lines-only path, so nothing changes until a campaign is live.
 *
 * The gift picker's model is dropped: the drawer has no picker, and it carries campaign and variant
 * ids the drawer has no reason to receive.
 */
export async function getStorefrontCartView(): Promise<CartViewModel> {
  const model = buildCartViewModel({
    ...(await getCurrentStorefrontCartBenefits(new Date())),
    commerceTrackingEnabled: false,
    shippingPolicy: tryReadGuestShippingPolicy(),
  });
  const view: { -readonly [K in keyof CartViewModel]: CartViewModel[K] } = { ...model };
  delete view.gifts;
  return view;
}

export async function updateStorefrontCartLine(input: unknown) {
  const runtime = await createActionRuntime();
  const result = await runtime.update(input);
  if (!result.ok) return result;
  await scheduleMetaAddToCartSafely(result.metaEvent, "/cart");
  if (result.transition && result.transition.quantity < result.transition.previousQuantity) {
    const autoRemovedGiftCount = await runtime.reconcilePaidReduction();
    if (autoRemovedGiftCount > 0) return { ...result, autoRemovedGiftCount };
  }
  return result;
}

export async function removeStorefrontCartLine(input: unknown) {
  const runtime = await createActionRuntime();
  const result = await runtime.remove(input);
  if (result.ok && result.removedQuantity > 0) {
    const autoRemovedGiftCount = await runtime.reconcilePaidReduction();
    if (autoRemovedGiftCount > 0) return { ...result, autoRemovedGiftCount };
  }
  return result;
}
