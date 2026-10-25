import { type NextRequest, NextResponse } from "next/server";

import { readAnonymousCartCookie } from "@/commerce/anonymous-cart-cookie";
import { readStorefrontOrigin } from "@/commerce/storefront-origin";
import {
  VOUCHER_REDIRECT_HEADERS,
  isSafeLandingTarget,
  serializeVoucherIntentCookie,
} from "@/commerce/voucher-marketing-link";
import { canIssueNewVouchers } from "@/commerce/voucher-gate";
import { createVoucherSelectionService } from "@/commerce/voucher-selection-service";
import { prisma } from "@/db/prisma";
import { readPancakeShopId } from "@/integrations/pancake/config";

/**
 * Voucher v1 (V19): the server half of a marketing link. The proxy sends `?voucher=CODE` landings here; this handler
 * validates the code through the same throttled path as the typed one (V15), stores the manual choice against the
 * cart, or - for a visitor with no cart yet - remembers the code in an HttpOnly cookie for the cart page to offer, and
 * then redirects to the clean URL. It answers with no body, `Referrer-Policy: no-referrer` and `no-store`, so the code
 * is never in a rendered document, a Referer header or a cache. It never holds quota and never trusts a destination
 * it did not recognise.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const target = request.nextUrl.searchParams.get("to");
  const code = request.nextUrl.searchParams.get("code");
  const origin = readStorefrontOrigin();
  // An unrecognised destination goes home rather than anywhere the link chose.
  const destination = new URL(isSafeLandingTarget(target) ? target : "/", origin);
  const response = NextResponse.redirect(destination, 303);
  for (const [name, value] of Object.entries(VOUCHER_REDIRECT_HEADERS)) response.headers.set(name, value);

  if (code === null || !canIssueNewVouchers()) return response;
  try {
    const cartId = readAnonymousCartCookie(request.cookies);
    if (cartId === null) {
      response.headers.append("Set-Cookie", serializeVoucherIntentCookie(code, origin));
      return response;
    }
    await createVoucherSelectionService(prisma, { shopId: readPancakeShopId() }).applyCode({ cartId, rawCode: code });
  } catch {
    // A link never costs the visitor the page; the code can still be typed.
  }
  return response;
}
