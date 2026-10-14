"use server";

import { cookies } from "next/headers";
import { refresh } from "next/cache";
import { prisma } from "../db/prisma.ts";
import { readPancakeShopId } from "../integrations/pancake/config.ts";
import { createCartGiftSelectionService } from "./cart-gift-selection.ts";

/** Next Server Action POST/origin protection + existing HttpOnly bearer cookie. No client cart ID. */
export async function setStorefrontCartGift(input: unknown) {
  const result = await createCartGiftSelectionService(prisma, await cookies(), { shopId: readPancakeShopId() }).set(input);
  if (result.ok) refresh();
  return result;
}
