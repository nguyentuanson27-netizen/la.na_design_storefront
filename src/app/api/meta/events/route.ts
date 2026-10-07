import { after } from "next/server";

import { readAuthServerConfig } from "@/auth/config";
import { deriveGuestCheckoutClientKey } from "@/commerce/guest-checkout-client-identity";
import { consumeMetaBrowserRateLimit } from "@/commerce/meta-browser-rate-limit";
import { prisma } from "@/db/prisma";
import { META_BROWSER_EVENT_ID, readMetaPagePath, verifyMetaBrowserReceipt } from "@/commerce/meta-browser-receipt";
import { reportMetaEventSafely } from "@/commerce/meta-event-reporting";
import { readMetaRequestContext } from "@/commerce/meta-request-context";
import { readStorefrontOrigin } from "@/commerce/storefront-origin";
import { readMetaConversionsConfig } from "@/integrations/meta/pixel-config";

/** Browser occurrence signal. Event names, items and money are never accepted from the caller. */
export async function POST(request: Request): Promise<Response> {
  const empty = () => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  try {
    if (!readMetaConversionsConfig()) return empty();
    if (request.headers.get("origin") !== readStorefrontOrigin()
      || request.headers.get("content-type") !== "application/json"
      || Number(request.headers.get("content-length") ?? 0) > 25_000) return empty();
    const auth = readAuthServerConfig();
    if (!await consumeMetaBrowserRateLimit(prisma, deriveGuestCheckoutClientKey(request.headers, auth))) return empty();
    // Bound actual bytes too: a missing/lying Content-Length does not bypass this boundary.
    const reader = request.body?.getReader();
    if (!reader) return empty();
    let size = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 25_000) { await reader.cancel(); return empty(); }
      chunks.push(value);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof input !== "object" || input === null || Array.isArray(input)) return empty();
    const keys = Object.keys(input).sort().join(",");
    const occurredAt = new Date();
    if (keys === "eventId,path") {
      if (typeof input.eventId !== "string" || !META_BROWSER_EVENT_ID.test(input.eventId)) return empty();
      const path = readMetaPagePath(input.path);
      if (!path) return empty();
      const context = await readMetaRequestContext(path);
      after(() => reportMetaEventSafely({ name: "PageView", eventId: input.eventId, occurredAt, context }));
    } else if (keys === "receipt") {
      const facts = verifyMetaBrowserReceipt(input.receipt, auth.secret, occurredAt);
      if (!facts) return empty();
      const context = await readMetaRequestContext(facts.path);
      after(() => reportMetaEventSafely({ ...facts, occurredAt, context }));
    }
  } catch {
    // An unavailable measurement endpoint must never affect the rendered page or checkout.
    console.warn(JSON.stringify({ name: "meta_conversions.signal_failed", reason: "CONTEXT_OR_SIGNAL_UNAVAILABLE" }));
  }
  return empty();
}
