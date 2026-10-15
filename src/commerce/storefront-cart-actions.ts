"use server";

import { cookies } from "next/headers";

import { prisma } from "../db/prisma.ts";
import { readPancakeShopId } from "../integrations/pancake/config.ts";
import type { AnonymousCartCookieWrite } from "./anonymous-cart-cookie.ts";
import { createAnonymousCartMutationService } from "./anonymous-cart-mutation.ts";
import { resolveAnonymousCartRequest } from "./anonymous-cart-request.ts";
import { createCartLineAuthorityResolver } from "./cart-line-authority.ts";
import { createStorefrontCartPublicActions } from "./storefront-cart-public-actions.ts";
import { createStorefrontCartRepository } from "./storefront-cart-repository.ts";
import { scheduleMetaAddToCartSafely } from "./meta-request-context.ts";
import { isGiftQuantityPromotionsEnabled } from "./gift-quantity-gate.ts";
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
      return line?.available === true;
    },
    async setQuantity({ variantId, quantity }) {
      return mutations.updateExistingItemQuantity({ variantId, quantity, now, resolveLine });
    },
    async remove({ variantId }) {
      return mutations.removeItem({ variantId, now, resolveLine });
    },
  });

  return { ...actions, getLines };
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
  if (!isGiftQuantityPromotionsEnabled()) {
    return buildCartViewModel({ lines: await getStorefrontCartLines(), commerceTrackingEnabled: false });
  }
  const model = buildCartViewModel({
    ...(await getCurrentStorefrontCartBenefits(new Date())),
    commerceTrackingEnabled: false,
  });
  const view: { -readonly [K in keyof CartViewModel]: CartViewModel[K] } = { ...model };
  delete view.gifts;
  return view;
}

export async function updateStorefrontCartLine(input: unknown) {
  const result = await (await createActionRuntime()).update(input);
  if (result.ok) await scheduleMetaAddToCartSafely(result.metaEvent, "/cart");
  return result;
}

export async function removeStorefrontCartLine(input: unknown) {
  return (await createActionRuntime()).remove(input);
}
