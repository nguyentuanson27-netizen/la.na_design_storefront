import { cookies, headers } from "next/headers.js";
import { after } from "next/server.js";

import { readAuthServerConfig } from "../auth/config.ts";
import { readOptionalTrustedClientIp } from "./guest-checkout-client-identity.ts";
import { readStorefrontOrigin } from "./storefront-origin.ts";
import { reportMetaEventSafely, type CommittedMetaEvent } from "./meta-event-reporting.ts";
import { reportMetaPurchaseSafely, type MetaPurchaseRequestContext } from "./meta-purchase-reporting.ts";
import { readMetaConversionsConfig, type MetaConversionsConfig } from "../integrations/meta/pixel-config.ts";
import { validateMetaCookie } from "../integrations/meta/conversions-api.ts";
import { readMetaPagePath } from "./meta-browser-receipt.ts";
import type { PrismaClient } from "../generated/prisma/client.ts";

export async function readMetaRequestContext(path: string): Promise<MetaPurchaseRequestContext> {
  const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()]);
  let fbc = validateMetaCookie(cookieStore.get("_fbc")?.value ?? null, "fbc");
  let sourcePath = path;
  // A real fbclid on this browser request may precede Pixel cookie creation. Never synthesize
  // a click ID for organic traffic. The full referer/query is never stored or sent to Meta.
  try {
    const referer = new URL(requestHeaders.get("referer") ?? "");
    const clickId = referer.origin === readStorefrontOrigin() ? referer.searchParams.get("fbclid") : null;
    if (referer.origin === readStorefrontOrigin()) sourcePath = readMetaPagePath(referer.pathname) ?? path;
    if (clickId && /^[A-Za-z0-9_-]{1,400}$/.test(clickId) && !fbc) {
      fbc = `fb.1.${Date.now()}.${clickId}`;
    }
  } catch { /* No matching context available. */ }
  return {
    clientIpAddress: readOptionalTrustedClientIp(requestHeaders, readAuthServerConfig()),
    clientUserAgent: requestHeaders.get("user-agent"),
    fbp: cookieStore.get("_fbp")?.value ?? null,
    fbc,
    eventSourceUrl: `${readStorefrontOrigin()}${sourcePath}`,
  };
}

/** Read context after commit, then deliver after the response. Delivery cannot reject the mutation. */
export async function scheduleMetaAddToCartSafely(event: CommittedMetaEvent | undefined, path: string): Promise<void> {
  if (!event) return;
  const occurredAt = new Date();
  try {
    if (!readMetaConversionsConfig()) return;
    const context = await readMetaRequestContext(path);
    after(() => reportMetaEventSafely({ name: "AddToCart", ...event, occurredAt, context }));
  } catch {
    console.warn(JSON.stringify({ name: "meta_conversions.delivery", event: "AddToCart", ok: false, reason: "CONTEXT_UNAVAILABLE" }));
  }
}

/** Request handlers defer delivery; a CLI reconciliation has no request lifecycle to defer to. */
export async function scheduleMetaPurchaseSafely(client: Pick<PrismaClient, "orderMirror">, code: string): Promise<void> {
  let config: MetaConversionsConfig | null;
  try { config = readMetaConversionsConfig(); }
  catch {
    console.warn(JSON.stringify({ name: "meta_conversions.purchase_failed", reason: "CONFIG_UNAVAILABLE" }));
    return;
  }
  if (!config) return;
  try { after(() => reportMetaPurchaseSafely(client, code)); }
  catch { await reportMetaPurchaseSafely(client, code); }
}
