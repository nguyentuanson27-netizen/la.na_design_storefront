import { createHmac, timingSafeEqual } from "node:crypto";

import type { FacebookPixelEventParameters } from "../components/analytics/facebook-pixel-client.ts";
import { readMetaPagePath } from "../integrations/meta/page-source.ts";
export { readMetaPagePath } from "../integrations/meta/page-source.ts";

export type MetaBrowserReceiptFacts = Readonly<{
  eventId: string;
  name: "ViewContent" | "InitiateCheckout";
  path: string;
  parameters: FacebookPixelEventParameters;
}>;

const MAX_RECEIPT_BYTES = 24_000;
const RECEIPT_LIFETIME_MS = 15 * 60_000;

function signature(body: string, secret: string): Buffer {
  return createHmac("sha256", secret).update("meta-browser-receipt:v2\0").update(body).digest();
}

/** Non-PII rendered facts, signed by the server; this receipt never contains user_data or secrets. */
export function issueMetaBrowserReceipt(facts: MetaBrowserReceiptFacts, secret: string, now: Date): string {
  if (!META_BROWSER_EVENT_ID.test(facts.eventId)) throw new TypeError("Meta receipt needs a server occurrence UUID");
  const body = Buffer.from(JSON.stringify({ ...facts, issuedAt: now.getTime() })).toString("base64url");
  const receipt = `${body}.${signature(body, secret).toString("base64url")}`;
  if (receipt.length > MAX_RECEIPT_BYTES) throw new RangeError("Meta receipt exceeds its size bound");
  return receipt;
}

export function verifyMetaBrowserReceipt(receipt: unknown, secret: string, now: Date): MetaBrowserReceiptFacts | null {
  if (typeof receipt !== "string" || receipt.length > MAX_RECEIPT_BYTES) return null;
  const [body, digest, extra] = receipt.split(".");
  if (!body || !digest || extra !== undefined) return null;
  try {
    const supplied = Buffer.from(digest, "base64url");
    const expected = signature(body, secret);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
    const facts = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof facts.eventId !== "string" || !META_BROWSER_EVENT_ID.test(facts.eventId)
      || (facts.name !== "ViewContent" && facts.name !== "InitiateCheckout")
      || typeof facts.issuedAt !== "number" || facts.issuedAt > now.getTime()
      || now.getTime() - facts.issuedAt > RECEIPT_LIFETIME_MS
      || readMetaPagePath(facts.path) === null
      || typeof facts.parameters !== "object" || facts.parameters === null) return null;
    return { eventId: facts.eventId, name: facts.name, path: facts.path, parameters: facts.parameters };
  } catch {
    return null;
  }
}

export const META_BROWSER_EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
