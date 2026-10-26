import { cookies } from "next/headers";

import { prisma } from "../db/prisma.ts";
import { readPancakeShopId } from "../integrations/pancake/config.ts";
import { buildVoucherPickerModel, type VoucherPickerModel } from "../routes/voucher-picker-model.ts";
import { readAnonymousCartCookie } from "./anonymous-cart-cookie.ts";
import { canGrantHonourableVoucherHolds, canIssueNewVouchers } from "./voucher-gate.ts";
import { VOUCHER_INTENT_COOKIE, readVoucherIntentCookie } from "./voucher-marketing-link.ts";
import { readCartOwnVoucherHolds } from "./voucher-own-holds.ts";
import { readVoucherPreview } from "./voucher-preview.ts";

/**
 * The shopper's current voucher picker, or null when there is nothing to show: the feature is OFF, there is no cart,
 * the preview cannot be derived, or there is no voucher to offer. Null means "render the plain cart" -- a voucher
 * failure must never break the page or invent a discount (spec §6: unavailable is not the same as no voucher, so the
 * cart simply keeps its own, voucher-free totals). Read-only: no hold, no selection write.
 */
export async function loadCurrentVoucherPicker(now: Date = new Date()): Promise<VoucherPickerModel | null> {
  // A NEW offer is only made where checkout could hold and honour it (voucher gates, POS-verified shop, gift/quantity gate,
  // line-level pricing). Otherwise the cart says nothing about vouchers rather than promise a saving checkout will not give.
  try {
    if (!canGrantHonourableVoucherHolds(readPancakeShopId())) return null;
    const cartId = readAnonymousCartCookie(await cookies());
    if (cartId === null) return null;
    const preview = await readVoucherPreview({ client: prisma, cartId, shopId: readPancakeShopId(), now, ownHolds: await readCartOwnVoucherHolds(prisma, cartId) });
    // An empty list still renders the picker: a private code can only be entered, never listed.
    if (!preview.enabled || !preview.ok) return null;
    return buildVoucherPickerModel({ quote: preview.quote, entries: preview.entries, intent: preview.selectionIntent, quoteDigest: preview.quoteDigest, selectionVersion: preview.savedSelectionVersion });
  } catch {
    return null;
  }
}

/**
 * Whether a visitor arrived through a marketing link with a code waiting for them (V19). ONLY the fact crosses to the page: the
 * code stays on the server (the HttpOnly cookie), because anything handed to a Client Component is serialized into the page's HTML
 * and RSC payload, where scripts on the page (GTM, Meta) can read it. It is applied by a Server Action that reads the cookie itself.
 */
export async function hasPendingVoucherCode(): Promise<boolean> {
  if (!canIssueNewVouchers()) return false;
  try {
    return readVoucherIntentCookie((await cookies()).get(VOUCHER_INTENT_COOKIE)?.value) !== null;
  } catch {
    return false;
  }
}
