"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";

import { readAuthServerConfig } from "../auth/config.ts";
import { readStorefrontOrigin } from "./storefront-origin.ts";
import { prisma } from "../db/prisma.ts";
import { createAnonymousCartCookieSession } from "./anonymous-cart-cookie.ts";
import {
  deriveGuestCheckoutClientKey,
  readOptionalTrustedClientIp,
} from "./guest-checkout-client-identity.ts";
import { submitGuestCheckoutPublicAction } from "./guest-checkout-public-actions.ts";
import { createGuestCheckoutRateLimiter } from "./guest-checkout-rate-limit.ts";
import type { MetaPurchaseRequestContext } from "./meta-purchase-reporting.ts";
import { reportOpenAiAdsPurchaseSafely } from "./openai-ads-purchase-reporting.ts";
import type { GuestCheckoutSubmitResult } from "./guest-checkout-submit.ts";
import { submitGuestCheckoutByCart } from "./guest-checkout-submit-runtime.ts";

async function createGuestCheckoutActionDependencies(metaContext: MetaPurchaseRequestContext | null) {
  const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()]);
  const authConfig = readAuthServerConfig();
  const clientKey = deriveGuestCheckoutClientKey(requestHeaders, authConfig);
  const cartSession = createAnonymousCartCookieSession({
    get(name: string) {
      return cookieStore.get(name);
    },
    set(cookie) {
      cookieStore.set(cookie);
    },
  });
  const rateLimiter = createGuestCheckoutRateLimiter(prisma);

  return {
    cartSession,
    async consumeAttempt(cartId: string) {
      const now = new Date();
      if (!(await rateLimiter.consumeClient({ clientKey, now }))) {
        return false;
      }
      return rateLimiter.consume({ cartId, now });
    },
    submitCheckout: (input: Parameters<typeof submitGuestCheckoutByCart>[0]) => submitGuestCheckoutByCart({ ...input, metaContext }),
  };
}

/**
 * The browsing context Meta matches a server event against: the buyer's address and user agent,
 * plus the pixel's own `_fbp` / `_fbc` cookies, which are the strongest signal available for a
 * guest who never creates an account.
 */
async function readMeasurementRequestContexts() {
  const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()]);

  const clientIpAddress = readOptionalTrustedClientIp(requestHeaders, readAuthServerConfig());
  const clientUserAgent = requestHeaders.get("user-agent");
  const eventSourceUrl = `${readStorefrontOrigin()}/checkout`;

  return {
    meta: {
      clientIpAddress,
      clientUserAgent,
      fbp: cookieStore.get("_fbp")?.value ?? null,
      fbc: cookieStore.get("_fbc")?.value ?? null,
      eventSourceUrl,
    },
    openAiAds: {
      clientIpAddress,
      clientUserAgent,
      // These are first-party cookies written by the ChatGPT Ads Pixel. The API requires the
      // original opaque oppref value when present; neither value is parsed or transformed here.
      oppref: cookieStore.get("__oppref")?.value ?? null,
      obref: cookieStore.get("__obref")?.value ?? null,
      eventSourceUrl,
    },
  };
}

export async function submitGuestCheckoutAction(
  _previousState: GuestCheckoutSubmitResult | null,
  formData: FormData,
): Promise<GuestCheckoutSubmitResult> {
  let result: GuestCheckoutSubmitResult;
  const measurementContexts = await readMeasurementRequestContexts().catch(() => null);
  try {
    result = await submitGuestCheckoutPublicAction(
      await createGuestCheckoutActionDependencies(measurementContexts?.meta ?? null),
      formData,
    );
  } catch {
    return {
      ok: false,
      status: "RETRYABLE",
      reason: "CHECKOUT_UNAVAILABLE",
    };
  }

  if (result.ok) {
    // The request context has to be read inside the request, but the reporting itself must not sit
    // between the buyer and their confirmation page. `after` keeps the work alive past the
    // response without holding it up, which a bare floating promise would not survive on a
    // serverless runtime that freezes the invocation the moment it responds.
    // The order is already placed here. Nothing about reporting it may throw past this point: the
    // buyer would see a generic failure for a sale that succeeded and would very likely submit it
    // again. readStorefrontOrigin in particular throws on a misconfigured APP_DOMAIN.
    if (measurementContexts !== null) {
      after(() =>
        Promise.all([
          reportOpenAiAdsPurchaseSafely(prisma, result.orderCode, measurementContexts.openAiAds),
        ]).then(() => undefined),
      );
    }
    redirect(`/checkout/success?order=${encodeURIComponent(result.orderCode)}`);
  }
  return result;
}
