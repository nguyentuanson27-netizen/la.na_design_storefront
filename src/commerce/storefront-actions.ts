"use server";

import { cookies } from "next/headers";

import type { AnonymousCartCookieWrite } from "./anonymous-cart-cookie.ts";
import { createAnonymousCartMutationService } from "./anonymous-cart-mutation.ts";
import { createCartLineAuthorityResolver } from "./cart-line-authority.ts";
import { createStorefrontProductDetailRepository } from "./storefront-product-detail.ts";
import { createStorefrontPurchasePublicActions } from "./storefront-purchase-public-actions.ts";
import { createStorefrontPurchaseService } from "./storefront-purchase.ts";
import { prisma } from "../db/prisma.ts";
import { readPancakeShopId } from "../integrations/pancake/config.ts";

const publicActions = createStorefrontPurchasePublicActions({
  async purchase({ slug, variantId, quantity }) {
    const shopId = readPancakeShopId();
    // One instant for the whole request: the projection that authorizes the option and the
    // resolver that re-authorizes it under the cart lock must agree about which campaigns are
    // running, even if a schedule boundary falls between the two reads.
    const now = new Date();
    const cookieStore = await cookies();
    const catalog = createStorefrontProductDetailRepository(prisma);
    const mutations = createAnonymousCartMutationService(prisma, {
      get(name: string) {
        return cookieStore.get(name);
      },
      set(cookie: AnonymousCartCookieWrite) {
        cookieStore.set(cookie);
      },
    });
    const resolveLine = createCartLineAuthorityResolver({ shopId, now });

    const purchase = createStorefrontPurchaseService({
      catalog,
      async addQuantity({ variantId: authorizedVariantId, quantity: addedQuantity }) {
        return mutations.addItemQuantity({
          variantId: authorizedVariantId,
          addedQuantity,
          now,
          resolveLine,
        });
      },
    });

    return purchase.add({ shopId, slug, variantId, quantity, now });
  },
});

export async function addStorefrontItemToBag(input: unknown) {
  return publicActions.add(input);
}
