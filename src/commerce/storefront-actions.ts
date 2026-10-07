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
import { scheduleMetaAddToCartSafely } from "./meta-request-context.ts";

const publicActions = createStorefrontPurchasePublicActions({
  async purchase({ slug, variantId }) {
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
    const resolveLine = createCartLineAuthorityResolver({ shopId, now, pdpSlug: slug });

    const purchase = createStorefrontPurchaseService({
      catalog,
      async addUnit({ variantId: authorizedVariantId }) {
        return mutations.addItemUnit({
          variantId: authorizedVariantId,
          now,
          resolveLine,
        });
      },
    });

    return purchase.add({ shopId, slug, variantId, now });
  },
});

export async function addStorefrontItemToBag(input: unknown) {
  const result = await publicActions.add(input);
  if (result.ok) {
    const slug = result.metaEvent?.parameters.content_ids?.[0];
    if (slug) await scheduleMetaAddToCartSafely(result.metaEvent, `/shop/${slug}`);
  }
  return result;
}
