"use server";

import { cookies } from "next/headers";
import { refresh } from "next/cache";
import { prisma } from "../db/prisma.ts";
import { readPancakeShopId } from "../integrations/pancake/config.ts";
import { buildCartGiftPickerModel } from "../routes/cart-gift-model.ts";
import { createCartGiftSelectionService } from "./cart-gift-selection.ts";

/** Next Server Action POST/origin protection + existing HttpOnly bearer cookie. No client cart ID. */
export async function setStorefrontCartGift(input: unknown) {
  const result = await createCartGiftSelectionService(prisma, await cookies(), { shopId: readPancakeShopId() }).set(input);
  if (result.ok) refresh();
  return result;
}

/** Resolve an ambiguous write by reading the cookie-owned cart; never repeat the write. */
export async function readStorefrontCartGifts() {
  const result = await createCartGiftSelectionService(prisma, await cookies(), { shopId: readPancakeShopId() }).get();
  if (!("ok" in result) || !result.ok) return { ok: false } as const;
  const model = buildCartGiftPickerModel(result.state);
  refresh();
  return { ok: true, model } as const;
}
