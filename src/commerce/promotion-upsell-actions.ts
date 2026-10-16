"use server";

import { cookies } from "next/headers";
import { refresh } from "next/cache";
import { readAuthServerConfig } from "../auth/config.ts";
import { prisma } from "../db/prisma.ts";
import { readPancakeShopId } from "../integrations/pancake/config.ts";
import { createPromotionUpsellService } from "./promotion-upsell.ts";

/** Next's POST/origin boundary plus the HttpOnly cart session; input is parsed again by the service. */
export async function addCheckoutUpsell(input: unknown) {
  const result = await createPromotionUpsellService(prisma, await cookies(), {
    shopId: readPancakeShopId(), secret: readAuthServerConfig().secret,
  }).add(input);
  // The response installs the current quote/proof/summary without remounting the checkout form.
  refresh();
  return result;
}

/** Read-only verification for the selected size; it cannot add a cart line or create a COD proof. */
export async function requoteCheckoutUpsell(input: unknown) {
  const result = await createPromotionUpsellService(prisma, await cookies(), {
    shopId: readPancakeShopId(), secret: readAuthServerConfig().secret,
  }).requote(input);
  if (!result.ok) refresh();
  return result;
}
