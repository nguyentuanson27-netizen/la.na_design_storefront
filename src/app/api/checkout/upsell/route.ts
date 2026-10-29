import { cookies } from "next/headers";
import { readAuthServerConfig } from "@/auth/config";
import { deriveGuestCheckoutClientKey } from "@/commerce/guest-checkout-client-identity";
import { createGuestCheckoutRateLimiter } from "@/commerce/guest-checkout-rate-limit";
import { isSameOriginUpsellRequest, readCheckoutUpsellProof } from "@/commerce/checkout-upsell-http";
import { createPromotionUpsellService } from "@/commerce/promotion-upsell";
import { isPromotionUpsellEnabled } from "@/commerce/promotion-upsell-policy";
import { prisma } from "@/db/prisma";
import { readPancakeShopId } from "@/integrations/pancake/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Best-effort, process-local overload protection. The trusted-client DB limiter also caps
// repeated calls across app instances; neither lock nor request queue can delay COD checkout.
const MAX_CONCURRENT_UPSELL_READS = 2;
let activeReads = 0;
const responseHeaders = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } as const;
const empty = (status = 200) => Response.json(null, { status, headers: responseHeaders });

/** The optional banner is never a pricing/submit authority and never blocks checkout HTML. */
export async function POST(request: Request) {
  // Compare to trusted server config, not Request.url/Host (which may differ behind a proxy).
  let auth: ReturnType<typeof readAuthServerConfig>;
  try {
    auth = readAuthServerConfig();
  } catch {
    return empty();
  }
  if (!isSameOriginUpsellRequest(request, auth.baseURL)) return empty(403);
  let quoteProof: string | null = null;
  try {
    quoteProof = await readCheckoutUpsellProof(request);
  } catch {
    return empty(400);
  }
  if (!quoteProof) return empty(400);

  let shopId: number;
  try {
    shopId = readPancakeShopId();
    if (!isPromotionUpsellEnabled(shopId)) return empty();
  } catch {
    return empty();
  }
  if (activeReads >= MAX_CONCURRENT_UPSELL_READS) return empty();
  activeReads++;
  try {
    const clientKey = deriveGuestCheckoutClientKey(request.headers, auth);
    const limiter = createGuestCheckoutRateLimiter(prisma);
    if (!(await limiter.consumeUpsellClient({ clientKey }))) return empty(429);

    const model = await createPromotionUpsellService(prisma, await cookies(), {
      shopId, secret: auth.secret,
    }).getBanner(quoteProof);
    // Never return a cart id, item/variant ids, customer facts, prices or replayable signed intents.
    return Response.json(model, { headers: responseHeaders });
  } catch {
    // Optional reads fail closed without changing the quote, gift state or submit flow.
    return empty();
  } finally {
    activeReads--;
  }
}
