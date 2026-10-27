import { type NextRequest, NextResponse } from "next/server";

import { readStorefrontOrigin } from "@/commerce/storefront-origin";
import {
  VOUCHER_REDIRECT_HEADERS,
  isSafeLandingTarget,
  serializeVoucherIntentCookie,
} from "@/commerce/voucher-marketing-link";
import { canIssueNewVouchers } from "@/commerce/voucher-gate";

/**
 * Voucher v1 (V19): the server half of a marketing link. The proxy sends `?voucher=CODE` landings here; this handler remembers
 * the code in an HttpOnly cookie for the cart page to OFFER (pre-filled in the picker's code box) and redirects to the clean
 * URL. It NEVER saves a voucher choice, whether or not the visitor already has a cart: a GET is a navigation, not a
 * confirmation, and a code can cost the shopper a chosen gift or raise the total (spec 4.1.4 / 7.3, EX-06), which only the
 * picker's own "Áp dụng mã" (verify, rate-count, quote, consent, save in one transaction) may settle. It answers with no body,
 * `Referrer-Policy: no-referrer` and `no-store`, so the code is never in a rendered document, a Referer header or a cache. It never
 * holds quota and never trusts a destination it did not recognise.
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
    response.headers.append("Set-Cookie", serializeVoucherIntentCookie(code, origin));
  } catch {
    // A link never costs the visitor the page; a code that cannot be remembered can still be typed.
  }
  return response;
}
