import { cookies } from "next/headers";

import { prisma } from "../db/prisma.ts";
import { readPancakeShopId } from "../integrations/pancake/config.ts";
import { buildVoucherPickerModel, type VoucherPickerModel } from "../routes/voucher-picker-model.ts";
import { readAnonymousCartCookie } from "./anonymous-cart-cookie.ts";
import { canIssueNewVouchers } from "./voucher-gate.ts";
import { VOUCHER_INTENT_COOKIE, readVoucherIntentCookie } from "./voucher-marketing-link.ts";
import { readVoucherPreview } from "./voucher-preview.ts";

/**
 * The shopper's current voucher picker, or null when there is nothing to show: the feature is OFF, there is no cart,
 * the preview cannot be derived, or there is no voucher to offer. Null means "render the plain cart" -- a voucher
 * failure must never break the page or invent a discount (spec §6: unavailable is not the same as no voucher, so the
 * cart simply keeps its own, voucher-free totals). Read-only: no hold, no selection write.
 */
export async function loadCurrentVoucherPicker(now: Date = new Date()): Promise<VoucherPickerModel | null> {
  if (!canIssueNewVouchers()) return null;
  try {
    const cartId = readAnonymousCartCookie(await cookies());
    if (cartId === null) return null;
    const preview = await readVoucherPreview({ client: prisma, cartId, shopId: readPancakeShopId(), now });
    // An empty list still renders the picker: a private code can only be entered, never listed.
    if (!preview.enabled || !preview.ok) return null;
    return buildVoucherPickerModel({ quote: preview.quote, entries: preview.entries, intent: preview.selectionIntent });
  } catch {
    return null;
  }
}

/**
 * A code a visitor arrived with through a marketing link before they had a cart (V19). It is only OFFERED -- pre-filled
 * in the code field for the shopper to confirm - because applying it would be a write on a page render.
 */
export async function readPendingVoucherCode(): Promise<string | null> {
  if (!canIssueNewVouchers()) return null;
  try {
    return readVoucherIntentCookie((await cookies()).get(VOUCHER_INTENT_COOKIE)?.value);
  } catch {
    return null;
  }
}
