/** The read-only checkout Upsell endpoint accepts only a bounded, signed render proof. */
import { MAX_BENEFIT_QUOTE_PROOF_BYTES } from "./checkout-quote-proof.ts";

export const MAX_UPSELL_REQUEST_BYTES = 64 * 1024;

export function isSameOriginUpsellRequest(request: Request, trustedOrigin: string): boolean {
  if (request.method !== "POST") return false;
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (!origin || (fetchSite !== null && fetchSite !== "same-origin")) return false;
  try {
    return new URL(origin).origin === new URL(trustedOrigin).origin;
  } catch {
    return false;
  }
}

/** Stream with a hard byte cap: Content-Length is not guaranteed (e.g. chunked HTTP). */
export async function readCheckoutUpsellProof(request: Request): Promise<string | null> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return null;
  const claimedLength = request.headers.get("content-length");
  if (claimedLength !== null && (!/^\d+$/.test(claimedLength) || Number(claimedLength) > MAX_UPSELL_REQUEST_BYTES)) return null;

  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_UPSELL_REQUEST_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const input: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const record = input as Record<string, unknown>;
    if (Object.keys(record).length !== 1 || typeof record.quoteProof !== "string" ||
      record.quoteProof.length === 0 || record.quoteProof.length > MAX_BENEFIT_QUOTE_PROOF_BYTES ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(record.quoteProof)) return null;
    return record.quoteProof;
  } catch {
    return null;
  }
}
